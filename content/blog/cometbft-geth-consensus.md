---
title: "CometBFT Integration: BFT Finality for Geth"
date: 2026-02-10
draft: true
description: "Replacing custom leader election with CometBFT for Byzantine fault tolerance, multi-validator voting, and instant finality."
tags: ["consensus", "geth", "mev", "cometbft", "tutorial"]
---

*Part 4 of the Custom Geth Consensus Series* <!-- markdownlint-disable-line MD036 -->

In [Part 3](/blog/redis-distributed-consensus), we built a distributed consensus system with Redis leader election and member nodes. That system tolerates crashes: if the leader dies, a standby takes over. But it can't handle a *malicious* leader that proposes invalid blocks. This article replaces the entire custom stack with [CometBFT](https://cometbft.com/) (formerly Tendermint), giving us Byzantine fault tolerance, multi-validator voting, and instant finality. Full source code is on [GitHub](https://github.com/mikelle/geth-consensus-tutorial/tree/main/04-cometbft-consensus).

## What We're Building

Each validator runs a CometBFT node paired with a Geth instance. CometBFT handles consensus (who proposes, who votes, when to finalize), while Geth handles execution (building blocks, running the EVM). They communicate through ABCI — the Application Blockchain Interface.

```text
┌──────────────────────────────────────────────────────────┐
│                   CometBFT Consensus                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐          │
│  │ Validator 1│  │ Validator 2│  │ Validator 3│          │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘          │
│        └───────────────┼───────────────┘                  │
│                  P2P Gossip Network                        │
└────────────────────────┼──────────────────────────────────┘
                         │
                    ABCI (Local)
                         │
┌────────────────────────▼──────────────────────────────────┐
│                   ABCI Application                         │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  GethConsensusApp                                     │ │
│  │  ├─ PrepareProposal() → Build block via Engine API   │ │
│  │  ├─ ProcessProposal() → Validate proposed block      │ │
│  │  ├─ FinalizeBlock()   → Execute via NewPayload       │ │
│  │  └─ Commit()          → Acknowledge block             │ │
│  └──────────────────────────────────────────────────────┘ │
│                         │                                  │
│                Engine API (HTTP + JWT)                      │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────────┐
│                        Geth                                │
│  ├─ Block Builder       (Assembles transactions)          │
│  ├─ State Machine       (Executes EVM)                    │
│  └─ Storage             (Persists chain)                  │
└───────────────────────────────────────────────────────────┘
```

This mirrors Ethereum's post-merge architecture: separate consensus and execution layers connected by the Engine API. The difference: CometBFT replaces the Beacon Chain, giving us BFT consensus with configurable validators.

### Redis Consensus vs CometBFT

| | Redis Consensus (Part 3) | CometBFT (Part 4) |
|---|---|---|
| Fault tolerance | Crash only | Byzantine (malicious actors) |
| Finality | Leader-determined | Instant (single slot) |
| Validators | Single leader | Multi-validator voting |
| Network trust | Trusted | Untrusted |

## CometBFT Consensus Flow

CometBFT uses a three-phase commit protocol. A designated proposer builds a block, all validators vote on it, and if >2/3 agree, the block is finalized. Each phase maps to an ABCI method in our application:

```text
Height H
    │
    ▼
┌──────────────────────────────────────────────┐
│  PROPOSE                                      │
│  Proposer calls PrepareProposal()             │
│    1. ForkchoiceUpdatedV3 (start building)    │
│    2. Wait 300ms for transactions             │
│    3. GetPayloadV5 (retrieve built block)     │
│    4. Wrap payload as CometBFT transaction    │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│  PREVOTE                                      │
│  All validators call ProcessProposal()        │
│    • Verify parent hash matches local head    │
│    • Verify block height is sequential        │
│    • Verify timestamp is increasing           │
│    • Vote ACCEPT or REJECT                    │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│  PRECOMMIT                                    │
│  Validators commit if >2/3 prevoted           │
│    • Sign precommit message                   │
│    • Broadcast to network                     │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│  FINALIZATION                                 │
│  All nodes call FinalizeBlock()               │
│    1. NewPayloadV4 (submit to Geth)           │
│    2. ForkchoiceUpdatedV3 (set as head)       │
│    3. Save execution head to Badger DB        │
│    4. Block is FINAL — no reorgs possible     │
└──────────────────────┬───────────────────────┘
                       ▼
                   Height H+1
```

