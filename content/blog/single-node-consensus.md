---
title: "Single Node Consensus: Building a Complete Implementation"
date: 2026-02-08
draft: false
description: "Building a production-ready single-node consensus layer with retry logic, health checks, graceful shutdown, and metrics."
tags: ["consensus", "geth", "mev", "tutorial"]
---

*Part 2 of the Custom Geth Consensus Series* <!-- markdownlint-disable-line MD036 -->

[Part 1](/blog/custom-geth-consensus) left us with raw Engine API calls that build and finalize a single block. This part wraps those calls into a production-ready application with retry logic, health checks, and graceful shutdown. Full source code is on [GitHub](https://github.com/mikelle/geth-consensus-tutorial/tree/main/02-single-node).

## What We're Building

A single-node consensus layer that:

- Produces blocks continuously
- Handles transient failures with exponential backoff
- Exposes health checks for orchestration
- Supports graceful shutdown
- Provides Prometheus metrics

## Application Structure

The application has four main components:

```text
┌──────────────────────────────────────────────────────┐
│                   SingleNodeApp                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ BlockBuilder │ │ StateManager │ │ HealthServer │  │
│  └──────┬───────┘ └──────┬───────┘ └──────────────┘  │
│         │                │                           │
│  ┌──────▼────────────────▼──────────────────────┐    │
│  │              Run Loop                         │   │
│  │  GetPayload --> Read State --> FinalizeBlock  │   │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

## Configuration

Define all configurable parameters:

```go
type Config struct {
    InstanceID               string        // Unique node identifier
    EthClientURL             string        // Engine API endpoint (e.g., http://localhost:8551)
    JWTSecret                string        // Hex-encoded 32-byte secret
    PriorityFeeRecipient     string        // Address receiving priority fees
    EVMBuildDelay            time.Duration // Wait after ForkchoiceUpdated
    EVMBuildDelayEmptyBlocks time.Duration // Min time between empty blocks
    TxPoolPollingInterval    time.Duration // Poll interval when mempool empty
    HealthAddr               string        // Health endpoint address
}
```

Sensible defaults:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `EVMBuildDelay` | 1ms | Time for Geth to include transactions |
| `EVMBuildDelayEmptyBlocks` | 1min | Avoid spamming empty blocks |
| `TxPoolPollingInterval` | 5ms | Check for new transactions |

## State Manager

Between building and finalizing a block, we need to persist the payload. Why not just pass the struct directly? Because in [Part 3](/blog/redis-distributed-consensus), this state moves to Redis, so we serialize it now to keep the interface consistent. The payload and [EIP-7685](https://eips.ethereum.org/EIPS/eip-7685) requests are encoded as msgpack + base64 strings.

```go
package state

type BuildStep int

const (
    StepBuildBlock BuildStep = iota
    StepFinalizeBlock
)

type BlockBuildState struct {
    CurrentStep      BuildStep
    PayloadID        string
    ExecutionPayload string // Base64-encoded msgpack
    Requests         string // Base64-encoded msgpack (EIP-7685)
}

type StateManager interface {
    SaveBlockState(ctx context.Context, state *BlockBuildState) error
    GetBlockBuildState(ctx context.Context) BlockBuildState
    ResetBlockState(ctx context.Context) error
}
```

The `StateManager` interface is designed to be swappable. For single-node, `LocalStateManager` is a trivial in-memory implementation — see the [full source](https://github.com/mikelle/geth-consensus-tutorial/blob/main/02-single-node/pkg/state/state.go). [Part 3](/blog/redis-distributed-consensus) will replace it with Redis-backed state.

## Retry Logic with Exponential Backoff

Network issues and Geth restarts are common. Every Engine API call is wrapped in exponential backoff using [`cenkalti/backoff`](https://github.com/cenkalti/backoff). Return `backoff.Permanent(err)` for errors that shouldn't be retried (like `INVALID` payload status):

```go
func retryWithBackoff(ctx context.Context, maxAttempts uint64, logger *slog.Logger, operation func() error) error {
    eb := backoff.NewExponentialBackOff()
    eb.InitialInterval = 200 * time.Millisecond
    eb.MaxInterval = 30 * time.Second

    b := backoff.WithMaxRetries(eb, maxAttempts)

    return backoff.Retry(func() error {
        select {
        case <-ctx.Done():
            return backoff.Permanent(ctx.Err())
        default:
            if err := operation(); err != nil {
                logger.Warn("Operation failed, retrying", "error", err)
                return err
            }
            return nil
        }
    }, backoff.WithContext(b, ctx))
}
```

You'll see this used throughout the block builder below.

## Block Builder

The block builder orchestrates the two-phase process from [Part 1](/blog/custom-geth-consensus), with retry logic around every Engine API call.

```go
type BlockBuilder struct {
    stateManager          state.StateManager
    engineCl              EngineClient
    logger                *slog.Logger
    buildDelay            time.Duration
    buildEmptyBlocksDelay time.Duration
    feeRecipient          common.Address
    executionHead         *state.ExecutionHead
}

var ErrEmptyBlock = errors.New("empty block skipped")
```

### Phase 1: Building a Block

`GetPayload` triggers block assembly and saves the result to state. On startup (or restart), it queries Geth for the current chain head via `SetExecutionHeadFromRPC` so it knows where to build from.

When there are no pending transactions, Geth returns an empty block. Rather than finalizing it, we return `ErrEmptyBlock` and wait for `buildEmptyBlocksDelay` before trying again — this avoids spamming the chain with empty blocks.

```go
func (bb *BlockBuilder) GetPayload(ctx context.Context) error {
    // On first call or after restart, query Geth for current head
    if bb.executionHead == nil {
        if err := bb.SetExecutionHeadFromRPC(ctx); err != nil {
            return fmt.Errorf("set execution head: %w", err)
        }
    }

    ts := uint64(time.Now().Unix())
    if ts <= bb.executionHead.BlockTime {
        ts = bb.executionHead.BlockTime + 1
    }

    // Start block building with retry
    var payloadID *engine.PayloadID
    err := retryWithBackoff(ctx, maxAttempts, bb.logger, func() error {
        headHash := common.BytesToHash(bb.executionHead.BlockHash)

        fcs := engine.ForkchoiceStateV1{
            HeadBlockHash:      headHash,
            SafeBlockHash:      headHash,
            FinalizedBlockHash: headHash,
        }

        attrs := &engine.PayloadAttributes{
            Timestamp:             ts,
            Random:                headHash,
            SuggestedFeeRecipient: bb.feeRecipient,
            Withdrawals:           []*types.Withdrawal{},
            BeaconRoot:            &headHash,
        }

        response, err := bb.engineCl.ForkchoiceUpdatedV3(ctx, fcs, attrs)
        if err != nil {
            return err // Transient — will retry
        }
        if response.PayloadStatus.Status != engine.VALID {
            return backoff.Permanent(fmt.Errorf("invalid status: %s",
                response.PayloadStatus.Status))
        }
        payloadID = response.PayloadID
        return nil
    })
    if err != nil {
        return err
    }

    time.Sleep(bb.buildDelay)

    // Retrieve the built payload
    var payloadResp *engine.ExecutionPayloadEnvelope
    err = retryWithBackoff(ctx, maxAttempts, bb.logger, func() error {
        var err error
        payloadResp, err = bb.engineCl.GetPayloadV5(ctx, *payloadID)
        return err
    })
    if err != nil {
        return err
    }

    // Don't finalize empty blocks
    if len(payloadResp.ExecutionPayload.Transactions) == 0 {
        time.Sleep(bb.buildEmptyBlocksDelay)
        return ErrEmptyBlock
    }

    // Serialize and save state for Phase 2
    payloadData, _ := msgpack.Marshal(payloadResp.ExecutionPayload)
    requestsData, _ := msgpack.Marshal(payloadResp.Requests)

    return bb.stateManager.SaveBlockState(ctx, &state.BlockBuildState{
        CurrentStep:      state.StepFinalizeBlock,
        PayloadID:        payloadID.String(),
        ExecutionPayload: base64.StdEncoding.EncodeToString(payloadData),
        Requests:         base64.StdEncoding.EncodeToString(requestsData),
    })
}
```

### Phase 2: Finalizing a Block

`FinalizeBlock` deserializes the payload from state, validates it, submits it to Geth via `NewPayloadV4`, then updates the fork choice to make it canonical.

```go
func (bb *BlockBuilder) FinalizeBlock(
    ctx context.Context,
    payloadIDStr, executionPayloadStr, requestsStr string,
) error {
    payloadBytes, _ := base64.StdEncoding.DecodeString(executionPayloadStr)
    var payload engine.ExecutableData
    msgpack.Unmarshal(payloadBytes, &payload)

    var requests [][]byte
    if requestsStr != "" {
        requestsBytes, _ := base64.StdEncoding.DecodeString(requestsStr)
        msgpack.Unmarshal(requestsBytes, &requests)
    }

    if err := bb.validatePayload(payload); err != nil {
        return err
    }

    // Submit block to Geth
    parentHash := common.BytesToHash(bb.executionHead.BlockHash)
    err := retryWithBackoff(ctx, maxAttempts, bb.logger, func() error {
        status, err := bb.engineCl.NewPayloadV4(ctx, payload,
            []common.Hash{}, &parentHash, requests)
        if err != nil {
            return err
        }
        if status.Status == engine.INVALID {
            msg := "unknown"
            if status.ValidationError != nil {
                msg = *status.ValidationError
            }
            return backoff.Permanent(fmt.Errorf("invalid: %s", msg))
        }
        return nil
    })
    if err != nil {
        return err
    }

    // Set as canonical head
    fcs := engine.ForkchoiceStateV1{
        HeadBlockHash:      payload.BlockHash,
        SafeBlockHash:      payload.BlockHash,
        FinalizedBlockHash: payload.BlockHash,
    }

    err = retryWithBackoff(ctx, maxAttempts, bb.logger, func() error {
        _, err := bb.engineCl.ForkchoiceUpdatedV3(ctx, fcs, nil)
        return err
    })
    if err != nil {
        return err
    }

    bb.executionHead = &state.ExecutionHead{
        BlockHeight: payload.Number,
        BlockHash:   payload.BlockHash[:],
        BlockTime:   payload.Timestamp,
    }

    return nil
}
```

## The Main Application

Wire everything together:

```go
type SingleNodeApp struct {
    logger           *slog.Logger
    cfg              Config
    blockBuilder     *BlockBuilder
    stateManager     *state.LocalStateManager
    appCtx           context.Context
    cancel           context.CancelFunc
    wg               sync.WaitGroup
    connectionRefused bool
    runLoopStopped   chan struct{}
}

func NewSingleNodeApp(
    parentCtx context.Context,
    cfg Config,
    logger *slog.Logger,
) (*SingleNodeApp, error) {
    ctx, cancel := context.WithCancel(parentCtx)

    // Decode JWT
    jwtBytes, err := hex.DecodeString(cfg.JWTSecret)
    if err != nil {
        cancel()
        return nil, err
    }

    // Create Engine API client
    engineCl, err := ethclient.NewEngineClient(ctx, cfg.EthClientURL, jwtBytes)
    if err != nil {
        cancel()
        return nil, err
    }

    stateMgr := state.NewLocalStateManager()
    bb := blockbuilder.NewBlockBuilder(stateMgr, engineCl, logger,
        cfg.EVMBuildDelay, cfg.EVMBuildDelayEmptyBlocks,
        cfg.PriorityFeeRecipient)

    return &SingleNodeApp{
        logger:         logger,
        cfg:            cfg,
        blockBuilder:   bb,
        stateManager:   stateMgr,
        appCtx:         ctx,
        cancel:         cancel,
        runLoopStopped: make(chan struct{}),
    }, nil
}
```

## Health Checks

Essential for Kubernetes/orchestration:

```go
func (app *SingleNodeApp) healthHandler(w http.ResponseWriter, r *http.Request) {
    // Check if context cancelled
    if err := app.appCtx.Err(); err != nil {
        http.Error(w, "unavailable", http.StatusServiceUnavailable)
        return
    }

    // Check if Geth is reachable
    if app.connectionRefused {
        http.Error(w, "ethereum unavailable", http.StatusServiceUnavailable)
        return
    }

    // Check if run loop is alive
    select {
    case <-app.runLoopStopped:
        http.Error(w, "run loop stopped", http.StatusServiceUnavailable)
        return
    default:
    }

    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}
```

Track connection status:

```go
func (app *SingleNodeApp) setConnectionStatus(err error) {
    if err == nil {
        app.connectionRefused = false
        return
    }
    if strings.Contains(err.Error(), "connection refused") {
        app.connectionRefused = true
        app.logger.Warn("Geth connection refused")
    }
}
```

## The Run Loop

The heart of block production:

```go
func (app *SingleNodeApp) Start() {
    // Launch health server
    app.wg.Add(1)
    go func() {
        defer app.wg.Done()
        mux := http.NewServeMux()
        mux.HandleFunc("/health", app.healthHandler)
        mux.Handle("/metrics", promhttp.Handler())

        server := &http.Server{Addr: app.cfg.HealthAddr, Handler: mux}

        go func() {
            <-app.appCtx.Done()
            ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            defer cancel()
            server.Shutdown(ctx)
        }()

        server.ListenAndServe()
    }()

    // Start block production
    app.wg.Add(1)
    go func() {
        defer app.wg.Done()
        defer close(app.runLoopStopped)
        app.runLoop()
    }()
}

func (app *SingleNodeApp) runLoop() {
    app.stateManager.ResetBlockState(app.appCtx)

    for {
        select {
        case <-app.appCtx.Done():
            return
        default:
            err := app.produceBlock()
            app.setConnectionStatus(err)

            if errors.Is(err, ErrEmptyBlock) {
                time.Sleep(app.cfg.TxPoolPollingInterval)
                continue
            }
            if err != nil {
                app.logger.Error("block production failed", "error", err)
            }

            app.stateManager.ResetBlockState(app.appCtx)
        }
    }
}

func (app *SingleNodeApp) produceBlock() error {
    // Phase 1: Build
    if err := app.blockBuilder.GetPayload(app.appCtx); err != nil {
        return err
    }

    // Get state after build
    state := app.stateManager.GetBlockBuildState(app.appCtx)

    // Phase 2: Finalize
    return app.blockBuilder.FinalizeBlock(
        app.appCtx, state.PayloadID, state.ExecutionPayload, state.Requests)
}
```

## Graceful Shutdown

Handle SIGTERM/SIGINT properly:

```go
func (app *SingleNodeApp) Stop() {
    app.logger.Info("stopping...")
    app.cancel()

    // Wait with timeout
    done := make(chan struct{})
    go func() {
        app.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        app.logger.Info("shutdown complete")
    case <-time.After(5 * time.Second):
        app.logger.Warn("shutdown timed out")
    }
}
```

## CLI Entry Point

The CLI uses [`urfave/cli`](https://github.com/urfave/cli) to map flags to the `Config` struct, sets up signal handling for graceful shutdown, and wires everything together. See the [full source](https://github.com/mikelle/geth-consensus-tutorial/blob/main/02-single-node/cmd/main.go) — here's the core:

```go
ctx, cancel := signal.NotifyContext(context.Background(),
    os.Interrupt, syscall.SIGTERM)
defer cancel()

snode, err := NewSingleNodeApp(ctx, cfg, logger)
if err != nil {
    return err
}

snode.Start()
<-ctx.Done()
snode.Stop()
```

`signal.NotifyContext` catches SIGTERM/SIGINT and cancels the context, which propagates through the run loop and triggers `Stop()`.

## Running It

Start Geth using the same Docker setup from Part 1:

```bash
docker compose up geth
```

Then run the consensus layer:

```bash
cd 02-single-node
go run ./cmd \
    --instance-id "node-1" \
    --priority-fee-recipient "0xYourAddress"
```

The defaults connect to `localhost:8551` and use the shared JWT secret from the repo.

You should see output like this:

```text
level=INFO msg="Starting single-node consensus" instanceID=node-1
level=INFO msg="Health endpoint listening" addr=:8080
level=INFO msg="Initialized from Geth" component=BlockBuilder height=0 hash=0x40a4ba...
```

Once you send a transaction (e.g., with `cast send`), the node picks it up and finalizes a block:

```text
level=INFO msg="Block finalized" component=BlockBuilder height=1 hash=0xf5c59c... txs=1
```

If there are no pending transactions, the node waits quietly until new ones arrive.

## Metrics

The health server exposes a `/metrics` endpoint via `promhttp.Handler()` for Prometheus scraping. This gives you Go runtime metrics and any custom metrics you add. You can see it in the `Start()` method above:

```go
mux.Handle("/metrics", promhttp.Handler())
```

Scrape `http://localhost:8080/metrics` to monitor your consensus layer.

## What's Next

We now have a production-ready single-node consensus. But what happens when this node fails? In **[Part 3: Distributed Consensus with Redis, PostgreSQL, and Member Nodes](/blog/redis-distributed-consensus)**, we'll add:

- Leader election with Redis
- Durable payload storage in PostgreSQL
- An HTTP API for block sync
- Horizontally scalable member nodes

---

*Full source code: [geth-consensus-tutorial](https://github.com/mikelle/geth-consensus-tutorial/tree/main/02-single-node) | Based on [mev-commit consensus layer](https://github.com/primev/mev-commit/tree/main/cl)*
