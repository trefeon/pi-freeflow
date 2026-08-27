# pi-freeflow 🌊

> **21 free models. Up to 1M context. Zero API keys. Infinite scale via your own relay pool.**

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
| **21 Curated Free Models** | 7 OpenCode Zen + 14 KiloCode Gateway models, up to 1M context & 512K output | Ceiling Unlocked | **$0** |
| **BYO Relay Pool** | Round-robin load balancing across your Cloudflare Workers & Vercel Edges | Zero Rate Limits | **$0** (your free tiers) |
| **Adaptive Health & Error Detection** | Auto-cooldown on 429 rate limits, 504 timeouts, and socket drops | 0ms Wasted Latency | **$0** |
| **Stream Truncation Resilience** | Stateful SSE terminal tracking (`response.failed` / `response.incomplete` injection) | Zero Host Crashes | **$0** |
| **Smart Model Aliasing** | Clean slash-free & colon-free CLI model names compatible with thinking selectors | DX Optimized | **$0** |
| **Auto-Enabled on Session** | Relay stays enabled in `auto` mode on session start and model switch | Zero Friction | **$0** |
| **Interactive CLI Management** | 10+ `/freeflow` subcommands (`status`, `list`, `use`, `add`, `label`, `remove`, `deploy`, `logs`, `debug`) | Full Control | **$0** |
| **Dumb Proxy That Never Breaks** | `127.0.0.1:28180`, host-normalized, pathname-guarded `/v1/models` | 100% Uptime | **$0** |
| **Observable Real Logs** | `~/.pi/agent/pi-freeflow.log`, 5MB auto-rotation, real-time debug toggle | Observable | **$0** |

Philosophy: **Thin by design.** We only ship model list + relay proxy + log. Host owns thinking & normalization.

---

### 21 Curated Models, One Command

```bash
/model → freeflow → pick
```

#### OpenCode Zen (7 Models), Responses & Chat API
Optimized for deep reasoning, long-horizon coding & autonomous agentic workflows.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `muse-spark-1.2-contributor-free` | Meta Superintelligence Labs | **1M** (1.048.576) | **131K** (131.072) | `minimal / low / medium / high / xhigh / max` | ✅ |
| `mimo-v2.5-free` | Xiaomi MiMo | **1M** (1.048.576) | **131K** (131.072) | `low / medium / high` | ✅ |
| `laguna-s-2.1-free` | Poolside | **1M** (1.048.576) | **131K** (131.072) | `low / high / max` | ❌ |
| `nemotron-3.5-lightning-free` | NVIDIA | **1M** (1.000.000) | **262K** (262.144) | `low / high / max` | ❌ |
| `nemotron-3-ultra-free` | NVIDIA | **1M** (1.000.000) | **128K** (128.000) | `low / high / max` | ❌ |
| `hy3-free` | Tencent Hunyuan | **262K** (262.144) | **262K** (262.144) | `low / high / max` | ❌ |
| `big-pickle` | Big Pickle | **200K** (200.000) | **32K** (32.000) | `high / max` | ❌ |