## ABCI Application

The **Application Blockchain Interface (ABCI)** is CometBFT's protocol for communicating with application logic. CometBFT handles networking, consensus rounds, and validator management. Our app just needs to implement the interface methods that build, validate, and execute blocks.

The core types:

```go
// EngineClient interface for Engine API operations
type EngineClient interface {
    HeaderByNumber(ctx context.Context, number *big.Int) (*types.Header, error)
    ForkchoiceUpdatedV3(ctx context.Context, state engine.ForkchoiceStateV1,
        attrs *engine.PayloadAttributes) (engine.ForkChoiceResponse, error)
    GetPayloadV5(ctx context.Context, payloadID engine.PayloadID) (
        *engine.ExecutionPayloadEnvelope, error)
    NewPayloadV4(ctx context.Context, payload engine.ExecutableData,
        versionedHashes []common.Hash, beaconRoot *common.Hash,
        requests [][]byte) (engine.PayloadStatusV1, error)
}

// ExecutionHead tracks the current chain head
type ExecutionHead struct {
    BlockHeight uint64      `json:"block_height"`
    BlockHash   common.Hash `json:"block_hash"`
    BlockTime   uint64      `json:"block_time"`
}

// MsgExecutionPayload wraps the execution payload for CometBFT transactions
type MsgExecutionPayload struct {
    ExecutionPayload *engine.ExecutableData `json:"execution_payload"`
    Requests         [][]byte               `json:"requests"`
}
```

The `GethConsensusApp` struct holds a Badger DB for state persistence, the Engine API client, and a cached execution head:

```go
type GethConsensusApp struct {
    db         *badger.DB
    engineCl   EngineClient
    logger     *slog.Logger
    buildDelay time.Duration
    execHead   *ExecutionHead
}
```

## PrepareProposal — Building Blocks

When CometBFT selects this node as the round's proposer, it calls `PrepareProposal`. We trigger Geth to build a block via `ForkchoiceUpdatedV3` with payload attributes, wait for transactions to be included, then retrieve the built payload with `GetPayloadV5`:

```go
func (app *GethConsensusApp) buildBlock(ctx context.Context,
    timestamp int64,
) (*engine.ExecutableData, [][]byte, error) {
    headHash := app.execHead.BlockHash
    ts := uint64(timestamp)
    if ts <= app.execHead.BlockTime {
        ts = app.execHead.BlockTime + 1
    }

    fcs := engine.ForkchoiceStateV1{
        HeadBlockHash:      headHash,
        SafeBlockHash:      headHash,
        FinalizedBlockHash: headHash,
    }

    attrs := &engine.PayloadAttributes{
        Timestamp:             ts,
        Random:                headHash,
        SuggestedFeeRecipient: common.Address{},
        Withdrawals:           []*types.Withdrawal{},
        BeaconRoot:            &headHash,
    }

    response, err := app.engineCl.ForkchoiceUpdatedV3(ctx, fcs, attrs)
    if err != nil {
        return nil, nil, fmt.Errorf("forkchoice updated: %w", err)
    }

    if response.PayloadID == nil {
        return nil, nil, fmt.Errorf("no payload ID returned")
    }

    // Wait for Geth to build the block
    time.Sleep(app.buildDelay)

    payloadResp, err := app.engineCl.GetPayloadV5(ctx, *response.PayloadID)
    if err != nil {
        return nil, nil, fmt.Errorf("get payload: %w", err)
    }

    return payloadResp.ExecutionPayload, payloadResp.Requests, nil
}
```

`PrepareProposal` wraps the result as a `MsgExecutionPayload` and returns it as a single CometBFT transaction:

