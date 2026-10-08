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
      │ (Cloudflare / Vercel)   │                 │ (OpenCode/Kilo/Cline)   │
      └─────────────────────────┘                 └─────────────────────────┘
```

## Module Layout (`src/`)

```
src/
├── catalog.ts         # 24h atomic disk caching + dynamic model enrichment
├── commands.ts        # /freeflow CLI commands and status bar widget
├── config.ts          # Constants, whitelists, paths, and runtime settings
├── deploy.ts          # Guided relay deploy (vercel/cloudflare/deno), in-memory tokens
├── health.ts          # Loopback-only /health endpoint handler
├── index.ts           # Extension bootstrap, provider registration, lifecycle hooks
├── logger.ts          # Structured, leveled, rotating file logger (10MB x 10)
├── models.ts          # 30 curated free model definitions and upstream mappings
├── probe.ts           # Relay reachability probe (HTTP 200 + latency)
├── proxy.ts           # Loopback HTTP proxy server on 28180 with master/worker reuse
├── relay.ts           # Multi-cloud relay fetch with failover and direct fallback
├── relay-state.ts     # Persistent relay pool state and ordering logic
├── stream-pipe.ts     # Resilient SSE stream pass-through with thinking sniffing
├── tool-args.ts       # Schema-driven repair of malformed model tool-call arguments
├── types.ts           # Core domain types, Pi/OMP ExtensionAPI and UI contracts
└── update-checker.ts  # Background version check + update notification
```

## Single-Port Master/Worker Architecture

When OMP dispatches parallel subagents, each spawns a child process. Rather than each binding its own port, pi-freeflow uses a cooperative master/worker protocol:

1. **Startup Probe**: On extension load, sends a lightweight probe to `http://127.0.0.1:28180/v1/models` (500ms timeout).
2. **Worker Reuse**: If the probe succeeds, the process reuses the existing master daemon — 0ms startup overhead.
3. **Master Daemon**: If the probe fails, the process binds port 28180 and becomes the master proxy.
4. **Race Guard**: Concurrent bind attempts on 28180 are handled gracefully — the loser re-probes and attaches to the winner.
5. **Stale-Daemon Heal**: On upgrade, an existing daemon may run older code (e.g. before an auth or routing fix). The health endpoint reports the daemon's internal version; if it mismatches the running package, the new session replaces the stale holder and binds fresh code — no manual kill or full host restart needed.
6. **Teardown**: Only the master process closes the HTTP listener on `session_shutdown`; workers exit cleanly.

## Atomic Disk Catalog Cache

To prevent network burst storms when multiple subagents boot simultaneously, the model catalog is cached to disk:

- **Location**: `~/.pi/agent/pi-freeflow-catalog-cache.json`
- **TTL**: 24 hours (86,400,000 ms)
- **Atomic Write**: Uses a temp file + `fs.renameSync` to prevent corruption under concurrent writes
- **Boot Speed**: Subagents load all 30 models from disk cache in ~0.1ms

## Stream Lifecycle Safety

- **Zero-buffering SSE**: `res.flushHeaders()` and `res.write()` ensure tokens stream immediately
- **Disconnect cleanup**: `req.on("close")`, `req.on("error")` immediately destroy upstream streams
- **Proxy timeout**: 300 seconds (5 minutes) for heavy prompt evaluations

## Tool-Call Argument Repair

Free models reliably lose tool-argument fidelity once a request carries a full
agent tool inventory. Measured live against OpenCode Zen with the real host
`todo` schema: with one tool the same model emitted canonical arguments, but at
roughly seventy tools it returned the phases JSON-encoded into the wrong field,
wrapped in an extra object, or under names the schema never declared — so the
host rendered every phase as one raw JSON string instead of real task lines.

`src/tool-args.ts` repairs those packets against the schema the caller itself
declared, so the fix is schema-driven rather than a per-model quirk list:

- **Envelope unwrap** — a declared array that arrived wrapped in a single-key
  object (`items: { item: [...] }`) is unwrapped.
- **JSON-string decode** — a declared object or array that arrived as a JSON
  string is parsed. Declared `string` properties are never decoded.
- **Role-based promotion** — invented keys are moved onto the declared
  properties they left missing, but only when every key has exactly one
  structurally compatible target. Nothing is matched by name similarity, and
  an ambiguous element discards the whole move.

Arguments change only when the result validates against the declared schema.
Well-formed calls stay byte-identical, tools without structured parameters are
never buffered (so their arguments still stream incrementally), and truncated
JSON is never completed. The repair runs on all three wire shapes, streamed and
aggregated, for every supported upstream.
