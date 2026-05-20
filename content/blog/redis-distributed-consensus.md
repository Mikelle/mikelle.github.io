---
title: "Distributed Consensus with Redis, PostgreSQL, and Member Nodes"
date: 2026-02-09
draft: false
description: "Adding fault tolerance with Redis leader election, PostgreSQL payload storage, and member nodes that execute blocks on their own Geth."
tags: ["consensus", "geth", "redis", "postgres", "tutorial"]
---

*Part 3 of the Custom Geth Consensus Series* <!-- markdownlint-disable-line MD036 -->

A single-node consensus layer ([Part 2](/blog/single-node-consensus)) works until the node dies. This article adds Redis-based leader election for failover, PostgreSQL for durable payload storage, and member nodes that sync blocks from the leader and execute them on their own Geth instance, making each member a full execution replica. Full source code is on [GitHub](https://github.com/mikelle/geth-consensus-tutorial/tree/main/03-member-nodes).

## What We're Building

```text
┌─────────────────────────────────────────────────────────────┐
│                       Leader Node                           │
│  ┌──────────────┐   ┌────────────┐   ┌───────────────────┐  │
│  │ BlockBuilder │   │ PostgreSQL │   │ HTTP API (:8090)  │  │
│  │   + Geth     │-->│  payloads  │<--│ /blocks?after=N   │  │
│  └──────┬───────┘   └────────────┘   └───────────────────┘  │
│         │                                      ▲            │
│  ┌──────▼───────┐                              │            │
│  │    Redis     │                              │            │
│  │  • Election  │                              │            │
│  │  • State     │                              │            │
│  └──────────────┘                              │            │
└────────────────────────────────────────────────┼────────────┘
                                                 │
                   ┌─────────────────────────────┼─────────────────────┐
                   │                             │                     │
            ┌──────▼──────┐               ┌──────▼──────┐       ┌──────▼──────┐
            │  Member 1   │               │  Member 2   │       │  Member 3   │
            │ Syncer+Geth │               │ Syncer+Geth │       │ Syncer+Geth │
            │ +PostgreSQL │               │ +PostgreSQL │       │ +PostgreSQL │
            └─────────────┘               └─────────────┘       └─────────────┘
```

The **leader** builds blocks on Geth, stores payloads in PostgreSQL, and exposes an HTTP API. **Member nodes** poll that API, execute each block on their own Geth via the Engine API, and store the results in their local PostgreSQL, making each member a full execution replica that can serve RPC queries (eth_call, eth_getBalance, etc.) without touching the leader.

Since NewPayloadV4 requires both the execution payload and [EIP-7685](https://eips.ethereum.org/EIPS/eip-7685) execution requests to execute a block, we store both in PostgreSQL so members can replay them.

Redis handles two things: leader election (so a standby can take over if the leader dies) and block build state (so the leader can recover mid-build after a restart).

## Redis Client

A thin wrapper around [`go-redis`](https://github.com/redis/go-redis) exposing the operations we need:

```go
type Client struct {
    rdb        *redis.Client
    streamName string
}

func NewClient(addr, password, streamName string) (*Client, error) {
    rdb := redis.NewClient(&redis.Options{
        Addr:     addr,
        Password: password,
        DB:       0,
    })

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := rdb.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("ping redis: %w", err)
    }

    return &Client{rdb: rdb, streamName: streamName}, nil
}
```

The client also exposes `Set`, `Get`, `SetNX`, `Del` for state management, plus `PublishBlock` for the Redis stream. For leader election, we need two atomic operations that check-and-act in a single Redis round-trip. Lua scripts run atomically on the Redis server:

```go
func (c *Client) RenewIfValue(ctx context.Context, key, value string, expiration time.Duration) (bool, error) {
    script := redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
    return 1
end
return 0`)
    result, err := script.Run(ctx, c.rdb, []string{key}, value, expiration.Milliseconds()).Int64()
    if err != nil {
        return false, err
    }
    return result == 1, nil
}
```

`DelIfValue` follows the same pattern: only delete if the key still holds our value. See the [full source](https://github.com/mikelle/geth-consensus-tutorial/blob/main/03-member-nodes/pkg/redis/client.go).

## Leader Election

Leader election uses `SetNX` (set-if-not-exists) with a TTL. The key `consensus:leader` holds the current leader's instance ID. If the leader crashes, the key expires and another node acquires it.

```go
const (
    leaderKey       = "consensus:leader"
    defaultLeaseTTL = 5 * time.Second
    renewInterval   = 2 * time.Second
)

type LeaderElection struct {
    client     *Client
    instanceID string
    leaseTTL   time.Duration
    logger     *slog.Logger

    mu       sync.RWMutex
    isLeader bool
    cancel   context.CancelFunc
}
```

Every 2 seconds, the election loop attempts to acquire or renew the lock. The renewal must be atomic. If we did a separate `Get` then `Set`, the key could expire between the two calls and another node could acquire it, leading to two nodes both believing they're leader. `RenewIfValue` uses a Lua script to check the value and renew the TTL in a single Redis operation:

```go
func (le *LeaderElection) tryAcquireOrRenew(ctx context.Context) {
    le.mu.Lock()
    defer le.mu.Unlock()

    // Try to acquire
    acquired, err := le.client.SetNX(ctx, leaderKey, le.instanceID, le.leaseTTL)
    if err != nil {
        le.logger.Error("Failed to acquire leadership", "error", err)
        le.isLeader = false
        return
    }

    if acquired {
        if !le.isLeader {
            le.logger.Info("Became leader", "instanceID", le.instanceID)
        }
        le.isLeader = true
        return
    }

    // Atomically renew only if we still hold the lock
    renewed, err := le.client.RenewIfValue(ctx, leaderKey, le.instanceID, le.leaseTTL)
    if err != nil {
        le.logger.Warn("Failed to renew lease", "error", err)
        le.isLeader = false
        return
    }

    if renewed {
        le.isLeader = true
    } else {
        if le.isLeader {
            le.logger.Info("Lost leadership")
        }
        le.isLeader = false
    }
}
```

On graceful shutdown, we can't just `Del` the key. Between checking `wasLeader` and calling `Del`, another node may have already acquired the lock, and we'd delete *their* lease. `DelIfValue` uses a Lua script to only delete the key if it still holds our instance ID:

```go
func (le *LeaderElection) Stop() {
    if le.cancel != nil {
        le.cancel()
    }

    le.mu.Lock()
    wasLeader := le.isLeader
    le.isLeader = false
    le.mu.Unlock()

    if wasLeader {
        ctx, cancel := context.WithTimeout(context.Background(), time.Second)
        defer cancel()
        le.client.DelIfValue(ctx, leaderKey, le.instanceID)
    }
}
```

## Redis State Manager

Same `StateManager` interface from [Part 2](/blog/single-node-consensus), but the implementation changes from in-memory to Redis-backed with JSON serialization and a 5-minute TTL:

```go
type RedisStateManager struct {
    client     *Client
    instanceID string
    mu         sync.RWMutex
    localState *BlockBuildState // Local cache fallback
}

func (m *RedisStateManager) SaveBlockState(ctx context.Context, state *BlockBuildState) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    data, err := json.Marshal(state)
    if err != nil {
        return fmt.Errorf("marshal state: %w", err)
    }

    if err := m.client.Set(ctx, m.stateKey(), string(data), stateTTL); err != nil {
        return fmt.Errorf("save state to redis: %w", err)
    }

    m.localState = state
    return nil
}
```

Each node gets its own key (`consensus:state:<instance-id>`). The local cache provides a fallback if Redis is temporarily unreachable.

## PostgreSQL Storage

Finalized payloads are stored in PostgreSQL so member nodes can sync them. The schema auto-migrates on startup:

```go
func (s *PayloadStore) migrate(ctx context.Context) error {
    query := `
        CREATE TABLE IF NOT EXISTS payloads (
            block_number BIGINT PRIMARY KEY,
            block_hash TEXT NOT NULL UNIQUE,
            parent_hash TEXT NOT NULL,
            payload_data TEXT NOT NULL,
            requests_data TEXT NOT NULL DEFAULT '',
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_payloads_block_hash ON payloads(block_hash);
        CREATE INDEX IF NOT EXISTS idx_payloads_timestamp ON payloads(timestamp);

        ALTER TABLE payloads ADD COLUMN IF NOT EXISTS requests_data TEXT NOT NULL DEFAULT '';
    `
    _, err := s.pool.Exec(ctx, query)
    return err
}
```

The `requests_data` column stores the base64-encoded execution requests alongside each payload. The `ALTER TABLE` handles upgrades from the previous schema.

The store uses [`pgx`](https://github.com/jackc/pgx) with connection pooling and provides `SavePayload`, `GetPayloadByNumber`, `GetPayloadByHash`, `GetLatestPayload`, and `GetPayloadsAfter`. See the [full source](https://github.com/mikelle/geth-consensus-tutorial/blob/main/03-member-nodes/pkg/postgres/store.go).

The key query for member sync is batch fetching by block number:

```go
func (s *PayloadStore) GetPayloadsAfter(ctx context.Context, afterNumber uint64, limit int) ([]*Payload, error) {
    query := `
        SELECT block_number, block_hash, parent_hash, payload_data, requests_data, timestamp
        FROM payloads
        WHERE block_number > $1
        ORDER BY block_number ASC
        LIMIT $2
    `
    rows, err := s.pool.Query(ctx, query, afterNumber, limit)
    // ...
}
```

## Block Builder Changes

The block builder is the same as [Part 2](/blog/single-node-consensus), with two additions after finalization: store in PostgreSQL and publish to Redis.

```go
// Update local head (block is finalized on Geth regardless of storage outcome)
bb.executionHead = &state.ExecutionHead{
    BlockHeight: payload.Number,
    BlockHash:   payload.BlockHash[:],
    BlockTime:   payload.Timestamp,
}

