---
title: "Distributed Consensus with Redis, PostgreSQL, and Member Nodes"
date: 2026-01-17
draft: true
description: "Adding fault tolerance with Redis leader election, PostgreSQL payload storage, and horizontally scalable member nodes."
tags: ["consensus", "geth", "mev", "redis", "postgres", "tutorial"]
---

*Part 3 of the Custom Geth Consensus Series* <!-- markdownlint-disable-line MD036 -->

In [Part 2](/blog/single-node-consensus), we built a production-ready single-node consensus layer. But a single node is a single point of failure. This article adds Redis-based leader election for failover, PostgreSQL for durable payload storage, and member nodes that sync blocks from the leader via HTTP. Full source code is on [GitHub](https://github.com/mikelle/geth-consensus-tutorial/tree/main/03-member-nodes).

## What We're Building

```text
┌─────────────────────────────────────────────────────────────┐
│                       Leader Node                            │
│  ┌─────────────┐   ┌────────────┐   ┌───────────────────┐  │
│  │ BlockBuilder │   │ PostgreSQL │   │ HTTP API (:8090)  │  │
│  │   + Geth     │──►│  payloads  │◄──│ /blocks?after=N   │  │
│  └──────┬───────┘   └────────────┘   └───────────────────┘  │
│         │                                      ▲            │
│  ┌──────▼───────┐                              │            │
│  │    Redis     │                              │            │
│  │  • Election  │                              │            │
│  │  • State     │                              │            │
│  └──────────────┘                              │            │
└────────────────────────────────────────────────┼────────────┘
                                                 │
                          ┌──────────────────────┼──────────────────┐
                          │                      │                  │
                   ┌──────▼──────┐        ┌──────▼──────┐   ┌──────▼──────┐
                   │  Member 1   │        │  Member 2   │   │  Member 3   │
                   │  (syncer)   │        │  (syncer)   │   │  (syncer)   │
                   └─────────────┘        └─────────────┘   └─────────────┘
```

The **leader** builds blocks on Geth, stores payloads in PostgreSQL, and exposes an HTTP API. **Member nodes** poll that API to sync block data into their own PostgreSQL — they're read replicas that can serve queries without touching the leader.

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

The client also exposes `Set`, `Get`, `SetNX`, `Del` for leader election and state, plus `PublishBlock` for the Redis stream — see the [full source](https://github.com/mikelle/geth-consensus-tutorial/blob/main/03-member-nodes/pkg/redis/client.go).

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

Every 2 seconds, the election loop attempts to acquire or renew the lock:

```go
func (le *LeaderElection) tryAcquireOrRenew(ctx context.Context) {
    le.mu.Lock()
    defer le.mu.Unlock()

    // Try to acquire
    acquired, err := le.client.SetNX(ctx, leaderKey, le.instanceID, le.leaseTTL)
    if err != nil {
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

    // Key exists — check if we're the holder
    currentLeader, err := le.client.Get(ctx, leaderKey)
    if err != nil {
        le.isLeader = false
        return
    }

    if currentLeader == le.instanceID {
        // Renew the lease
        le.client.Set(ctx, leaderKey, le.instanceID, le.leaseTTL)
        le.isLeader = true
    } else {
        if le.isLeader {
            le.logger.Info("Lost leadership", "newLeader", currentLeader)
        }
        le.isLeader = false
    }
}
```

On graceful shutdown, we delete the key so failover is instant rather than waiting for the 5-second TTL:

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
        le.client.Del(ctx, leaderKey)
    }
}
```

## Redis State Manager

Same `StateManager` interface from Part 2 — the implementation changes from in-memory to Redis-backed with JSON serialization and a 5-minute TTL:

```go
type RedisStateManager struct {
    client     *redis.Client
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
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_payloads_block_hash ON payloads(block_hash);
        CREATE INDEX IF NOT EXISTS idx_payloads_timestamp ON payloads(timestamp);
    `
    _, err := s.pool.Exec(ctx, query)
    return err
}
```

The store uses [`pgx`](https://github.com/jackc/pgx) with connection pooling and provides `SavePayload`, `GetPayloadByNumber`, `GetPayloadByHash`, `GetLatestPayload`, and `GetPayloadsAfter` — see the [full source](https://github.com/mikelle/geth-consensus-tutorial/blob/main/03-member-nodes/pkg/postgres/store.go).

The key query for member sync is batch fetching by block number:

```go
func (s *PayloadStore) GetPayloadsAfter(ctx context.Context, afterNumber uint64, limit int) ([]*Payload, error) {
    query := `
        SELECT block_number, block_hash, parent_hash, payload_data, timestamp
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

The block builder is the same as Part 2, with two additions after finalization — store in PostgreSQL and publish to Redis:

```go
// Store in PostgreSQL
if bb.payloadStore != nil {
    pgPayload := &postgres.Payload{
        BlockNumber: payload.Number,
        BlockHash:   payload.BlockHash.Hex(),
        ParentHash:  payload.ParentHash.Hex(),
        PayloadData: executionPayloadStr,
        Timestamp:   int64(payload.Timestamp),
    }
    if err := bb.payloadStore.SavePayload(ctx, pgPayload); err != nil {
        bb.logger.Warn("Failed to store payload in PostgreSQL", "error", err)
    }
}

// Publish to Redis stream
if bb.redisClient != nil {
    if err := bb.redisClient.PublishBlock(ctx, payload.BlockHash.Hex(),
        executionPayloadStr, payload.Number); err != nil {
        bb.logger.Warn("Failed to publish block to Redis", "error", err)
    }
}
```

Both are best-effort — if either fails, the block is still finalized on Geth. PostgreSQL is the durable store; the Redis stream is for real-time notification.

## HTTP API for Member Sync

The leader exposes a simple HTTP API backed by PostgreSQL:

```go
func NewServer(store *postgres.PayloadStore, addr string, logger *slog.Logger) *Server {
    mux := http.NewServeMux()
    mux.HandleFunc("/blocks/latest", s.handleLatestBlock)
    mux.HandleFunc("/blocks/", s.handleGetBlock)      // /blocks/{number or hash}
    mux.HandleFunc("/blocks", s.handleGetBlocksAfter)  // /blocks?after=N&limit=M

    s.server = &http.Server{
        Addr:    addr,
        Handler: mux,
    }
    return s
}
```

The batch endpoint is what members use to sync. It returns blocks after a given height:

```go
func (s *Server) handleGetBlocksAfter(w http.ResponseWriter, r *http.Request) {
    after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)

    limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
    if limit == 0 || limit > 1000 {
        limit = 100
    }

    payloads, err := s.store.GetPayloadsAfter(r.Context(), after, limit)
    // ... marshal and return JSON
}
```

## Member Syncer

Member nodes poll the leader's HTTP API every 100ms for new blocks. When blocks arrive, they're stored in the member's own PostgreSQL:

```go
type Syncer struct {
    leaderURL   string
    store       *postgres.PayloadStore
    logger      *slog.Logger
    httpClient  *http.Client
    lastSynced  atomic.Uint64
    syncedCount atomic.Uint64
}

func (s *Syncer) syncBatch(ctx context.Context) error {
    lastSynced := s.lastSynced.Load()

    url := fmt.Sprintf("%s/blocks?after=%d&limit=100", s.leaderURL, lastSynced)
    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    resp, err := s.httpClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    var blocksResp BlocksResponse
    json.NewDecoder(resp.Body).Decode(&blocksResp)

    for _, block := range blocksResp.Blocks {
        payload := &postgres.Payload{
            BlockNumber: block.BlockNumber,
            BlockHash:   block.BlockHash,
            ParentHash:  block.ParentHash,
            PayloadData: block.PayloadData,
            Timestamp:   block.Timestamp,
        }

        if err := s.store.SavePayload(ctx, payload); err != nil {
            return fmt.Errorf("save payload %d: %w", block.BlockNumber, err)
        }

        s.lastSynced.Store(block.BlockNumber)
        s.syncedCount.Add(1)
    }

    return nil
}
```

On startup, the syncer checks its local PostgreSQL for the highest block and resumes from there — so restarts don't re-sync the entire chain.

## Application Wiring

The application runs in two modes: `--mode leader` or `--mode member`.

**Leader mode** sets up the full stack — Redis, Geth, PostgreSQL, leader election, block production, and the HTTP API. The run loop is the same as Part 2 with one addition: only produce blocks when elected leader.

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

**Member mode** just needs PostgreSQL and the syncer — no Redis, no Geth, no block building:

```go
if cfg.Mode == "member" {
    app.syncer = syncpkg.NewSyncer(cfg.LeaderURL, payloadStore, logger)
} else {
    // Full leader setup: Redis, Geth, leader election, block builder, API server
}
```

## Running It

Start the infrastructure:

```bash
docker compose up -d geth redis postgres
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

Run a member node:

```bash
go run ./cmd/main.go \
    --instance-id member-1 \
    --mode member \
    --leader-url http://localhost:8090 \
    --health-addr :8081
```

```text
level=INFO msg="Starting consensus node" instanceID=member-1 mode=member
level=INFO msg="Member node started" leaderURL=http://localhost:8090
```

Once the leader finalizes blocks, the member syncs them:

```text
level=INFO msg="Synced blocks" count=1 latest=1
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
| Member loses leader connection | Retries every 100ms, catches up when reconnected |
| PostgreSQL unavailable | Leader logs warning, blocks still finalized on Geth |
| Redis unavailable | All nodes lose leadership, block production pauses |

## What's Next

We now have a distributed consensus system with leader election, durable storage, and horizontally scalable member nodes. In **Part 4: CometBFT Integration**, we'll replace the custom leader election with proper BFT consensus — multiple validators that agree on blocks through voting rounds.

---

*Full source code: [geth-consensus-tutorial](https://github.com/mikelle/geth-consensus-tutorial/tree/main/03-member-nodes) | Based on [mev-commit consensus layer](https://github.com/primev/mev-commit/tree/main/cl)*
