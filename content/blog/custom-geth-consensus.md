---
title: "Writing Custom Consensus for Geth: A Practical Guide"
date: 2026-02-07
draft: false
description: "How to build a custom consensus layer for Geth using the Engine API - the foundation for L2 sequencers and private chains."
tags: ["consensus", "geth", "mev", "tutorial"]
---

*Part 1 of the Custom Geth Consensus Series* <!-- markdownlint-disable-line MD036 -->

When Ethereum transitioned to Proof of Stake, Geth introduced the Engine API - a clean interface between execution and consensus layers. While designed for beacon chain integration, it also enables building custom consensus mechanisms.

This series builds a complete custom consensus layer from scratch. We'll start with fundamentals and progress to a production-ready distributed system. Full source code is on [GitHub](https://github.com/mikelle/geth-consensus-tutorial).

## Why Build Custom Consensus?

- **Layer 2 chains**: Sequencers for rollups or app-specific chains
- **Private networks**: Permissioned chains with custom block production
- **Research**: Experimenting with new consensus mechanisms

The [mev-commit](https://github.com/primev/mev-commit) project uses custom consensus to enable preconfirmations.

## Architecture Overview

```text
┌─────────────────────────────────────────────────┐
│              Your Application                   │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│            Custom Consensus Layer               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────┐  │
│  │ Engine API  │  │    State    │  │  Block  │  │
│  │   Client    │  │   Manager   │  │ Builder │  │
│  └─────────────┘  └─────────────┘  └─────────┘  │
└─────────────────────┬───────────────────────────┘
                      │ Engine API (HTTP + JWT)
┌─────────────────────▼───────────────────────────┐
│                    Geth                         │
└─────────────────────────────────────────────────┘
```

The Engine API uses HTTP with JWT authentication. Three primary methods:

| Method | Purpose |
| ------ | ------- |
| `ForkchoiceUpdated` | Set chain head, trigger block building |
| `GetPayload` | Retrieve a built block |
| `NewPayload` | Submit a block for execution |

## Running Geth

Clone the repo and start Geth:

```bash
git clone https://github.com/mikelle/geth-consensus-tutorial.git
cd geth-consensus-tutorial
docker compose up geth
```

This starts Geth with the Engine API on port 8551 and HTTP RPC on 8545. The setup uses a custom [`genesis.json`](https://github.com/mikelle/geth-consensus-tutorial/blob/main/genesis.json) for the private chain — see [`docker-compose.yml`](https://github.com/mikelle/geth-consensus-tutorial/blob/main/docker-compose.yml) and [`geth-entrypoint.sh`](https://github.com/mikelle/geth-consensus-tutorial/blob/main/geth-entrypoint.sh) for the full configuration.

One important flag: `--miner.gasprice 1`. Geth's miner filters transactions whose effective tip is below this threshold during block building. The default (1 Mwei) silently drops transactions with low priority fees. This is a common gotcha on private chains where tools like `cast` default to minimal fees.

Once Geth is running, start the consensus client from the repo:

```bash
cd 01-engine-api
go run main.go
```

## JWT Authentication

Geth's Engine API requires JWT auth. A 32-byte shared secret is included in the repo at [`jwt/jwt.hex`](https://github.com/mikelle/geth-consensus-tutorial/blob/main/jwt/jwt.hex). To generate your own:

```bash
openssl rand -hex 32 > jwt/jwt.hex
```

Wrap HTTP requests with a JWT token:

```go
// jwt.go
package consensus

import (
    "bytes"
    "encoding/hex"
    "net/http"
    "os"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type jwtRoundTripper struct {
    underlyingTransport http.RoundTripper
    jwtSecret           []byte
}

func (t *jwtRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
    // Fresh token per request - avoids expiration issues
    token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
        "iat": time.Now().Unix(),
    })

    tokenString, err := token.SignedString(t.jwtSecret)
    if err != nil {
        return nil, err
    }
    req.Header.Set("Authorization", "Bearer "+tokenString)
    return t.underlyingTransport.RoundTrip(req)
}

func LoadJWTHexFile(file string) ([]byte, error) {
    jwtHex, err := os.ReadFile(file)
    if err != nil {
        return nil, err
    }
    jwtHex = bytes.TrimSpace(jwtHex)
    jwtHex = bytes.TrimPrefix(jwtHex, []byte("0x"))
    return hex.DecodeString(string(jwtHex))
}
```

> Error handling is shown in full above. Remaining code samples omit it for brevity — see the [repo](https://github.com/mikelle/geth-consensus-tutorial/tree/main/01-engine-api) for complete implementations.

## Engine Client

Wrap the Engine API calls. These use types from Geth's [`engine`](https://pkg.go.dev/github.com/ethereum/go-ethereum/beacon/engine), [`common`](https://pkg.go.dev/github.com/ethereum/go-ethereum/common), and [`hexutil`](https://pkg.go.dev/github.com/ethereum/go-ethereum/common/hexutil) packages:

```go
// engineclient.go
type EngineClient struct {
    rpc *rpc.Client
}

func (c *EngineClient) ForkchoiceUpdatedV3(ctx context.Context, state engine.ForkchoiceStateV1,
    attrs *engine.PayloadAttributes) (engine.ForkChoiceResponse, error) {
    var resp engine.ForkChoiceResponse
    err := c.rpc.CallContext(ctx, &resp, "engine_forkchoiceUpdatedV3", state, attrs)
    return resp, err
}

func (c *EngineClient) GetPayloadV5(ctx context.Context, payloadID engine.PayloadID) (*engine.ExecutionPayloadEnvelope, error) {
    var resp engine.ExecutionPayloadEnvelope
    err := c.rpc.CallContext(ctx, &resp, "engine_getPayloadV5", payloadID)
    return &resp, err
}

func (c *EngineClient) NewPayloadV4(ctx context.Context, payload engine.ExecutableData,
    versionedHashes []common.Hash, beaconRoot *common.Hash,
    requests []hexutil.Bytes) (engine.PayloadStatusV1, error) {
    var resp engine.PayloadStatusV1
    err := c.rpc.CallContext(ctx, &resp, "engine_newPayloadV4", payload, versionedHashes, beaconRoot, requests)
    return resp, err
}

func NewEngineClient(ctx context.Context, endpoint string, jwtSecret []byte) (*EngineClient, error) {
    transport := &jwtRoundTripper{
        underlyingTransport: http.DefaultTransport,
        jwtSecret:           jwtSecret,
    }

    httpClient := &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second,
    }

    rpcClient, _ := rpc.DialOptions(ctx, endpoint, rpc.WithHTTPClient(httpClient))
    return &EngineClient{rpc: rpcClient}, nil
}
```

## Block Building Lifecycle

Building a block is two-phase:

### Phase 1: Propose

```text
1. ForkchoiceUpdatedV3 with PayloadAttributes
   → Geth starts assembling block
   → Returns PayloadID

2. Wait for build delay (~100ms)
   → Geth includes transactions

3. GetPayloadV5 with PayloadID
   → Returns ExecutionPayload
```

### Phase 2: Finalize

```text
4. Validate ExecutionPayload
   → Check height, parent hash, timestamp

5. NewPayloadV4 with ExecutionPayload
   → Geth executes block
   → Returns VALID/INVALID/SYNCING

6. ForkchoiceUpdatedV3 to set new head
   → Block becomes canonical
```

Implementation:

```go
type ExecutionHead struct {
    BlockHeight uint64
    BlockHash   []byte
    BlockTime   uint64
}

func (bb *BlockBuilder) GetPayload(ctx context.Context) (*engine.ExecutableData, []hexutil.Bytes, error) {
    timestamp := uint64(time.Now().Unix())
    if timestamp <= bb.executionHead.BlockTime {
        timestamp = bb.executionHead.BlockTime + 1
    }

    headHash := common.BytesToHash(bb.executionHead.BlockHash)

    // In a single-node setup, head/safe/finalized point to the same block.
    // Multi-node consensus (Part 3+) will differentiate these.
    fcs := engine.ForkchoiceStateV1{
        HeadBlockHash:      headHash,
        SafeBlockHash:      headHash,
        FinalizedBlockHash: headHash,
    }

    attrs := &engine.PayloadAttributes{
        Timestamp:             timestamp,
        SuggestedFeeRecipient: bb.feeRecipient,
        BeaconRoot:            &headHash,
        Withdrawals:           []*types.Withdrawal{},
        // Random is the RANDAO mix from PoS. Not meaningful for custom
        // consensus, but the field is required — any deterministic value works.
        Random: headHash,
    }

    // Start block building
    response, _ := bb.engineCl.ForkchoiceUpdatedV3(ctx, fcs, attrs)
    payloadID := response.PayloadID

    // Wait for Geth to include transactions
    time.Sleep(bb.buildDelay)

    // Retrieve built block
    payloadResp, _ := bb.engineCl.GetPayloadV5(ctx, *payloadID)

    // Convert execution requests for NewPayloadV4
    requests := make([]hexutil.Bytes, len(payloadResp.Requests))
    for i, r := range payloadResp.Requests {
        requests[i] = r
    }
    return payloadResp.ExecutionPayload, requests, nil
}
```

Finalization:

```go
func (bb *BlockBuilder) FinalizeBlock(ctx context.Context,
    payload *engine.ExecutableData, requests []hexutil.Bytes) error {
    // Validate
    if payload.Number != bb.executionHead.BlockHeight+1 {
        return fmt.Errorf("invalid height")
    }
    if payload.ParentHash != common.BytesToHash(bb.executionHead.BlockHash) {
        return fmt.Errorf("invalid parent")
    }

    // Submit to Geth
    parentHash := common.BytesToHash(bb.executionHead.BlockHash)
    status, _ := bb.engineCl.NewPayloadV4(ctx, *payload, []common.Hash{}, &parentHash, requests)
    if status.Status == engine.INVALID {
        return fmt.Errorf("payload invalid: %s", *status.ValidationError)
    }

    // Update fork choice
    fcs := engine.ForkchoiceStateV1{
        HeadBlockHash:      payload.BlockHash,
        SafeBlockHash:      payload.BlockHash,
        FinalizedBlockHash: payload.BlockHash,
    }
    bb.engineCl.ForkchoiceUpdatedV3(ctx, fcs, nil)

    // Update local head
    bb.executionHead = &ExecutionHead{
        BlockHeight: payload.Number,
        BlockHash:   payload.BlockHash.Bytes(),
        BlockTime:   payload.Timestamp,
    }

    return nil
}
```

## Payload Status

| Status | Meaning | Action |
| ------ | ------- | ------ |
| `VALID` | Payload executed | Continue |
| `INVALID` | Validation failed | Don't retry |
| `SYNCING` | Geth syncing | Retry later |
| `ACCEPTED` | Accepted, not validated | Wait |

## State Management

Track consensus state for restarts:

```go
type BuildStep int

const (
    StepBuildBlock BuildStep = iota
    StepFinalizeBlock
)

type BlockBuildState struct {
    CurrentStep      BuildStep
    PayloadID        string
    ExecutionPayload string // Base64-encoded
}
```

State machine:

```text
┌────────────────┐ GetPayload()  ┌───────────────────┐
│ StepBuildBlock │ ────────────> │ StepFinalizeBlock │
└────────────────┘               └───────────────────┘
        ▲                                   │
        └───────────────────────────────────┘
                  FinalizeBlock()
```

## What's Next

**[Part 2: Single Node Consensus](/blog/single-node-consensus)** builds a complete implementation with full application structure, retry logic, metrics, and configuration management. **[Part 3: Distributed Consensus](/blog/redis-distributed-consensus)** adds Redis leader election, PostgreSQL storage, and horizontally scalable member nodes. **[Part 4: CometBFT Integration](/blog/cometbft-geth-consensus)** replaces custom leader election with BFT consensus for instant finality and multi-validator voting.

---

*Full source code: [geth-consensus-tutorial](https://github.com/mikelle/geth-consensus-tutorial/tree/main/01-engine-api) | Based on [mev-commit consensus layer](https://github.com/primev/mev-commit/tree/main/cl)*