// Store in PostgreSQL
if bb.payloadStore != nil {
    pgPayload := &postgres.Payload{
        BlockNumber:  payload.Number,
        BlockHash:    payload.BlockHash.Hex(),
        ParentHash:   payload.ParentHash.Hex(),
        PayloadData:  executionPayloadStr,
        RequestsData: requestsStr,
        Timestamp:    int64(payload.Timestamp),
    }
    if err := bb.payloadStore.SavePayload(ctx, pgPayload); err != nil {
        return fmt.Errorf("store payload in PostgreSQL: %w", err)
    }
}

// Publish to Redis stream
if bb.redisClient != nil {
    if err := bb.redisClient.PublishBlock(ctx, payload.BlockHash.Hex(),
        executionPayloadStr, payload.Number); err != nil {
        return fmt.Errorf("publish block to Redis: %w", err)
    }
}
```

The local head is updated first so the next block builds from the right point even if storage fails. PostgreSQL and Redis failures return hard errors. If either fails, the operator knows the block didn't reach members. The Redis stream is for real-time notification.

## HTTP API for Member Sync

The leader exposes a simple HTTP API backed by PostgreSQL:

```go
func NewServer(store *postgres.PayloadStore, addr string, logger *slog.Logger) *Server {
    s := &Server{store: store, logger: logger}

    mux := http.NewServeMux()
    mux.HandleFunc("/blocks/latest", s.handleLatestBlock)
    mux.HandleFunc("/blocks/", s.handleGetBlock)      // /blocks/{number or hash}
    mux.HandleFunc("/blocks", s.handleGetBlocksAfter)  // /blocks?after=N&limit=M

    s.server = &http.Server{
        Addr:         addr,
        Handler:      mux,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
    }
    return s
}
```

The batch endpoint is what members use to sync. It returns blocks after a given height, with the limit capped at 1000:

```go
func (s *Server) handleGetBlocksAfter(w http.ResponseWriter, r *http.Request) {
    after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)

    limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
    if limit <= 0 {
        limit = 100
    }
    if limit > 1000 {
        limit = 1000
    }

    payloads, err := s.store.GetPayloadsAfter(r.Context(), after, limit)
    // ... marshal and return JSON
}
```

## Member Syncer

Member nodes poll the leader's HTTP API every 100ms for new blocks. For each block, the syncer executes it on the local Geth via the Engine API, then stores it in PostgreSQL. The syncer defines its own `ExecutionEngine` interface to avoid importing the block builder:

```go
type ExecutionEngine interface {
    NewPayloadV4(ctx context.Context, payload engine.ExecutableData,
        versionedHashes []common.Hash, beaconRoot *common.Hash,
        requests [][]byte) (engine.PayloadStatusV1, error)
    ForkchoiceUpdatedV3(ctx context.Context, state engine.ForkchoiceStateV1,
        attrs *engine.PayloadAttributes) (engine.ForkChoiceResponse, error)
    HeaderByNumber(ctx context.Context, number *big.Int) (*types.Header, error)
}
```

For each fetched block, `executeBlock` deserializes the payload and requests, then replays the same Engine API calls the leader made: `NewPayloadV4` to push the block, `ForkchoiceUpdatedV3` to set the head.

```go
func (s *Syncer) executeBlock(ctx context.Context, block *BlockResponse) error {
    // Decode base64 → msgpack → ExecutableData
    payloadBytes, err := base64.StdEncoding.DecodeString(block.PayloadData)
    if err != nil {
        return fmt.Errorf("decode payload: %w", err)
    }
    var execPayload engine.ExecutableData
    if err := msgpack.Unmarshal(payloadBytes, &execPayload); err != nil {
        return fmt.Errorf("unmarshal payload: %w", err)
    }

    // Decode requests
    var requests [][]byte
    if block.RequestsData != "" {
        requestsBytes, err := base64.StdEncoding.DecodeString(block.RequestsData)
        if err != nil {
            return fmt.Errorf("decode requests: %w", err)
        }
        if err := msgpack.Unmarshal(requestsBytes, &requests); err != nil {
            return fmt.Errorf("unmarshal requests: %w", err)
        }
    }

    // Push to Geth
    parentHash := common.HexToHash(block.ParentHash)
    status, err := s.engine.NewPayloadV4(ctx, execPayload, []common.Hash{}, &parentHash, requests)
    if err != nil {
        return fmt.Errorf("NewPayloadV4: %w", err)
    }
    if status.Status == engine.INVALID {
        msg := "unknown"
        if status.ValidationError != nil {
            msg = *status.ValidationError
        }
        return fmt.Errorf("payload invalid: %s", msg)
    }

    // Update fork choice
    fcs := engine.ForkchoiceStateV1{
        HeadBlockHash:      execPayload.BlockHash,
        SafeBlockHash:      execPayload.BlockHash,
        FinalizedBlockHash: execPayload.BlockHash,
    }
    if _, err := s.engine.ForkchoiceUpdatedV3(ctx, fcs, nil); err != nil {
        return fmt.Errorf("ForkchoiceUpdatedV3: %w", err)
    }

    return nil
}
```

After execution, the block is saved to the member's local PostgreSQL. On startup, the syncer queries Geth for its current head block and resumes from there, so restarts don't re-execute the entire chain. See the [full source](https://github.com/mikelle/geth-consensus-tutorial/blob/main/03-member-nodes/pkg/sync/syncer.go) for the complete sync loop.

## Application Wiring

The application runs in two modes: `--mode leader` or `--mode member`.

**Leader mode** sets up the full stack: Redis, Geth, PostgreSQL, leader election, block production, and the HTTP API. The run loop is the same as [Part 2](/blog/single-node-consensus) with one addition: only produce blocks when elected leader.

```go
func (app *MemberNodesApp) runLeaderLoop() {
    app.stateManager.ResetBlockState(app.appCtx)

    for {
        select {
        case <-app.appCtx.Done():
            return
        default:
            if !app.leaderElection.IsLeader() {
                time.Sleep(100 * time.Millisecond)
                continue
            }

            err := app.produceBlock()
            // ... handle errors, reset state
        }
    }
}
```

**Member mode** creates its own Geth Engine API client and passes it to the syncer, so each member is a full execution node:

```go
if cfg.Mode == "member" {
    jwtBytes, _ := hex.DecodeString(cfg.JWTSecret)
    engineCl, _ := ethclient.NewEngineClient(ctx, cfg.EthClientURL, jwtBytes)

    syncEngine := &syncerEngineAdapter{client: engineCl}
    app.syncer = syncpkg.NewSyncer(cfg.LeaderURL, payloadStore, syncEngine, logger)
} else {
    // Full leader setup: Redis, Geth, leader election, block builder, API server
}
```

## Running It

Start the infrastructure. The compose file includes a second Geth and PostgreSQL instance for the member node:

```bash
docker compose up -d geth geth-member redis postgres postgres-member
```

Run the leader:

```bash
cd 03-member-nodes
go run ./cmd/main.go \
    --instance-id leader-1 \
    --mode leader \
    --health-addr :8080 \
    --api-addr :8090
