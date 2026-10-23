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
├── atomic-write.ts          # Atomic file writes: temp file + rename, retried across Windows locks
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
├── models.ts                # 35 curated free model definitions and upstream mappings
├── opencode-fingerprint.ts  # Zen free-tier fingerprint enforcement + SSE stream aggregation
├── probe.ts                 # Relay reachability probe (HTTP 200 + latency)
├── proxy.ts                 # Loopback HTTP proxy server on 28180 with master/worker reuse
├── relay.ts                 # Multi-cloud relay fetch with failover and direct fallback
├── relay-state.ts           # Persistent relay pool state and ordering logic
├── responses.ts             # Responses-API reasoning portability for rejected encrypted blobs
├── stream-pipe.ts           # Resilient SSE stream pass-through with thinking sniffing
├── system-ca-fetch.ts       # Cline fetch that falls back to the OS trust store under TLS interception
├── token.ts                 # Per-installation loopback token: create/read + constant-time bearer check
├── tool-args.ts             # Schema-driven repair of malformed model tool-call arguments
├── toolcall-audit.ts        # Local JSONL trail of failed/retried tool-call turns
├── tool-translation.ts      # Tool schema translation across the chat, responses and messages wire shapes
├── types.ts                 # Core domain types, Pi/OMP ExtensionAPI and UI contracts
├── update-core.ts           # Version facts and step runner shared by the update checker and updater
├── update-checker.ts        # Background version check + update notification
├── updater.ts               # /freeflow update package-manager choice (host first, global fallback)
└── upstream-health.ts       # Zen gating detection with failover to a healthy Kilo model
```

## Single-Port Master/Worker Architecture

When OMP dispatches parallel subagents, each spawns a child process. Rather than each binding its own port, pi-freeflow uses a cooperative master/worker protocol:

1. **Startup Probe**: On extension load, sends a lightweight probe to `http://127.0.0.1:28180/health` (150ms timeout on the attach path; the generic liveness probe defaults to 600ms) and requires the daemon identity body — `service: "pi-freeflow"` plus the port it is bound to — so a stranger on the port cannot claim it.
2. **Worker Reuse**: If the probe succeeds, the process reuses the existing master daemon — 0ms startup overhead.
3. **Master Daemon**: If the probe fails, the process binds port 28180 and becomes the master proxy.
4. **Race Guard**: Concurrent bind attempts on 28180 are handled gracefully — the loser re-probes and attaches to the winner.
5. **Stale-Daemon Heal**: On upgrade, an existing daemon may run older code (e.g. before an auth or routing fix). The health endpoint reports the daemon's internal version; if it mismatches the running package, the new session replaces the stale holder and binds fresh code — no manual kill or full host restart needed.
6. **Teardown**: Only the master process closes the HTTP listener on `session_shutdown`; workers exit cleanly.

## Local Proxy Security

The daemon binds loopback only (`127.0.0.1`), and every request to it carries a
per-machine bearer token:

- **Token file**: `<data dir>/token` — 32 random bytes as 64 hex characters, no
  trailing newline, written with mode `0600`. The data dir is
  `$PI_FREEFLOW_DATA_DIR`, else `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`; the
  proxy creates the file at startup if it is missing.
- **Required header**: `Authorization: Bearer <token>` on every `/v1/*` route
  **and** every `/_*` route (`/_health`, `/_shutdown`,
  `/_client/attach|heartbeat|detach`). A missing or wrong token answers
  `401 {"error":"unauthorized"}`; a request whose `Host` is not
  `127.0.0.1[:port]`, `localhost[:port]` or `[::1][:port]` answers
  `403 {"error":"forbidden host"}`.
- **Exception**: `GET /health` stays unauthenticated and returns only
  `{"ok":true,"service":"pi-freeflow","port":28180,"version":"<package version>"}`.
  It is the identity probe other sessions use to detect a live daemon. The rich
  `/_health` snapshot now requires the token.

Hosts never handle this by hand: `buildProviderConfig` sets the host provider's
`apiKey` to the proxy token, so OMP/Pi send `Authorization: Bearer <token>`
automatically, and the proxy strips that client authorization before going
upstream. Any **external** tool talking to the proxy must read the file itself:

```bash
# Linux / macOS / Git Bash. On Windows: $(cat "$USERPROFILE/.pi/agent/token")
curl http://127.0.0.1:28180/v1/models \
  -H "Authorization: Bearer $(cat ~/.pi/agent/token)"
```