#### KiloCode Gateway (14 Models), OpenRouter Compatible
Keyless access with `Bearer kilo-free`. Clean slash-free and colon-free CLI aliases supported.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dots-3-note-preview` (`dots-studio/...:free`) | Dots Studio | **512K** (512.000) | **512K** (512.000) | `minimal…xhigh`\* | ✅ |
| `step-3.7-flash` (`stepfun/...:free`) | StepFun | **262K** (262.144) | **262K** (262.144) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-nano-omni` (`nvidia/...:free`) | NVIDIA | **256K** (256.000) | **65K** (65.536) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-ultra-550b` (`nvidia/...:free`) | NVIDIA | **1M** (1.000.000) | **65K** (65.536) | `minimal…xhigh`\* | ❌ |
| `nvidia/nemotron-3.5-lightning:free` | NVIDIA | **1M** (1.000.000) | **131K** (131.072) | `minimal…xhigh`\* | ❌ |
| `nemotron-3-super` (`nvidia/...:free`) | NVIDIA | **262K** (262.144) | **262K** (262.144) | `minimal…xhigh`\* | ❌ |
| `hy3:free` (`tencent/hy3:free`) | Tencent Hunyuan | **262K** (262.144) | **262K** (262.144) | ❌ *(none sent)* | ❌ |
| `north-mini-code` (`cohere/...:free`) | Cohere | **256K** (256.000) | **64K** (64.000) | `minimal…xhigh`\* | ❌ |
| `laguna-s-2.1:free` (`poolside/...:free`) | Poolside | **1M** (1.048.576) | **131K** (131.072) | `minimal…xhigh`\* | ❌ |
| `laguna-xs-2.1:free` (`poolside/...:free`) | Poolside | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `lfm-2.5` (`liquid/lfm-2.5-2.6b:free`) | Liquid AI | **128K** (128.000) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `kilo-auto` (`kilo-auto/free`) | Kilo Gateway Auto | **256K** (256.000) | **10K** (10.000) | ❌ *(non-thinking)* | ❌ |
| `openrouter` (`openrouter/free`) | OpenRouter Free | **200K** (200.000) | **65K** (65.536) | ❌ *(non-thinking)* | ✅ |
| `content-safety` (`nvidia/...:free`) | NVIDIA | **128K** (128.000) | **8K** (8.192) | ❌ *(non-thinking)* | ✅ |

\* Levels are forwarded as-is through the OpenRouter-style nested `reasoning` parameter; effort mapping is decided by each model. hy3 accepts no reasoning parameter today.

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
/freeflow add <url> [label]       # Add new relay to the pool
/freeflow label <index|url> <name># Assign a friendly label to a relay
/freeflow remove <index|url|label># Remove a relay from the pool
/freeflow on | off | auto         # Toggle relay mode (auto = enabled for freeflow)
/freeflow deploy <platform>       # Guided relay deploy: vercel|cloudflare|deno — token in-memory, auto-adds (Vercel 1M/mo recommended)
/freeflow logs [lines]            # Inspect recent proxy logs
/freeflow debug on | off          # Toggle full HTTP lifecycle debug logging
```

---

### Quick Start in 30 Seconds

#### 1. Install

**Oh My Pi (Recommended):**
```bash
omp plugin install pi-freeflow
# or local dev
omp plugin link /path/to/pi-freeflow
```

**Pi:**
```bash
pi install npm:pi-freeflow
```

#### 2. Pick a Model

```bash
omp
/model → freeflow → muse-spark-1.2-contributor-free (1M) → max

# or CLI
omp -p --model freeflow/muse-spark-1.2-contributor-free "build me a SaaS"
# or with short alias & thinking level
omp -p --model freeflow/step-3.7-flash:high "solve this bug"
```

#### 3. Add Your Free Relays (Scale Infinitely)

Default ships direct. Add relays via `/freeflow add <url> [label]`.

**Zero setup?** Run `/freeflow deploy cloudflare` (or `deno`, `vercel`), paste your platform token once, and the relay is created and activated for you. Manual snippets below.

**Option A: Cloudflare Workers (100k req/day, no 25s timeout) — Auto Deploy**
```bash
/freeflow deploy cloudflare  # prompts token in-memory, auto-adds to pool
```
*Manual fallback:* `dash.cloudflare.com` → Workers → Create → Deploy → Edit code → paste snippet below → Deploy → `/freeflow add https://your.workers.dev cf-worker-1`

```js
// Only the 2 upstreams pi-freeflow talks to. Anything else = open proxy abuse.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];

export default {
  async fetch(req) {
    const target = req.headers.get("x-relay-target");
    const relayPath = req.headers.get("x-relay-path") || "/";
    if (!target) return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), { status: 400 });
    const cleanTarget = target.replace(/\/$/, "");
    if (!ALLOWED_TARGETS.includes(cleanTarget)) return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403 });
    if (!relayPath.startsWith("/")) return new Response(JSON.stringify({ error: "Bad path" }), { status: 400 });
    const headers = new Headers(req.headers);
    headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
    return fetch(cleanTarget + relayPath, { method: req.method, headers, body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined });
  },
};
```