```

```text
level=INFO msg="Starting consensus node" instanceID=leader-1 mode=leader
level=INFO msg="Became leader" instanceID=leader-1
level=INFO msg="Initialized from Geth" component=BlockBuilder height=0 hash=0x40a4ba...
```

Send a transaction to trigger block production (using [Foundry's `cast`](https://book.getfoundry.sh/cast/)):

```bash
cast send --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    --rpc-url http://localhost:8545 \
    --value 1wei 0x0000000000000000000000000000000000000001
```

```text
level=INFO msg="Block finalized" component=BlockBuilder height=1 hash=0x8091f6... txs=1
```

Run a member node (with its own Geth instance):

```bash
go run ./cmd/main.go \
    --instance-id member-1 \
    --mode member \
    --leader-url http://localhost:8090 \
    --eth-client-url http://localhost:8552 \
    --postgres-url "postgres://postgres:postgres@localhost:5433/consensus?sslmode=disable" \
    --health-addr :8081
```

```text
level=INFO msg="Starting consensus node" instanceID=member-1 mode=member
level=INFO msg="Resuming sync from Geth head" component=Syncer block=0
level=INFO msg="Member node started" leaderURL=http://localhost:8090
```

Each member needs its own Geth and PostgreSQL instance. The `geth-member` service in docker-compose maps Geth's Engine API to port 8552 and `postgres-member` maps PostgreSQL to port 5433. The member's syncer fetches blocks from the leader's HTTP API, executes them on its local Geth, and stores the results in its own PostgreSQL.

Once the leader finalizes blocks, the member syncs and executes them:

```text
level=INFO msg="Synced blocks" component=Syncer count=1 latest=1
```

### Health Checks

```bash
curl localhost:8080/health  # OK (mode=leader, isLeader=true)
curl localhost:8081/health  # OK (mode=member, lastSynced=1, totalSynced=1)
```

### Testing Failover

```bash
# Kill the leader (Ctrl+C)
# Wait up to 5s for TTL to expire
# A standby leader node (if running) acquires the lock and resumes block production
```

## Failure Scenarios

| Scenario | Behavior |
|----------|----------|
| Leader crashes | Lock expires (5s TTL), standby acquires |
| Leader shuts down gracefully | Lock deleted immediately, instant failover |
| Member loses leader connection | Exponential backoff (200ms–30s), catches up when reconnected |
| PostgreSQL unavailable | Leader returns error, block finalized on Geth but not stored |
| Redis unavailable | All nodes lose leadership, block production pauses |

## What's Next

We now have a distributed consensus system with leader election, durable storage, and horizontally scalable member nodes that are full execution replicas. In **[Part 4: CometBFT Integration](/blog/cometbft-geth-consensus)**, we replace the custom leader election with proper BFT consensus, where multiple validators agree on blocks through voting rounds, with instant finality.

---

*Full source code: [geth-consensus-tutorial](https://github.com/mikelle/geth-consensus-tutorial/tree/main/03-member-nodes) | Based on [mev-commit consensus layer](https://github.com/primev/mev-commit/tree/main/cl)*