The unauthenticated liveness probe needs no header:

```bash
curl http://127.0.0.1:28180/health
# {"ok":true,"service":"pi-freeflow","port":28180,"version":"<package version>"}
```

## Configuration (Environment Variables)

Runtime knobs, all read in `src/config.ts`. "Unset" means the default applies.

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `PI_FREEFLOW_PORT` | `28180` | Loopback port the proxy binds; values outside 1–65535 are ignored. |
| `PI_FREEFLOW_DATA_DIR` | `$PI_CODING_AGENT_DIR` → `~/.pi/agent` | Re-roots every pi-freeflow data file (token, log, caches, relay state). |
| `PI_FREEFLOW_ALLOW_UNSAFE_RELAY` | unset | **Unsafe.** When `1`, accepts `http://` and private-host relay URLs (tests/dev). It opens the relay allowlist to SSRF-shaped targets — do not set it in normal use. |
| `PI_FREEFLOW_NO_KILL` | unset | When `1`, never replace a version-mismatched (stale) daemon. |
| `PI_FREEFLOW_DAEMON_SPAWN` | enabled | When `0`, never spawn a detached proxy daemon (tests/CI only). |
| `PI_FREEFLOW_DAEMON_RUNTIME` | auto | Explicit node/bun executable path for the detached daemon. |
| `PI_FREEFLOW_DAEMON_TTL_MS` | `30000` | Client lease TTL; expired leases are dropped by the daemon GC. |
| `PI_FREEFLOW_DAEMON_HEARTBEAT_MS` | `8000` (Windows) / `10000` | Client heartbeat interval (kept well under the lease TTL). |
| `PI_FREEFLOW_DAEMON_GC_MS` | `5000` | Daemon lease-GC sweep interval. |
| `PI_FREEFLOW_DAEMON_GRACE_MS` | `15000` (Windows) / `10000` | Lease-less persistence window before the daemon exits. |
| `PI_FREEFLOW_DAEMON_READY_TIMEOUT_MS` | `5000` | How long a client waits for a freshly spawned daemon to answer `/_health`. |
| `PI_FREEFLOW_DAEMON_CONTROL_TIMEOUT_MS` | `3000` (Windows) / `1500` | Timeout for one loopback control call (attach/heartbeat/detach). |
| `PI_FREEFLOW_DAEMON_WATCHDOG_MS` | `5000` | How often the client polls `/_health` for version + failed-SSE rate. |
| `PI_FREEFLOW_OPENCODE_USER_AGENT` | live npm lookup | Pin the exact `opencode/<version>` UA (or bare version) sent upstream. |
| `PI_FREEFLOW_OPENCODE_VERSION_CACHE` | beside the update cache | Override the UA-probe cache file location. |
| `PI_FREEFLOW_CLINE_POOL_FILE` | beside the relay state file | Override the per-user Cline login pool file. |
| `PI_FREEFLOW_CLINE_WORKOS_CLIENT_ID` | bundled default | Override the Cline/WorkOS client id used for browser login. |

## Atomic Disk Catalog Cache

To prevent network burst storms when multiple subagents boot simultaneously, the model catalog is cached to disk:

- **Location**: `~/.pi/agent/pi-freeflow-catalog-cache.json`
- **TTL**: 24 hours (86,400,000 ms)
- **Atomic Write**: Uses a temp file + `fs.renameSync` to prevent corruption under concurrent writes
- **Boot Speed**: Subagents load all 35 models from disk cache in ~0.1ms

## Stream Lifecycle Safety

- **Zero-buffering SSE**: `res.flushHeaders()` and `res.write()` ensure tokens stream immediately; only complete SSE blocks are forwarded, so a network chunk boundary never splits JSON
- **Disconnect cleanup**: `req.on("close")`, `req.on("error")` immediately destroy upstream streams
- **Header wait**: 300 seconds (5 minutes) — bounds only the wait for response headers, never the streamed body. A silent body is cut after 120s of byte silence and the turn is re-fired once on a sibling relay

### Relay failover across the stream lifecycle

The commit point is the first upstream **body byte**, not the response headers. Before it, relay rotation is invisible; after it, the turn is continued rather than restarted where that is safe.