```go
func (app *GethConsensusApp) PrepareProposal(ctx context.Context,
    req *abcitypes.RequestPrepareProposal,
) (*abcitypes.ResponsePrepareProposal, error) {
    payload, requests, err := app.buildBlock(ctx, req.Time.Unix())
    if err != nil {
        return nil, fmt.Errorf("build block: %w", err)
    }

    msg := MsgExecutionPayload{ExecutionPayload: payload, Requests: requests}
    txBytes, _ := json.Marshal(msg)

    return &abcitypes.ResponsePrepareProposal{
        Txs: [][]byte{txBytes},
    }, nil
}
```

## ProcessProposal — Validating Blocks

Every validator receives the proposal and calls `ProcessProposal`. This is where non-proposing validators decide whether to vote ACCEPT or REJECT. The validation checks that the proposed block builds correctly on top of the current chain head:

```go
func (app *GethConsensusApp) validatePayload(
    payload *engine.ExecutableData,
) error {
    if app.execHead == nil {
        return fmt.Errorf("execution head not initialized")
    }

    expectedHeight := app.execHead.BlockHeight + 1
    if payload.Number != expectedHeight {
        return fmt.Errorf("invalid height: got %d, expected %d",
            payload.Number, expectedHeight)
    }

    if payload.ParentHash != app.execHead.BlockHash {
        return fmt.Errorf("invalid parent hash")
    }

    if payload.Timestamp <= app.execHead.BlockTime {
        return fmt.Errorf("invalid timestamp")
    }

    return nil
}
```

`ProcessProposal` unmarshals the proposed transaction, runs validation, and returns the vote:

```go
func (app *GethConsensusApp) ProcessProposal(ctx context.Context,
    req *abcitypes.RequestProcessProposal,
) (*abcitypes.ResponseProcessProposal, error) {
    if len(req.Txs) == 0 {
        return &abcitypes.ResponseProcessProposal{
            Status: abcitypes.ResponseProcessProposal_REJECT}, nil
    }

    var msg MsgExecutionPayload
    if err := json.Unmarshal(req.Txs[0], &msg); err != nil {
        return &abcitypes.ResponseProcessProposal{
            Status: abcitypes.ResponseProcessProposal_REJECT}, nil
    }

    if err := app.validatePayload(msg.ExecutionPayload); err != nil {
        return &abcitypes.ResponseProcessProposal{
            Status: abcitypes.ResponseProcessProposal_REJECT}, nil
    }

    return &abcitypes.ResponseProcessProposal{
        Status: abcitypes.ResponseProcessProposal_ACCEPT}, nil
}
```

If validation fails, the validator returns `REJECT` and CometBFT counts it as a vote against the proposal. If >1/3 of validators reject, the round fails. CometBFT increments the round number, selects the next proposer via round-robin, and starts a new proposal with configurable timeouts (default 3s propose, 1s prevote/precommit).

## FinalizeBlock

Once >2/3 of validators prevote and precommit, CometBFT calls `FinalizeBlock` on every node. This is where the block actually gets executed on Geth:

```go
func (app *GethConsensusApp) FinalizeBlock(ctx context.Context,
    req *abcitypes.RequestFinalizeBlock,
) (*abcitypes.ResponseFinalizeBlock, error) {
    var msg MsgExecutionPayload
    if err := json.Unmarshal(req.Txs[0], &msg); err != nil {
        return nil, fmt.Errorf("unmarshal payload: %w", err)
    }

    payload := msg.ExecutionPayload
    requests := msg.Requests

    // Submit to Geth
    parentHash := app.execHead.BlockHash
    status, err := app.engineCl.NewPayloadV4(ctx, *payload,
        []common.Hash{}, &parentHash, requests)
    if err != nil {
        return nil, fmt.Errorf("new payload: %w", err)
    }

    if status.Status == engine.INVALID {
        errMsg := "unknown"
        if status.ValidationError != nil {
            errMsg = *status.ValidationError
        }
        return nil, fmt.Errorf("payload invalid: %s", errMsg)
    }

    // Update forkchoice — instant finality
    fcs := engine.ForkchoiceStateV1{
        HeadBlockHash:      payload.BlockHash,
        SafeBlockHash:      payload.BlockHash,
        FinalizedBlockHash: payload.BlockHash, // ← instant finality
    }
    if _, err := app.engineCl.ForkchoiceUpdatedV3(ctx, fcs, nil); err != nil {
        return nil, fmt.Errorf("forkchoice update: %w", err)
    }

    // Update local state
    app.execHead = &ExecutionHead{
        BlockHeight: payload.Number,
        BlockHash:   payload.BlockHash,
        BlockTime:   payload.Timestamp,
    }

    if err := app.saveExecutionHead(app.execHead); err != nil {
        return nil, fmt.Errorf("save execution head: %w", err)
    }

    // Return one TxResult per transaction in the block
    txResults := make([]*abcitypes.ExecTxResult, len(req.Txs))
    for i := range req.Txs {
        txResults[i] = &abcitypes.ExecTxResult{Code: 0}
    }

    return &abcitypes.ResponseFinalizeBlock{
        AppHash:   payload.BlockHash.Bytes(),
        TxResults: txResults,
    }, nil
}
```

