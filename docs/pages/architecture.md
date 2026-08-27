# System Architecture

## High-Level Topology

```
                      ┌────────────────────────────────────────┐
                      │          OMP Parent Session            │
                      │      (Master HTTP Proxy :28180)        │
                      └──────────────────┬─────────────────────┘
                                         │
                   ┌─────────────────────┼─────────────────────┐
                   ▼                     ▼                     ▼
           ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
           │  Sub-Agent 1  │     │  Sub-Agent 2  │     │  Sub-Agent 3  │
           │ (Reuses 28180)│     │ (Reuses 28180)│     │ (Reuses 28180)│
           └───────────────┘     └───────────────┘     └───────────────┘
                                         │
                   ┌─────────────────────┴─────────────────────┐
                   ▼                                           ▼
      ┌─────────────────────────┐                 ┌─────────────────────────┐
      │  Sticky Rolling Relay   │ ──(Failover)──► │     Direct Upstream     │
      │ (Cloudflare / Vercel)   │                 │ (OpenCode / Kilo)       │
      └─────────────────────────┘                 └─────────────────────────┘
```

## Module Layout (`src/`)

```
src/
├── types.ts           # Core domain types, Pi/OMP ExtensionAPI and UI contracts
├── config.ts          # Constants, whitelists, paths, and runtime settings
├── logger.ts          # Structured, leveled, rotating file logger (5MB x 3)
├── rate-limiter.ts    # In-memory sliding rate limiter
├── models.ts          # 21 curated free model definitions and upstream mappings
├── catalog.ts         # 1-hour atomic disk caching + dynamic model enrichment
├── relay-state.ts     # Persistent relay pool state and ordering logic
├── relay.ts           # Multi-cloud relay fetch with failover and direct fallback
├── deploy.ts          # In-memory Vercel Edge relay deployer (no persisted tokens)
├── normalizer.ts      # Payload normalization, reasoning translation
├── stream-pipe.ts     # Resilient SSE stream pass-through with thinking sniffing
├── proxy.ts           # Loopback HTTP proxy server on 28180 with master/worker reuse
├── commands.ts        # /pi-freeflow CLI commands and status bar widget
└── index.ts           # Extension bootstrap, provider registration, lifecycle hooks
```

## Single-Port Master/Worker Architecture

When OMP dispatches parallel subagents, each spawns a child process. Rather than each binding its own port, pi-freeflow uses a cooperative master/worker protocol:

1. **Startup Probe**: On extension load, sends a lightweight probe to `http://127.0.0.1:28180/v1/models` (500ms timeout).
2. **Worker Reuse**: If the probe succeeds, the process reuses the existing master daemon — 0ms startup overhead.
3. **Master Daemon**: If the probe fails, the process binds port 28180 and becomes the master proxy.
4. **Race Guard**: Concurrent bind attempts on 28180 are handled gracefully — the loser re-probes and attaches to the winner.
5. **Teardown**: Only the master process closes the HTTP listener on `session_shutdown`; workers exit cleanly.

## Atomic Disk Catalog Cache

To prevent network burst storms when multiple subagents boot simultaneously, the model catalog is cached to disk:

- **Location**: `~/.pi/agent/pi-freeflow-catalog-cache.json`
- **TTL**: 1 hour (3,600,000 ms)
- **Atomic Write**: Uses a temp file + `fs.renameSync` to prevent corruption under concurrent writes
- **Boot Speed**: Subagents load all 21 models from disk cache in ~0.1ms

## Stream Lifecycle Safety

- **Zero-buffering SSE**: `res.flushHeaders()` and `res.write()` ensure tokens stream immediately
- **Disconnect cleanup**: `req.on("close")`, `req.on("error")` immediately destroy upstream streams
- **Proxy timeout**: 300 seconds (5 minutes) for heavy prompt evaluations