| Phase | Client sees | What the proxy does |
| :--- | :--- | :--- |
| Before upstream headers | nothing | `relayFetch` rolls 429/5xx candidates; the proxy writes `200` only after a relay accepts, so the SSE client never sees an intermediate 429 |
| SSE open, no tool call | may include partial text | A 429 error frame is held, the relay is marked cooling (HTTP 429), and the request is re-fired once on a sibling; the held frame is dropped on success |
| Stream cut / socket death, no tool call | partial deltas | One silent re-fire (text-only turns); the replacement continues the same client response |
| Tool call already forwarded | partial deltas | No re-fire: replaying would re-execute the call. The authentic verdict (or a synthetic terminal) ends the turn |
| All candidates exhausted | one response | The genuine rate-limit/error verdict is surfaced once and the response is terminated; there is no silent retry loop |

SSE has no replay or byte-range semantics. A re-fire therefore starts a fresh generation on the sibling relay; for text-only turns the client keeps its partial output and the turn continues, while tool-call turns stay terminal by design. Hard quota, billing, auth, and malformed-request verdicts never trigger a re-fire.

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

## Tool-Call Audit Log

A turn that declared tools leaves a local record of how it ended, so a turn the
host abandoned or retried can be attributed without reproducing it.

- **Path**: `<data dir>/toolcall-audit.jsonl` (`$PI_FREEFLOW_DATA_DIR`, else
  `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). At 5 MiB the file rotates once to
  `toolcall-audit.jsonl.1`; every write is caught, so the audit can never fail a
  request (writes are synchronous, one bounded line per event). A turn that
  declared no tools writes nothing. Retained argument characters are capped at
  256 KiB per call and 8 MiB per turn; `argsBytes` still reports the true size.
- **Event kinds**:
  - `summary` — one line per turn that ended: `ts`, `kind`, `reqId`, `model`,
    `lane` (`opencode` | `kilo` | `cline` | `ovh`), `wire` (`chat` | `responses`
    | `messages`), `stream`, `attempt`, `retryOf`, `declared` (caller tool
    names), `calls` (`name`, `argsBytes`, `argsValid`, `known`), `finishReason`,
    `terminal`, `refireSkipped`, `repairs`, `failures`, `remap` (`none`,
    `tool-name`, `model`, or `unknown` for a body that carried no event stream
    to inspect).
  - `attempt-failure` — one line per upstream attempt abandoned in favour of
    another: `ts`, `kind`, `reqId`, `model`, `lane`, `attempt`, `reason`
    (`rate-limited`, `gateway-timeout`, `payload-too-large`, `relay-edge-404`,
    `deployment-disabled`, `retriable-status`, `server-error`,
    `relay-auth-rejected`, `relay-forbidden`, `header-timeout`, `network-error`,
    `invalid-relay-url`, or `final-upstream-status` for the request-level
    verdict such as a rejected tool schema), and `status` when HTTP headers
    arrived. Attempt numbers are 1-based and monotonic across the candidates
    and hedged legs of one relay send; `final-upstream-status` is a
    request-level verdict, not a roll, and carries `attempt: 0`.
  - `retry-detected` — a turn whose conversation the proxy already saw inside
    the retry window. `retryOf` names the earlier `reqId`; the earlier turn's
    `firstFailures` and `firstRepairs` are copied in so the retry carries its
    own cause.
- **Retry correlation**: the key is the conversation seed — request `model` plus
  `messages` (chat/responses input) plus `tools` — hashed into a 16-hex id and
  remembered for 10 minutes. The first turn of a conversation is `attempt: 1`
  with `retryOf: null`; every host re-send of the same conversation increments
  `attempt` and points `retryOf` at the turn before it. The in-flight turn is
  registered before it ends, so a re-send that races the first turn's teardown
  still chains to it (`firstOutcome` can then be `pending`). Turns without a
  body are never correlated.
- **Privacy**: the log carries names, sizes, booleans and reasons only. Message
  text, tool schemas and tool-argument values are never written — `calls[].argsBytes`
  is the payload size, not the payload.

```bash
# Which models fail tool turns most often, and why
jq -r 'select(.kind=="summary" and (.failures|length)>0) | "\(.model)\t\(.failures|join(","))"' \
  ~/.pi/agent/toolcall-audit.jsonl | sort | uniq -c | sort -rn

# Conversations the host retried, with the first attempt's cause
jq -c 'select(.kind=="retry-detected") | {reqId, retryOf, model, attempt, firstFailures}' \
  ~/.pi/agent/toolcall-audit.jsonl
```