**Option B: Vercel Edge Relay (1M req/mo) — Auto Deploy**
```bash
/freeflow deploy vercel  # prompts token in-memory, auto-adds to pool
# or shorthand: /freeflow deploy
```
*Manual fallback:* Push 2 files (`api/relay.js` + `vercel.json`) to GitHub $\to$ Import on `vercel.com` $\to$ `/freeflow add https://your.vercel.app vercel-relay-1`

```js
// api/relay.js
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
export const config = { runtime: "edge" };
export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target || !ALLOWED_TARGETS.includes(target.replace(/\/$/, ""))) {
    return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403 });
  }
  const headers = new Headers(req.headers);
  headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
  const res = await fetch(target.replace(/\/$/, "") + relayPath, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
}
```

```json
// vercel.json
{ "rewrites": [{ "source": "/(.*)", "destination": "/api/relay" }] }
```

**Option C: Deno Deploy (100k req/day) — Auto Deploy**
```bash
/freeflow deploy deno  # prompts token in-memory, auto-adds to pool
```
*Manual fallback:* `dash.deno.com` → New Project → Playground → paste snippet below → Deploy → `/freeflow add https://your-project.deno.dev deno-relay-1`

```ts
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];

Deno.serve(async (req) => {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target || !ALLOWED_TARGETS.includes(target.replace(/\/$/, ""))) {
    return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403 });
  }
  const headers = new Headers(req.headers);
  headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
  const res = await fetch(target.replace(/\/$/, "") + relayPath, { method: req.method, headers, body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined });
  return new Response(res.body, { status: res.status, headers: res.headers });
});
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

Log rotation at 5MB. Clean, parseable, real-time HTTP lifecycle tracking.

---

### Design

This package stays thin. It ships three things: a model catalog, a relay proxy, and a log. There is no build step and there are no runtime dependencies. Thinking and prompt normalization stay with the host (`pi-ai`).

Current size: about 4.6k lines including tests. 16 tests pass, typecheck clean.

---

### FAQ

**Do I need API keys?**
No. Kilo uses `Bearer kilo-free`, OpenCode uses `opencodeHeaders()`.

**What if all relays are 429?**
Proxy tries direct. If that is also 429, Pi shows the rate limit. That number is the global upstream cap; without relays you would hit the same wall.

**Can I use without relays?**
Yes. `/freeflow off` → direct. Add relays later to scale.

**Where's the normalizer?**
Deleted in 1.3.0. If zai/qwen/deepseek thinking broke before, it's fixed now because host handles it.

**Why is context free?**
We use OpenCode Zen & Kilo free tiers. You pay only with your own Cloudflare/Vercel free tiers for egress.

---

### Contributing

Contributions welcome — bug fixes, new relay platforms, model additions, docs improvements.

#### Prerequisites

- **Node.js ≥ 22.6.0** (uses `--experimental-strip-types`, no build step)
- **pnpm** (package manager)

#### Setup & Verify

```bash
git clone https://github.com/trefeon/pi-freeflow
cd pi-freeflow
pnpm install

# run all three before opening a PR
pnpm test        # 16 tests across 2 test files
pnpm typecheck   # tsc --noEmit, must pass clean
pnpm smoke       # verifies extensions/index.ts loads without crashing
```

#### Project Structure

```
src/
├── index.ts          # extension entry, lifecycle hooks
├── models.ts         # 21-model catalog definitions
├── catalog.ts        # model catalog cache (24h disk)
├── proxy.ts          # local proxy server (127.0.0.1:28180)
├── relay.ts          # relay selection & round-robin
├── relay-state.ts    # relay pool state, health tracking
├── rate-limiter.ts   # adaptive cooldown on 429/504/socket errors
├── stream-pipe.ts    # SSE stream piping & truncation resilience
├── commands.ts       # /freeflow CLI subcommands
├── deploy.ts         # guided relay deploy (vercel/cloudflare/deno)
├── config.ts         # relay pool persistence
├── logger.ts         # file logger with 5MB rotation
└── types.ts          # shared type definitions
extensions/
└── index.ts          # OMP/Pi extension manifest
test/
└── *.test.ts         # mirrors src/, node:test runner
```

#### Guidelines

- **Stay thin.** No runtime dependencies. No build step. If it belongs in the host (`pi-ai`), don't add it here.
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