The key line is `FinalizedBlockHash: payload.BlockHash`. In the Engine API, `FinalizedBlockHash` tells Geth that this block (and all ancestors) can never be reverted. On Ethereum mainnet, a block takes ~13 minutes to become finalized (2 epochs of Casper FFG). Here, every block is finalized the moment it's committed, because >2/3 of validators signed it and BFT guarantees they can't equivocate.

## Commit

CometBFT calls `Commit()` after `FinalizeBlock()` to persist application state. Since we already save the execution head to Badger in `FinalizeBlock`, there is nothing left to do here:

```go
func (app *GethConsensusApp) Commit(ctx context.Context,
    req *abcitypes.RequestCommit,
) (*abcitypes.ResponseCommit, error) {
    return &abcitypes.ResponseCommit{}, nil
}
```

With `Commit`, the ABCI lifecycle for a single block is complete. CometBFT increments the height and starts the next round.

## State Persistence

The ABCI app uses [Badger](https://github.com/dgraph-io/badger) to persist the execution head across restarts. On startup, `Info()` loads the last known state; on first run, `InitChain()` queries Geth for the genesis block:

```go
func (app *GethConsensusApp) Info(ctx context.Context,
    req *abcitypes.RequestInfo,
) (*abcitypes.ResponseInfo, error) {
    execHead, err := app.loadExecutionHead()
    if err != nil {
        return &abcitypes.ResponseInfo{LastBlockHeight: 0}, nil
    }

    app.execHead = execHead
    return &abcitypes.ResponseInfo{
        LastBlockHeight:  int64(execHead.BlockHeight),
        LastBlockAppHash: execHead.BlockHash.Bytes(),
    }, nil
}

func (app *GethConsensusApp) InitChain(ctx context.Context,
    req *abcitypes.RequestInitChain,
) (*abcitypes.ResponseInitChain, error) {
    header, err := app.engineCl.HeaderByNumber(ctx, nil)
    if err != nil {
        return nil, fmt.Errorf("get genesis header: %w", err)
    }

    app.execHead = &ExecutionHead{
        BlockHeight: header.Number.Uint64(),
        BlockHash:   header.Hash(),
        BlockTime:   header.Time,
    }

    if err := app.saveExecutionHead(app.execHead); err != nil {
        return nil, fmt.Errorf("save execution head: %w", err)
    }
    return &abcitypes.ResponseInitChain{}, nil
}
```

`LastBlockHeight` and `LastBlockAppHash` tell CometBFT where the app left off. If CometBFT's own block store is ahead, it replays any missing blocks through `FinalizeBlock`.

The two helper functions use Badger's transaction API to read and write the execution head under a single key, `"execution_head"`. `db.View` opens a read-only transaction, `db.Update` opens a read-write transaction:

```go
const keyExecutionHead = "execution_head"

func (app *GethConsensusApp) loadExecutionHead() (*ExecutionHead, error) {
    var head ExecutionHead
    err := app.db.View(func(txn *badger.Txn) error {
        item, err := txn.Get([]byte(keyExecutionHead))
        if err != nil {
            return err
        }
        return item.Value(func(val []byte) error {
            return json.Unmarshal(val, &head)
        })
    })
    if err != nil {
        return nil, err
    }
    return &head, nil
}

func (app *GethConsensusApp) saveExecutionHead(head *ExecutionHead) error {
    data, err := json.Marshal(head)
    if err != nil {
        return err
    }
    return app.db.Update(func(txn *badger.Txn) error {
        return txn.Set([]byte(keyExecutionHead), data)
    })
}
```

## Application Wiring

The `runNode()` function wires everything together — Engine API client, Badger DB, ABCI app, and CometBFT node. The `engineClientAdapter` bridges our concrete `ethclient.EngineClient` to the `app.EngineClient` interface, keeping the ABCI app testable without a real Geth connection:

```go
func runNode(c *cli.Context) error {
    // Connect to Geth
    engineCl, err := ethclient.NewEngineClient(ctx, ethClientURL, jwtSecret)
    if err != nil {
        return fmt.Errorf("create engine client: %w", err)
    }

    // Open Badger DB for state persistence
    db, err := badger.Open(badger.DefaultOptions(
        filepath.Join(cmtHome, "badger")))
    if err != nil {
        return fmt.Errorf("open badger db: %w", err)
    }
    defer db.Close()

    // Create ABCI application
    abciApp := app.NewGethConsensusApp(db,
        &engineClientAdapter{client: engineCl}, logger)

    // Load CometBFT config, validator key, and node key
    config := cmtcfg.DefaultConfig()
    config.SetRoot(cmtHome)

    pv := privval.LoadFilePV(
        config.PrivValidatorKeyFile(),
        config.PrivValidatorStateFile(),
    )

    nodeKey, _ := p2p.LoadNodeKey(config.NodeKeyFile())

    // Create and start CometBFT node
    node, err := cmtnode.NewNode(
        config, pv, nodeKey,
        proxy.NewLocalClientCreator(abciApp),
        cmtnode.DefaultGenesisDocProviderFunc(config),
        cmtcfg.DefaultDBProvider,
        cmtnode.DefaultMetricsProvider(config.Instrumentation),
        cmtLogger,
    )
    if err != nil {
        return fmt.Errorf("create CometBFT node: %w", err)
    }

    node.Start()

    <-ctx.Done()
    node.Stop()
    node.Wait()
    return nil
}
```

The CLI accepts `--cmt-home` (CometBFT data directory), `--eth-client-url` (Geth Engine API endpoint), and `--jwt-secret` (shared authentication secret).

## Running It

### Prerequisites

Install CometBFT:

```bash
go install github.com/cometbft/cometbft/cmd/cometbft@v0.38.21
cometbft version
```

Initialize a single validator for testing:

```bash
cometbft init --home ~/.cometbft
```

This creates the config files, genesis with a single validator, and signing keys under `~/.cometbft/`.

### Start Geth

```bash
# From the repo root
docker compose up -d geth
```

### Start CometBFT + ABCI App

```bash
cd 04-cometbft-consensus
go run ./cmd/main.go \
  --cmt-home ~/.cometbft \
  --eth-client-url http://localhost:8551 \
  --jwt-secret 688f5d737bad920bdfb2fc2f488d6b6209eebeb7b7f7710df3571de7fda67a32
```

The `--jwt-secret` flag defaults to the shared secret in the repo's [`jwt/jwt.hex`](https://github.com/mikelle/geth-consensus-tutorial/blob/main/jwt/jwt.hex), so you can omit it if using the default setup.

### Expected Output

```text
time=... level=INFO msg="Connecting to Geth" url=http://localhost:8551
time=... level=INFO msg="Starting CometBFT node" home=~/.cometbft
time=... level=INFO msg="ABCI Info called"
time=... level=INFO msg="ABCI InitChain called" chainID=test-chain
time=... level=INFO msg="Initialized from Geth genesis" height=0 hash=0x...

time=... level=INFO msg="PrepareProposal called" height=1
time=... level=INFO msg="Prepared proposal" blockNumber=1 blockHash=0x... txCount=0
time=... level=INFO msg="ProcessProposal called" height=1
time=... level=INFO msg="FinalizeBlock called" height=1
time=... level=INFO msg="Block finalized" height=1 hash=0x...

time=... level=INFO msg="PrepareProposal called" height=2
...
```

Each line of output traces the consensus flow: the proposer builds a block (`PrepareProposal`), all validators validate it (`ProcessProposal`), and then everyone executes it (`FinalizeBlock`).

### Multi-Validator Setup

The above runs a single validator. To test BFT consensus, you need at least three validators (tolerating one Byzantine fault). Each validator gets its own CometBFT home directory, its own Geth instance, and a shared genesis that lists all validator public keys.

**1. Generate validator keys:**

```bash
for i in {0..2}; do
  cometbft init --home ~/.cometbft-node$i
done
```

Each `init` creates a unique validator key pair under `config/priv_validator_key.json`.

**2. Create a shared genesis.json:**

Collect the public keys from each node's `priv_validator_key.json` and build a single `genesis.json` with all validators. Copy this file to every node's `config/genesis.json`:

```json
{
  "genesis_time": "2024-01-01T00:00:00.000000Z",
  "chain_id": "geth-consensus",
  "validators": [
    {
      "address": "VALIDATOR_0_ADDRESS",
      "pub_key": {"type": "tendermint/PubKeyEd25519", "value": "..."},
      "power": "100"
    },
    {
      "address": "VALIDATOR_1_ADDRESS",
      "pub_key": {"type": "tendermint/PubKeyEd25519", "value": "..."},
      "power": "100"
    },
    {
      "address": "VALIDATOR_2_ADDRESS",
      "pub_key": {"type": "tendermint/PubKeyEd25519", "value": "..."},
      "power": "100"
    }
  ],
  "consensus_params": {
    "block": {"max_bytes": "22020096", "max_gas": "-1"},
    "validator": {"pub_key_types": ["ed25519"]}
  }
}
```

**3. Configure persistent peers:**

Each node needs to know how to reach the others. In each node's `config.toml`, set `persistent_peers` to the other nodes' IDs and addresses. The node ID is the first 20 bytes of the SHA256 hash of the node's public key, hex-encoded. You can find the public key in `config/node_key.json`:

```toml
[p2p]
persistent_peers = "node0_id@node0_host:26656,node1_id@node1_host:26656,node2_id@node2_host:26656"
```

**4. Start all nodes:**

Each validator runs its own `cometbft-geth` process paired with a dedicated Geth instance on separate Engine API ports:

```bash
# Node 0
go run ./cmd/main.go --cmt-home ~/.cometbft-node0 --eth-client-url http://geth0:8551

# Node 1
go run ./cmd/main.go --cmt-home ~/.cometbft-node1 --eth-client-url http://geth1:8551

# Node 2
go run ./cmd/main.go --cmt-home ~/.cometbft-node2 --eth-client-url http://geth2:8551
```

CometBFT handles peer discovery, proposer rotation, and vote aggregation automatically. No changes to the ABCI application code are needed.

## What's Next

Over four parts we've gone from raw Engine API calls to a Byzantine-fault-tolerant consensus layer:

- **[Part 1](/blog/custom-geth-consensus)**: Engine API fundamentals (ForkchoiceUpdated, GetPayload, NewPayload)
- **[Part 2](/blog/single-node-consensus)**: Production single-node with retry logic, health checks, graceful shutdown
- **[Part 3](/blog/redis-distributed-consensus)**: Distributed with Redis leader election, PostgreSQL storage, member nodes
- **Part 4**: BFT consensus with CometBFT voting, instant finality, multi-validator

From here, CometBFT opens up several production extensions: **[vote extensions](https://docs.cometbft.com/v0.38/spec/abci/abci++_app_requirements#vote-extensions)** for embedding extra data in consensus votes (useful for preconfirmations), **[state sync](https://docs.cometbft.com/v0.38/core/state-sync)** for fast node bootstrapping, and **encrypted mempools** for MEV protection. The [mev-commit](https://github.com/primev/mev-commit) project builds on this pattern for its production consensus layer.

---

*Full source code: [geth-consensus-tutorial](https://github.com/mikelle/geth-consensus-tutorial/tree/main/04-cometbft-consensus) | Based on [mev-commit consensus layer](https://github.com/primev/mev-commit/tree/main/cl)*
