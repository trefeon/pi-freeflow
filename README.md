# pi-freeflow 🌊

> **28 free models. Up to 1M context. Zero API keys. Infinite scale via your own relay pool.**

Thin by design: model list + dumb relay + log. Host `pi-ai` owns thinking, normalization & provider magic. We just make it free, fast, and unbreakable.

[![npm version](https://img.shields.io/npm/v/pi-freeflow?style=flat-square&color=00E5FF)](https://www.npmjs.com/package/pi-freeflow)
[![npm downloads](https://img.shields.io/npm/dm/pi-freeflow?style=flat-square)](https://www.npmjs.com/package/pi-freeflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Pi](https://img.shields.io/badge/Powered%20by-Pi-7c3aed?style=flat-square)](https://github.com/badlogic/pi-ai)
[![Oh My Pi](https://img.shields.io/badge/Compatible-OMP-black?style=flat-square)](https://github.com/coder/oh-my-pi)

Join devs bypassing rate limits with their own relay pools. BYO, add as many as you need.

---

### Features at a Glance

| Feature | Description | Value | Cost |
| :--- | :--- | :--- | :--- |
| **28 Curated Free Models** | 8 OpenCode Zen + 20 KiloCode Gateway models, up to 1M context & 512K output | Ceiling Unlocked | **$0** |
| **BYO Relay Pool** | Round-robin load balancing across your Cloudflare Workers & Vercel Edges | Zero Rate Limits | **$0** (your free tiers) |
| **Adaptive Health & Error Detection** | Auto-cooldown on 429 rate limits, 504 timeouts, and socket drops | 0ms Wasted Latency | **$0** |
| **Stream Truncation Resilience** | Stateful SSE terminal tracking (`response.failed` / `response.incomplete` injection) | Zero Host Crashes | **$0** |
| **Smart Model Aliasing** | Clean slash-free & colon-free CLI model names compatible with thinking selectors | DX Optimized | **$0** |
| **Auto-Enabled on Session** | Relay stays enabled in `auto` mode on session start and model switch | Zero Friction | **$0** |
| **Interactive CLI Management** | 10+ `/freeflow` subcommands (`status`, `list`, `use`, `add`, `label`, `remove`, `deploy`, `logs`, `debug`) | Full Control | **$0** |
| **Dumb Proxy That Never Breaks** | `127.0.0.1:28180`, host-normalized, pathname-guarded `/v1/models` | 100% Uptime | **$0** |
| **Observable Real Logs** | `~/.pi/agent/pi-freeflow.log`, 10MB auto-rotation, real-time debug toggle | Observable | **$0** |

Philosophy: **Thin by design.** We only ship model list + relay proxy + log. Host owns thinking & normalization.

---

### 28 Curated Models, One Command

```bash
/model → freeflow → pick
```

#### OpenCode Zen (7 Models), Responses & Chat API
Optimized for deep reasoning, long-horizon coding & autonomous agentic workflows.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `muse-spark-1.2-contributor-free` | Meta Superintelligence Labs | **1M** (1.048.576) | **131K** (131.072) | `minimal … xhigh` | ✅ |
| `mimo-v2.5-free` | Xiaomi MiMo | **1M** (1.048.576) | **131K** (131.072) | `minimal … xhigh`\* | ✅ |
| `laguna-s-2.1-free` | Poolside | **262K** (262.144) | **32K** (32.768) | `minimal … xhigh` | ❌ |
| `nemotron-3.5-lightning-free` | NVIDIA | **1M** (1.000.000) | **262K** (262.144) | `minimal … xhigh` | ❌ |
| `nemotron-3-ultra-free` | NVIDIA | **1M** (1.000.000) | **128K** (128.000) | `minimal … xhigh` | ❌ |
| `hy3-free` | Tencent Hunyuan | **262K** (262.144) | **128K** (128.000) | `minimal … xhigh` | ❌ |
| `big-pickle` | Big Pickle | **200K** (200.000) | **32K** (32.000) | `high / max` | ❌ |

#### KiloCode Gateway (18 Models), OpenRouter Compatible
Keyless access with `Bearer kilo-free`. Clean slash-free and colon-free CLI aliases supported.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dots-3-note-preview` (`dots-studio/...:free`) | Dots Studio | **512K** (512.000) | **512K** (512.000) | `minimal…xhigh`\* | ✅ |
| `step-3.7-flash` (`stepfun/...:free`) | StepFun | **262K** (262.144) | **262K** (262.144) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-nano-omni` (`nvidia/...:free`) | NVIDIA | **256K** (256.000) | **131K** (131.072) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-ultra-550b` (`nvidia/...:free`) | NVIDIA | **1M** (1.000.000) | **128K** (128.000) | `minimal…xhigh`\* | ❌ |
| `nvidia/nemotron-3.5-lightning:free` | NVIDIA | **1M** (1.000.000) | **262K** (262.144) | `minimal…xhigh`\* | ❌ |
| `nemotron-3-super` (`nvidia/...:free`) | NVIDIA | **262K** (262.144) | **262K** (262.144) | `minimal…xhigh`\* | ❌ |
| `hy3:free` (`tencent/hy3:free`) | Tencent Hunyuan | **262K** (262.144) | **128K** (128.000) | `minimal…xhigh`\* | ❌ |
| `north-mini-code` (`cohere/...:free`) | Cohere | **256K** (256.000) | **64K** (64.000) | `minimal…xhigh`\* | ❌ |
| `laguna-s-2.1:free` (`poolside/...:free`) | Poolside | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `laguna-xs-2.1:free` (`poolside/...:free`) | Poolside | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `lfm-2.5` (`liquid/lfm-2.5-2.6b:free`) | Liquid AI | **65K** (65.536) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `kilo-auto` (`kilo-auto/free`) | Kilo Gateway Auto | **256K** (256.000) | **10K** (10.000) | `minimal…xhigh`\* | ❌ |
| `openrouter` (`openrouter/free`) | OpenRouter Free | **200K** (200.000) | **65K** (65.536) | `minimal…xhigh`\* | ✅ |
| `content-safety` (`nvidia/...:free`) | NVIDIA | **128K** (128.000) | **8K** (8.192) | ❌ *(non-thinking)* | ✅ |
| `longcat-2.0` (`meituan/longcat-2.0-free`) | Meituan | **1M** (1.048.756) | **262K** (262.144) | `minimal…xhigh`\* | ❌ |
| `minimax-m2.7` (`minimax/minimax-m2.7:free`) | MiniMax | **196K** (196.608) | **196K** (196.608) | `minimal…xhigh`\* | ❌ |
| `minimax-m3` (`minimax/minimax-m3:free`) | MiniMax | **1M** (1.048.576) | **512K** (524.288) | `minimal…xhigh`\* | ❌ |
| `ling-3.0-flash-fin` (`inclusionai/ling-3.0-flash-fin:free`) | Inclusion AI | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |

\* Levels are forwarded as-is through the OpenRouter-style nested `reasoning` parameter; effort mapping is decided by each model. (Verified live 2026-08-29: hy3 accepts flat `reasoning_effort`/nested `reasoning` and returns thinking — README previously said otherwise.) MiMo collapses `minimal→low` and `xhigh→high` upstream, so its selector shows 5 labels but only 3 distinct effort values.

---

### How It Works: BYO Relays, Zero Rate Limits

```
You → 127.0.0.1:28180 (dumb proxy, host-normalized) → x-relay-target → N egress IPs (your pool) → opencode.ai / api.kilo.ai
                                     ↑ host already normalized thinking → proxy just forwards
```

1. **Per-Request Round-Robin**: 10 parallel subagents hit N different egress IPs (your pool size). No thundering herd.
2. **Adaptive Health & Error Cooldown**: Relays hitting 429, 504, or socket disconnects enter temporary cooldown (30-90s) and automatically move behind healthy candidates. Healthy relays handle traffic with 0ms wasted delay.
3. **Seamless 429 Roll**: `429 / 408 / 502 / 503 / 504 / 520-530` → instant roll to next relay, never 429 to agent.
4. **Stream Truncation Resilience**: Stateful SSE terminal tracking prevents fatal unhandled stream closed errors when connections drop.
5. **Direct Fallback Safety Net**: If all relays in the pool are exhausted, transparent direct fetch to upstream.
6. **Zero Subagent Connect Errors**: 24h `DISK_CACHE_ONLY` model catalog avoids subagents hammering remote catalogs.

You bring the relays (free tiers). We bring the rolling.

---

### Interactive Commands Reference (`/freeflow`)

Manage your relay pool directly from the OMP / Pi terminal:

```bash
/freeflow status                  # View active relay, pool status, and candidates
/freeflow list                    # List all relays with real-time health badges (✓ / ⚠️ [cooling])
/freeflow use <url|index|label>   # Switch active relay
/freeflow url <url>               # Set the active relay URL directly
/freeflow add <url> [label]       # Add new relay to the pool
/freeflow label <index|url> <name># Assign a friendly label to a relay
/freeflow remove <index|url|label># Remove a relay from the pool
/freeflow test <index|url|label>  # Probe a relay for reachability (HTTP 200 + latency)
/freeflow on | off | auto         # Toggle relay mode (auto = enabled for freeflow)
/freeflow deploy <platform>       # Guided relay deploy: vercel|cloudflare|deno — token in-memory, auto-adds (Vercel 1M/mo recommended)
/freeflow logs [lines]            # Inspect recent proxy logs
/freeflow trace [req-id]          # Tail logs filtered by request correlation ID
/freeflow refresh                 # Reload the model catalog from live upstreams
/freeflow update                  # Check for and install a package update
/freeflow debug on | off          # Toggle full HTTP lifecycle debug logging
/freeflow kill                    # Stop the shared proxy daemon now (restarts on next use)
```

---

### Quick Start in 30 Seconds

**On Oh My Pi (OMP):**
```bash
omp plugin install pi-freeflow
# or local dev (repo checkout)
omp plugin link /path/to/pi-freeflow
```

**On Pi:**
```bash
pi install npm:pi-freeflow
```

> Both commands fetch the **same npm package** from the registry — pi-freeflow
> is an extension loaded by the host, not a standalone CLI. It works on **OMP
> and Pi only** (they share the extension API).

#### 2. Pick a Model

**OMP — interactive:**
```bash
omp
/model → freeflow → muse-spark-1.2-contributor-free (1M) → max
```

**OMP — one-shot CLI:**
```bash
omp -p --model freeflow/muse-spark-1.2-contributor-free "build me a SaaS"
omp -p --model freeflow/step-3.7-flash:high "solve this bug"   # alias + thinking level
```

**Pi — interactive:**
```bash
pi
/model → freeflow → pick
```

**Pi — one-shot CLI:**
```bash
pi -p --model freeflow/step-3.7-flash:high "solve this bug"
```

> Model IDs accept a full canonical ID, a short alias (see the tables above),
> and an optional `:effort` suffix (`:minimal` … `:xhigh`, `:max` where
> supported). The host resolves the rest — you only type `freeflow/<name>`.

#### 3. Manage Your Relay Pool (OMP & Pi both)

```bash
/freeflow status     # active relay, pool status, candidates
/freeflow list       # relays with health badges
/freeflow add <url> [label]
/freeflow deploy     # guided deploy: vercel|cloudflare|deno
/freeflow logs [n]   # tail proxy logs
```

These slash commands work **identically in OMP and Pi** — the extension
registers the same `/freeflow` command set in both hosts.
#### 4. Add Your Free Relays (Scale Infinitely)

Default ships direct. Add relays via `/freeflow add <url> [label]`.

**Zero setup?** Run `/freeflow deploy cloudflare` (or `deno`, `vercel`), paste your platform token once, and the relay is created and activated for you. Manual snippets below.

**Option A: Cloudflare Workers (100k req/day, no 25s timeout) — Auto Deploy**
```bash
/freeflow deploy cloudflare  # prompts token in-memory, auto-adds to pool
```
*Manual fallback:* `dash.cloudflare.com` → Workers → Create → Deploy → Edit code → paste the canonical worker source (see "Canonical worker source" below) → Deploy → `/freeflow add https://your.workers.dev cf-worker-1`

**Option B: Vercel Edge Relay (1M req/mo) — Auto Deploy**
```bash
/freeflow deploy vercel  # prompts token in-memory, auto-adds to pool
# or shorthand: /freeflow deploy
```
*Manual fallback:* Push 2 files (`api/relay.js` + `vercel.json`) to GitHub $\to$ Import on `vercel.com` $\to$ `/freeflow add https://your.vercel.app vercel-relay-1`

For `api/relay.js`, use the canonical worker source (see below); `vercel.json` stays:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/api/relay" }] }
```

**Option C: Deno Deploy (100k req/day) — Auto Deploy**
```bash
/freeflow deploy deno  # prompts token in-memory, auto-adds to pool
```
*Manual fallback:* `dash.deno.com` → New Project → Playground → paste the canonical worker source (see below) → Deploy → `/freeflow add https://your-project.deno.dev deno-relay-1`

**Canonical worker source (all platforms)**

The relay worker template is generated per deployment by `/freeflow deploy` and lives in [`src/deploy.ts`](src/deploy.ts): one hardened core plus thin Vercel / Cloudflare / Deno wrappers. Every deployment embeds its own shared secret and enforces the target allowlist (`https://opencode.ai`, `https://api.kilo.ai`), SSRF/private-host guard, relay-path validation, and a header denylist — `x-relay-auth` is checked by the worker and never forwarded upstream.

```js
// Minimal Cloudflare illustration. Prefer /freeflow deploy: the generated
// worker (src/deploy.ts) is the signed/hardened source for all three
// platforms. This example omits the SSRF guard, path validation, and auth.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
export default {
  async fetch(req) {
    const target = req.headers.get("x-relay-target");
    const relayPath = req.headers.get("x-relay-path") || "/";
    if (!target || !ALLOWED_TARGETS.includes(target.replace(/\/$/, ""))) {
      return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403 });
    }
    const headers = new Headers(req.headers);
    headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
    return fetch(target.replace(/\/$/, "") + relayPath, { method: req.method, headers, body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined });
  },
};
```

**Verify your pool:**
```bash
/freeflow status        # relay-A 1/N (ON) → candidates:N
/freeflow list          # lists all relays with health status
/freeflow logs          # tail -25
cat ~/.pi/agent/pi-freeflow.log | tail -n 20
```

---

### Logs & Debugging

```bash
/freeflow logs
cat ~/.pi/agent/pi-freeflow.log | tail -n 50

# debug toggle
/freeflow debug on
```

Log rotation at 10MB. Clean, parseable, real-time HTTP lifecycle tracking.

---

### Design

This package stays thin. It ships three things: a model catalog, a relay proxy, and a log. There is no build step. Zero runtime dependencies — uses native Node.js global fetch. Thinking and prompt normalization stay with the host (`pi-ai`).

Current size: about 11.3k lines including tests. The full suite (sandboxed, mocked network) and typecheck pass before every release — see CHANGELOG.md.

---

### FAQ

**Do I need API keys?**
No. Kilo uses `Bearer kilo-free`, OpenCode free models are anonymous (no header needed).

**What if all relays are 429?**
Proxy tries direct. If that is also 429, Pi shows the rate limit. That number is the global upstream cap; without relays you would hit the same wall.

**Can I use without relays?**
Yes. `/freeflow off` → direct. Add relays later to scale.

**What happens when I update to a new version?**
The local proxy daemon is shared across sessions on port 28180. On upgrade, the new extension
detects a stale daemon (mismatched internal version) and replaces it automatically — no manual
kill, no restart of other sessions required. Replacement only happens when the running daemon is
idle: sessions with in-flight requests are never interrupted (busy or newer daemons are reused
with a log note instead). If a daemon cannot be replaced (e.g. port held by an unrelated process),
it falls back to reusing it with a warning. To disable replacement entirely, set the no-kill env
to `1` before starting a session.

**What happens when I close a session?**
Nothing visible to your other sessions. The proxy daemon is a separate background
process shared by every OMP/Pi session on the machine. Closing one session just
unregisters it; the daemon keeps serving the rest and retires itself automatically
once the last client disconnects and it has been idle for a short grace period.
To stop it manually, run `/freeflow kill` — the next freeflow use starts it again.

**Where's the normalizer?**
Deleted in 1.3.0. If zai/qwen/deepseek thinking broke before, it's fixed now because host handles it.

**Why is context free?**
We use OpenCode Zen & Kilo free tiers. You pay only with your own Cloudflare/Vercel free tiers for egress.
**Why is it installed via npm?**
The npm package is the **distribution channel** only — both hosts resolve it internally:
`omp plugin install pi-freeflow` and `pi install npm:pi-freeflow` install the same
package from the npm registry. pi-freeflow is an **extension, not a standalone CLI** —
the host (OMP or Pi) loads and runs it. A plain `npm install` just downloads the
files; it is not a supported way to run the extension.

**Which hosts can use it?**
Oh My Pi (OMP) and Pi only. They share the same extension API
(`extensions/index.ts` declares both `omp` and `pi` extension entries), so one
package serves both. Other AI agents (OpenCode, KiloCode, Cursor, ...) have their
own plugin systems and do not load this extension.

---

### Contributing

Contributions welcome — bug fixes, new relay platforms, model additions, docs improvements.

#### Prerequisites

- **Node.js ≥ 22.19.0** (uses `--experimental-strip-types`, no build step)
- **pnpm** (package manager)

#### Setup & Verify

```bash
git clone https://github.com/trefeon/pi-freeflow
cd pi-freeflow
pnpm install

# run all three before opening a PR
pnpm test        # full suite; sandboxed + network-mocked
pnpm typecheck   # tsc --noEmit, must pass clean
pnpm smoke       # verifies extensions/index.ts loads without crashing
```

#### Project Structure

```
src/
├── index.ts          # extension entry, lifecycle hooks
├── models.ts         # 28-model catalog definitions
├── catalog.ts        # model catalog cache (24h disk)
├── proxy.ts          # local proxy server (127.0.0.1:28180)
├── relay.ts          # relay selection & round-robin
├── relay-state.ts    # relay pool state, health tracking
├── rate-limiter.ts   # in-memory sliding rate limiter (200/day, 200/hour)
├── stream-pipe.ts    # SSE stream piping & truncation resilience
├── commands.ts       # /freeflow CLI subcommands
├── deploy.ts         # guided relay deploy (vercel/cloudflare/deno)
├── config.ts         # constants, whitelists, paths, and runtime settings
├── logger.ts         # file logger with 10MB rotation
└── types.ts          # shared type definitions
extensions/
└── index.ts          # OMP/Pi extension manifest
test/
└── *.test.ts         # mirrors src/, node:test runner
```

#### Guidelines

- **Stay thin.** Zero runtime dependencies, no build step. If it belongs in the host (`pi-ai`), don't add it here.
- **Test what you touch.** Every `src/*.ts` has a matching `test/*.test.ts`. Add or update tests for your change.
- **Keep model IDs clean.** Slash-free, colon-free aliases for CLI compatibility. See existing patterns in `models.ts`.
- **One concern per PR.** Bug fix? One PR. New relay platform? Separate PR. Easier to review, faster to merge.

#### Reporting Issues

Found a bug or want a feature? [Open an issue](https://github.com/trefeon/pi-freeflow/issues) with:
- What happened vs what you expected
- Your relay setup (`/freeflow status` output helps)
- Relevant logs (`/freeflow logs` or `~/.pi/agent/pi-freeflow.log`)

---

### License

MIT © trefeon

