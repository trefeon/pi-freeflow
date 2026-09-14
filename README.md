# pi-freeflow

> 26 free models with up to 1M context. No API keys to manage. Add your own relays to spread requests across more IPs.

Thin by design: a model list, a relay proxy, and a log. The host (`pi-ai`) handles thinking, normalization, and provider behavior.

[![npm version](https://img.shields.io/npm/v/pi-freeflow?style=flat-square&color=00E5FF)](https://www.npmjs.com/package/pi-freeflow)
[![npm downloads](https://img.shields.io/npm/dm/pi-freeflow?style=flat-square)](https://www.npmjs.com/package/pi-freeflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Pi](https://img.shields.io/badge/Powered%20by-Pi-7c3aed?style=flat-square)](https://github.com/badlogic/pi-ai)
[![Oh My Pi](https://img.shields.io/badge/Compatible-OMP-black?style=flat-square)](https://github.com/coder/oh-my-pi)

---

### What you get

| Feature | What it does | Cost |
| :--- | :--- | :--- |
| **26 free models** | 7 from OpenCode Zen, 19 from KiloCode Gateway, context windows up to 1M. Full list below. | **$0** |
| **Relay pool** | Route requests through your own Cloudflare Workers and Vercel Edge relays. Requests rotate across the pool. A relay that rate-limits, times out, or drops the connection cools down while healthy ones take its traffic. | **$0** beyond your platforms' free tiers |
| **Automatic fallback** | When every relay is cooling down, requests go direct to upstream instead of failing. | **$0** |
| **Short model names** | Every model has a slash-free, colon-free alias, plus an optional `:effort` suffix for thinking depth. You type `freeflow/<name>`. | **$0** |
| **Shared local proxy** | One daemon on `127.0.0.1:28180` serves every session on the machine, so parallel subagents reuse it instead of opening their own connections. | **$0** |
| **Logs you can read** | `~/.pi/agent/pi-freeflow.log`, rotated at 10MB. Tail it with `/freeflow logs`. | **$0** |

---

### Install

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

> Both commands fetch the same npm package from the registry. pi-freeflow
> is an extension loaded by the host, not a standalone CLI. It works on OMP
> and Pi only (they share the extension API).

### Pick a model

**OMP, interactive:**
```bash
omp
/model → freeflow → muse-spark-1.2-contributor-free (1M) → max
```

**OMP, one shot:**
```bash
omp -p --model freeflow/muse-spark-1.2-contributor-free "build me a SaaS"
omp -p --model freeflow/step-3.7-flash:high "solve this bug"   # alias + thinking level
```

**Pi, interactive:**
```bash
pi
/model → freeflow → pick
```

**Pi, one shot:**
```bash
pi -p --model freeflow/step-3.7-flash:high "solve this bug"
```

Model IDs accept a full canonical ID, a short alias (see the tables below),
and an optional `:effort` suffix (`:minimal` through `:xhigh`, `:max` where
supported). The host resolves the rest.

### Add relays

The default setup talks to upstream directly. Add relays when shared IPs start
hitting rate limits. The fastest path is guided deploy: run
`/freeflow deploy cloudflare` (or `deno`, `vercel`), paste your platform token
once when asked, and the relay is created and added to your pool. The token
stays in memory and is never written to disk.

Manual fallback per platform:

**Option A: Cloudflare Workers, auto deploy**
```bash
/freeflow deploy cloudflare  # prompts token in-memory, auto-adds to pool
```
Manual fallback: `dash.cloudflare.com` → Workers → Create → Deploy → Edit code → paste the canonical worker source (see below) → Deploy → `/freeflow add https://your.workers.dev cf-worker-1`

**Option B: Vercel Edge Relay, auto deploy**
```bash
/freeflow deploy vercel  # prompts token in-memory, auto-adds to pool
# or shorthand: /freeflow deploy
```
Manual fallback: push 2 files (`api/relay.js` + `vercel.json`) to GitHub, then Import on `vercel.com`, then `/freeflow add https://your.vercel.app vercel-relay-1`

For `api/relay.js`, use the canonical worker source (see below); `vercel.json` stays:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/api/relay" }] }
```

**Option C: Deno Deploy, auto deploy**
```bash
/freeflow deploy deno  # prompts token in-memory, auto-adds to pool
```
Manual fallback: `dash.deno.com` → New Project → Playground → paste the canonical worker source (see below) → Deploy → `/freeflow add https://your-project.deno.dev deno-relay-1`

**Canonical worker source (all platforms)**

The relay worker template is generated per deployment by `/freeflow deploy`, with one shared core adapted for Vercel, Cloudflare, and Deno. Deployed relays accept requests from any pi-freeflow user by default, while only forwarding to an allowlist (`https://opencode.ai`, `https://api.kilo.ai`) with private-host and path checks.

```js
// Minimal Cloudflare illustration. Prefer /freeflow deploy: the generated
// worker is the hardened source for all three platforms.
// This example omits the private-host guard, path validation, and auth.
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
/freeflow status        # active relay, pool status, candidates
/freeflow list          # every relay with health status
/freeflow logs          # tail -25
```

### Carry your pool to another machine

```bash
/freeflow export                        # save pool to ./freeflow-relays.json
/freeflow export backup/team.json       # save to a path you choose
/freeflow import backup/team.json       # add its relays to this machine (merge)
/freeflow import backup/team.json --replace --dry-run  # preview a full swap first
```

Merge is the default and never deletes anything. Replace swaps the whole pool
and always asks first. Passwords stay out of the file unless you pass
`--include-secrets`; a file without passwords still imports, and you re-enter
each password once afterwards.

---

### Commands reference (`/freeflow`)

The same command set works identically in OMP and Pi:

```bash
/freeflow status                  # View active relay, pool status, and candidates
/freeflow list                    # List all relays with real-time health badges
/freeflow use <url|index|label>   # Switch active relay
/freeflow url <url>               # Set the active relay URL directly
/freeflow add <url> [label]       # Add new relay to the pool
/freeflow label <index|url> <name># Assign a friendly label to a relay
/freeflow remove <index|url|label># Remove a relay from the pool
/freeflow test <index|url|label>  # Probe a relay for reachability and latency
/freeflow on | off | auto         # Toggle relay mode (auto = enabled for freeflow)
/freeflow deploy <platform>       # Guided relay deploy: vercel|cloudflare|deno, token in-memory, auto-adds
/freeflow logs [lines]            # Inspect recent proxy logs
/freeflow trace [req-id]          # Tail logs filtered by request correlation ID
/freeflow refresh                 # Reload the model catalog from live upstreams
/freeflow update                  # Check for and install a package update
/freeflow debug on | off          # Toggle full HTTP lifecycle debug logging
/freeflow kill                    # Stop the shared proxy daemon now (restarts on next use)
/freeflow export [path] [--include-secrets]  # Save the relay pool to a file (default freeflow-relays.json; passwords left out unless asked)
/freeflow import <path> [--merge|--replace] [--dry-run]  # Load a relay pool from a file (merge is default; replace asks first; dry-run previews only)
```

---

### 26 models, one command

```bash
/model → freeflow → pick
```

#### OpenCode Zen (7 models), Responses and Chat API

Good defaults for long coding sessions and agentic work.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `muse-spark-1.2-contributor-free` | Meta Superintelligence Labs | **1M** (1.048.576) | **131K** (131.072) | `minimal … xhigh` | ✅ |
| `muse-spark-1.3-contributor-free` | Meta Superintelligence Labs | **1M** (1.048.576) | **131K** (131.072) | `minimal … xhigh` | ✅ |
| `mimo-v2.5-free` | Xiaomi MiMo | **1M** (1.048.576) | **131K** (131.072) | `minimal … xhigh`\* | ✅ |
| `nemotron-3.5-lightning-free` | NVIDIA | **1M** (1.000.000) | **262K** (262.144) | `minimal … xhigh` | ❌ |
| `nemotron-3-ultra-free` | NVIDIA | **1M** (1.000.000) | **128K** (128.000) | `minimal … xhigh` | ❌ |
| `big-pickle` | Big Pickle | **200K** (200.000) | **32K** (32.000) | `high / max` | ❌ |
| `ling-3.0-flash-fin-free` | Inclusion AI | **262K** (262.144) | **131K** (131.072) | `minimal … xhigh` | ❌ |

#### KiloCode Gateway (19 models), OpenRouter compatible

Keyless access. Short aliases work for every row (the full ID is in parentheses).

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dots-3-note-preview` (`dots-studio/...:free`) | Dots Studio | **512K** (512.000) | **512K** (512.000) | `minimal…xhigh`\* | ✅ |
| `step-3.7-flash` (`stepfun/...:free`) | StepFun | **262K** (262.144) | **262K** (262.144) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-nano-omni` (`nvidia/...:free`) | NVIDIA | **256K** (256.000) | **131K** (131.072) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-ultra-550b` (`nvidia/...:free`) | NVIDIA | **1M** (1.000.000) | **128K** (128.000) | `minimal…xhigh`\* | ❌ |
| `nvidia/nemotron-3.5-lightning:free` | NVIDIA | **1M** (1.000.000) | **262K** (262.144) | `minimal…xhigh`\* | ❌ |
| `nemotron-3-super` (`nvidia/...:free`) | NVIDIA | **262K** (262.144) | **262K** (262.144) | `minimal…xhigh`\* | ❌ |
| `north-mini-code` (`cohere/...:free`) | Cohere | **256K** (256.000) | **64K** (64.000) | `minimal…xhigh`\* | ❌ |
| `laguna-s-2.1:free` (`poolside/...:free`) | Poolside | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `laguna-xs-2.1:free` (`poolside/...:free`) | Poolside | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `lfm-2.5` (`liquid/lfm-2.5-2.6b:free`) | Liquid AI | **65K** (65.536) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `kilo-auto` (`kilo-auto/free`) | Kilo Gateway Auto | **256K** (256.000) | **10K** (10.000) | `minimal…xhigh`\* | ❌ |
| `openrouter` (`openrouter/free`) | OpenRouter Free | **200K** (200.000) | **65K** (65.536) | `minimal…xhigh`\* | ✅ |
| `content-safety` (`nvidia/...:free`) | NVIDIA | **128K** (128.000) | **8K** (8.192) | ❌ *(non-thinking)* | ✅ |
| `ling-3.0-flash-fin` (`inclusionai/ling-3.0-flash-fin:free`) | Inclusion AI | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `ling-3.0-flash-sante` (`inclusionai/ling-3.0-flash-sante:free`) | Inclusion AI | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `nex-n2.5-pro` (`nex-agi/nex-n2.5-pro:free`) | Nex AGI | **262K** (262.144) | **235K** (235.929) | `minimal…xhigh`\* | ✅ |
| `nex-n2.5-mini` (`nex-agi/nex-n2.5-mini:free`) | Nex AGI | **262K** (262.144) | **235K** (235.929) | `minimal…xhigh`\* | ✅ |
| `ling-3.0-flash-vl` (`inclusionai/ling-3.0-flash-vl:free`) | Inclusion AI | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ✅ |
| `inkling-small` (`thinkingmachines/inkling-small:free`) | Thinking Machines | **1M** (1.048.576) | **262K** (262.144) | `minimal…xhigh`\* | ✅ |

\* Levels are forwarded as-is through the OpenRouter-style nested `reasoning` parameter; effort mapping is decided by each model. MiMo collapses `minimal→low` and `xhigh→high` upstream, so its selector shows 5 labels but only 3 distinct effort values.

---

### Logs and debugging

```bash
/freeflow logs
cat ~/.pi/agent/pi-freeflow.log | tail -n 50

# full debug logging is on by default; `off` restores info level
/freeflow debug on
```

---

### Design

This package stays thin. It ships three things: a model catalog, a relay proxy, and a log. There is no build step and zero runtime dependencies. Thinking and prompt normalization stay with the host (`pi-ai`).

About 19k lines including tests. The full suite (sandboxed, network-mocked) and typecheck pass before every release. See CHANGELOG.md.

---

### FAQ

**Do I need API keys?**
No. Kilo uses a shared free credential and OpenCode free models need no header. You never paste a key.

**What if all relays hit rate limits?**
The proxy tries direct upstream. If that is also rate-limited, the host shows the limit. That number is the shared upstream cap; without relays you would hit the same wall sooner.

**Can I use it without relays?**
Yes. `/freeflow off` talks direct. Add relays later when you need them.

**What happens when I update to a new version?**
The local proxy daemon is shared across sessions on port 28180. On upgrade, the new extension
detects a stale daemon (an older version still running) and replaces it automatically, with no manual
kill and no restart of other sessions. Replacement only happens when the running daemon is
idle: sessions with in-flight requests are never interrupted (busy or newer daemons are reused
with a log note instead). If a daemon cannot be replaced (for example the port is held by an unrelated process),
it falls back to reusing it with a warning. To disable replacement entirely, set the no-kill env
to `1` before starting a session.

**What happens when I close a session?**
Nothing visible to your other sessions. The proxy daemon is a separate background
process shared by every OMP/Pi session on the machine. Closing one session just
unregisters it; the daemon keeps serving the rest and retires itself automatically
once the last client disconnects and no client re-attaches within a short grace window.
To stop it manually, run `/freeflow kill`. The next freeflow use starts it again.

**Why did my long session stop with a "reasoning was not issued to this caller" error?**
The upstream backend signs each thinking block so only the backend that produced it can read it back. When a later turn reaches a different backend, the old blocks get rejected and the session stalls. pi-freeflow keeps each conversation on the relay that produced its thinking while that relay is healthy. When the relay has to change anyway (rate limit, relay removed, direct-mode switch), that turn is sent without the old thinking blocks so the new backend accepts it, and only the rejected blocks are dropped afterwards. Messages, tool calls, and tool results are always kept.

**Why is it installed via npm?**
The npm package is the distribution channel only. Both hosts resolve it internally:
`omp plugin install pi-freeflow` and `pi install npm:pi-freeflow` install the same
package from the npm registry. pi-freeflow is an extension, not a standalone CLI.
The host (OMP or Pi) loads and runs it. A plain `npm install` just downloads the
files; it is not a supported way to run the extension.

**Which hosts can use it?**
Oh My Pi (OMP) and Pi only. They share the same extension API, so one
package serves both. Other AI agents (OpenCode, KiloCode, Cursor, and similar) have their
own plugin systems and do not load this extension.

---

### Contributing

Contributions welcome: bug fixes, new relay platforms, model additions, docs improvements.

#### Prerequisites

- **Node.js ≥ 22.19.0** (uses `--experimental-strip-types`, no build step)
- **pnpm** (package manager)

#### Setup and verify

```bash
git clone https://github.com/trefeon/pi-freeflow
cd pi-freeflow
pnpm install

# run all three before opening a PR
pnpm test        # full suite; sandboxed and network-mocked
pnpm typecheck   # tsc --noEmit, must pass clean
pnpm smoke       # verifies extensions/index.ts loads without crashing
```

#### Project structure

```
src/
├── index.ts          # extension entry, lifecycle hooks
├── models.ts         # 26-model catalog definitions
├── catalog.ts        # model catalog cache (24h disk)
├── proxy.ts          # local proxy server (127.0.0.1:28180)
├── relay.ts          # relay selection and round-robin
├── relay-state.ts    # relay pool state, health tracking
├── stream-pipe.ts    # SSE stream piping and truncation resilience
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

#### Reporting issues

Found a bug or want a feature? [Open an issue](https://github.com/trefeon/pi-freeflow/issues) with:
- What happened vs what you expected
- Your relay setup (`/freeflow status` output helps)
- Relevant logs (`/freeflow logs` or `~/.pi/agent/pi-freeflow.log`)

---

### License

MIT © trefeon
