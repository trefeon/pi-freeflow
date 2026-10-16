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
      ┌─────────────────────────────────────┐                 ┌─────────────────────────────────────┐
      │        Sticky Rolling Relay         │ ──(Failover)──► │           Direct Upstream           │
      │ (Cloudflare / Vercel / Deno Deploy) │                 │ (OpenCode/Kilo/Cline/OVHcloud)      │
      └─────────────────────────────────────┘                 └─────────────────────────────────────┘
```

## Module Layout (`src/`)

```
src/
├── catalog.ts               # 24h atomic disk caching + dynamic model enrichment
├── client.ts                # Client-side daemon lifecycle: attach, lease, heartbeat renewal
├── cline-accounts.ts        # Per-user Cline API key pool with in-order failover
├── cline-device-auth.ts     # Cline WorkOS device-flow login (authorize/poll/refresh)
├── commands.ts              # /freeflow CLI commands and status bar widget
├── config.ts                # Constants, whitelists, paths, and runtime settings
├── daemon.ts                # Detached proxy daemon process owning port 28180
├── deploy.ts                # Guided relay deploy (vercel/cloudflare/deno), in-memory tokens
├── health.ts                # Loopback-only /health endpoint handler
├── index.ts                 # Extension bootstrap, provider registration, lifecycle hooks
├── lease.ts                 # Client lease registry and heartbeat expiry for daemon retirement
├── logger.ts                # Structured, leveled, rotating file logger (10MB x 10)
├── models.ts                # 37 curated free model definitions and upstream mappings
├── opencode-fingerprint.ts  # Zen free-tier fingerprint enforcement + SSE stream aggregation
├── probe.ts                 # Relay reachability probe (HTTP 200 + latency)
├── proxy.ts                 # Loopback HTTP proxy server on 28180 with master/worker reuse
├── relay.ts                 # Multi-cloud relay fetch with failover and direct fallback
├── relay-state.ts           # Persistent relay pool state and ordering logic
├── responses.ts             # Responses-API reasoning portability for rejected encrypted blobs
├── stream-pipe.ts           # Resilient SSE stream pass-through with thinking sniffing
├── system-ca-fetch.ts       # Cline fetch that falls back to the OS trust store under TLS interception
├── tool-args.ts             # Schema-driven repair of malformed model tool-call arguments
├── tool-translation.ts      # Tool schema translation across the chat, responses and messages wire shapes
├── types.ts                 # Core domain types, Pi/OMP ExtensionAPI and UI contracts
├── update-checker.ts        # Background version check + update notification
├── updater.ts               # /freeflow update package-manager choice (host first, global fallback)
└── upstream-health.ts       # Zen gating detection with failover to a healthy Kilo model
```

## Single-Port Master/Worker Architecture

When OMP dispatches parallel subagents, each spawns a child process. Rather than each binding its own port, pi-freeflow uses a cooperative master/worker protocol:

1. **Startup Probe**: On extension load, sends a lightweight probe to `http://127.0.0.1:28180/v1/models` (1500ms timeout).
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
- **Boot Speed**: Subagents load all 37 models from disk cache in ~0.1ms

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
Well-formed calls stay byte-identical and truncated JSON is never completed. The
repair runs on all three wire shapes, streamed and aggregated, for every
supported upstream.

### Prefix glue

Some models open a call by echoing the tail of the one they just saw, so a
single argument string arrives as `<tail of the previous call>{"…this call…"}`
and the host rejects it outright. The proxy locates the caller's own object
behind the junk and hands that back, with the same rules that keep the salvage
honest:

- The junk usually ends mid-string, so the scan tracks brace depth only — string
  state would classify the whole real call as "inside a string".
- A brace that sits behind a declared key is never promoted, so an inner object
  cannot replace the wrapper that declares it.
- A truncated number literal (`"timeout":18`, of `180`) is refused rather than
  completed; so is a cut inside a string.

This runs against the caller's own schema for **every** tool that declares
parameters, not only tools with a nested object or array: the most common host
tool, `bash`, declares nothing but scalars, and the glue hits it as hard as it
hits a planning tool. Where arguments must be buffered to be judged whole, the
buffer is flushed when the stream ends even if the terminal event never arrived,
so a cut stream still delivers the calls it announced.

## Tool Name Mapping

`src/tool-translation.ts` reshapes whatever either host declares into the shape
the target path expects. Caller tools are never dropped, and only two rewrites
ever happen:

- Pi's `find` rides upstream as `glob` **on the free tier alone**, whose gate
  looks for a sextet with that name in its `glob` slot — and only when the
  caller left the slot empty. OMP declares **both** (`glob` for file patterns,
  `find` for semantic search), and renaming there would collapse two real tools
  into one under the other's schema.
- Every other lane rides the caller's own names in **both** directions. There
  the rename is pure loss: the upstream would have accepted `find`, and the host
  gets `find` back and dispatches it natively.
- Names outside `^[a-zA-Z0-9_.-]+$` are folded, because upstream rejects the
  whole request otherwise.

Every rewrite is recorded per request and undone on the way back, on all three
wire shapes and on every upstream lane — a tool call that arrives under a name
the host never registered cannot be dispatched at all.
