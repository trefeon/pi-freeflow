# pi-freeflow

> 35 free models with up to 1M context. No API keys to manage. Add your own relays to spread requests across more IPs.

Thin by design: a model list, a relay proxy, and a log. The host (`pi-ai`) handles thinking, normalization, and provider behavior.

[![npm version](https://img.shields.io/npm/v/pi-freeflow?style=flat-square&color=00E5FF)](https://www.npmjs.com/package/pi-freeflow)
[![npm downloads](https://img.shields.io/npm/dm/pi-freeflow?style=flat-square)](https://www.npmjs.com/package/pi-freeflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Pi](https://img.shields.io/badge/Powered%20by-Pi-7c3aed?style=flat-square)](https://github.com/earendil-works/pi)
[![Oh My Pi](https://img.shields.io/badge/Compatible-OMP-black?style=flat-square)](https://github.com/can1357/oh-my-pi)

---

### What you get

| Feature | What it does | Cost |
| :--- | :--- | :--- |
| **35 free models** | 11 from OpenCode Zen, 15 from KiloCode Gateway, 1 from Cline, 8 from OVHcloud AI Endpoints, context windows up to 1M. Full list below. | **$0** |
| **Relay pool** | Route requests through your own relays: a self-hosted egress pool (many egress IPs on one small host) or Cloudflare Workers / Deno Deploy / Vercel Edge workers. Traffic spreads across the pool, or stays on one sticky relay. A relay that rate-limits, times out, or drops the connection cools down while healthy ones take its traffic. | **$0** beyond your host or platforms' free tiers |
| **Automatic fallback** | When every relay is cooling down, requests go direct to upstream instead of failing. | **$0** |
| **Short model names** | Most models have a slash-free, colon-free alias, plus an optional `:effort` suffix for thinking depth. You type `freeflow/<name>`; the Cline model has no alias and must be typed in full. | **$0** |
| **Shared local proxy** | One daemon on `127.0.0.1:28180` serves every session on the machine, so parallel subagents reuse it instead of opening their own connections. Loopback-only and token-gated: hosts send the token automatically, external tools read `~/.pi/agent/token`. | **$0** |
| **Logs you can read** | `~/.pi/agent/pi-freeflow.log`, rotated at 10MB. Tail it with `/freeflow logs`. | **$0** |
| **Tool-call diagnostics** | `~/.pi/agent/toolcall-audit.jsonl`, rotated at 5MB. One line per streamed turn that declared tools (and per non-streamed Chat Completions turn) — the calls it made, argument size and validity, finish reason, classified failure — plus one line per abandoned upstream attempt. Names, sizes and reasons only. | **$0** |

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
/model → freeflow → deepseek-v4.1-flash-free (1M) → max
```

**OMP, one shot:**
```bash
omp -p --model freeflow/deepseek-v4.1-flash-free "build me a SaaS"
omp -p --model freeflow/longcat:high "solve this bug"   # alias + thinking level
```

**Pi, interactive:**
```bash
pi
/model → freeflow → pick
```

**Pi, one shot:**
```bash
pi -p --model freeflow/longcat:high "solve this bug"
```

Model IDs accept a full canonical ID, a short alias (see the tables below),
and an optional `:effort` suffix (`:minimal` through `:xhigh`, `:max` where
supported). The host resolves the rest.

### Add relays

The default setup talks to upstream directly. Add relays when shared IPs start
hitting rate limits — the OpenCode Zen free tier counts them per egress IP, so
how many dedicated egress addresses you control decides how much you can run at
once.

**Option A: Self-hosted WARP relay pool (recommended for OpenCode Zen)**

One Linux VPS runs a pool of isolated Cloudflare WARP egress addresses with
automatic rotation of rate-limited IPs — [trefeon/warp-relay-pool](https://github.com/trefeon/warp-relay-pool):

```bash
git clone https://github.com/trefeon/warp-relay-pool.git
cd warp-relay-pool && ./setup.sh
```

- **Many egress IPs, tiny footprint**: each relay node is ~1.8 MiB of RAM; the
  default five-relay pool fits a 512 MB VPS (~50 MB of stack over a private
  mesh-VPN URL, ~160 MB with public tunnel URLs).
- **Auto-rotation**: a background service probes each egress for HTTP 429 and
  rotates only the throttled node — the rest of the pool keeps serving and your
  client URLs stay put.
- **No platform quotas, no request rewriting**: your host's bandwidth, and
  requests arrive upstream with the client's own fingerprint.
- **Same contract as edge relays**: implements `x-relay-target`, so it can sit
  in a pool alongside worker deployments.
- The setup wizard prints ready-to-paste `/freeflow add <url> <label>` commands;
  pair the pool with `/freeflow spread` so parallel sessions and subagents land
  on different egress IPs.

**Option B: Cloudflare Workers, auto deploy (zero-infra)**
```bash
/freeflow deploy cloudflare  # prompts token in-memory, auto-adds to pool
# or /freeflow deploy with no argument to pick the platform interactively
```
Manual fallback: `dash.cloudflare.com` → Workers → Create → Deploy → Edit code → paste the canonical worker source (see below) → Deploy → `/freeflow add https://your.workers.dev cf-worker-1`

**Option C: Deno Deploy, auto deploy (Kilo models only)**
```bash
/freeflow deploy deno  # prompts token in-memory, auto-adds to pool
```
Manual fallback: `dash.deno.com` → New Project → Playground → paste the canonical worker source (see below) → Deploy → `/freeflow add https://your-project.deno.dev deno-relay-1`

Deno Deploy rewrites the outbound `User-Agent` at the platform layer, so OpenCode Zen free-tier traffic through a Deno relay is refused with `403 FreeTierError`; Kilo models still work. The deploy flow warns up front and its post-deploy inference probe reports what the relay can actually serve.

**Option D: Vercel Edge Relay (last resort, paid plan only)**
```bash
/freeflow deploy vercel  # prompts token in-memory, auto-adds to pool
```
Only use with a paid plan: the Hobby plan caps Fast Origin Transfer at 10 GB (~1.2 MB per streaming turn, about 8,000 turns), then every deployment in the project returns HTTP 402 until the quota resets.
Manual fallback: push 2 files (`api/relay.js` + `vercel.json`) to GitHub, then Import on `vercel.com`, then `/freeflow add https://your.vercel.app vercel-relay-1`

For `api/relay.js`, use the canonical worker source (see below); `vercel.json` stays:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/api/relay" }] }
```

**Canonical worker source (all platforms)**

The relay worker template is generated per deployment by `/freeflow deploy`, with one shared core adapted for Vercel, Cloudflare, and Deno. Every deploy embeds a random 32-byte secret, and the generated worker answers `401` to any request without a matching `x-relay-auth` header; the client sends that secret to each relay in the pool. Only a hand-pasted legacy worker built without a secret is open to anyone. Either way, a relay forwards only to an allowlist (`https://opencode.ai`, `https://api.kilo.ai`) with private-host and path checks.

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
/freeflow hide|show               # Hide or restore the status-bar widget (also `widget hide`/`widget show`)
/freeflow list                    # List all relays with real-time health badges
/freeflow use <url|index|label>   # Switch active relay
/freeflow url <url>               # Set the active relay URL directly
/freeflow add <url> [label]       # Add new relay to the pool
/freeflow label|rename <index|url> <name>  # Assign a friendly label to a relay
/freeflow remove <index|url|label># Remove a relay from the pool
/freeflow test <index|url|label>  # Probe a relay for reachability and latency
/freeflow on|off|auto|sticky|spread  # Relay mode (auto/sticky = sticky primary, spread = rotate pool)
/freeflow deploy <platform>       # Guided relay deploy: vercel|cloudflare|deno, token in-memory, auto-adds
/freeflow logs [lines]            # Inspect recent proxy logs (alias: log)
/freeflow trace [req-id]          # Tail logs filtered by request correlation ID
/freeflow refresh                 # Reload the model catalog from live upstreams
/freeflow reload models           # Alias of refresh
/freeflow update                  # Check for and install a package update
/freeflow autoupdate [on|off]     # View or toggle automatic background updates (also: update auto on|off)
/freeflow install-startup         # Install the login-startup hook so the daemon comes up with your session
/freeflow uninstall-startup       # Remove the login-startup hook
/freeflow debug on | off          # Toggle full HTTP lifecycle debug logging
/freeflow kill                    # Stop the shared proxy daemon now (restarts on next use; aliases: stop, shutdown)
/freeflow cline login               # Sign in through the browser, save to the per-user pool
/freeflow cline accounts            # List saved Cline logins
/freeflow cline logout              # Remove a saved Cline login
/freeflow cline signout             # Link to sign out of Cline in your browser (to add another account)
/freeflow export [path] [--include-secrets]  # Save the relay pool to a file (default freeflow-relays.json; passwords left out unless asked)
/freeflow import <path> [--merge|--replace] [--dry-run]  # Load a relay pool from a file (merge is default; replace asks first; dry-run previews only)
```

---

### 35 models, one command

```bash
/model → freeflow → pick
```

Every model specification is reconciled against [models.dev](https://models.dev/), [OpenRouter](https://openrouter.ai/), and OMP's built-in catalog on 2026-10-22: a free and a non-free variant of the same model share the highest published context window, output ceiling, and input modalities across its twins. The catalog follows that published spec even where a free lane enforces a lower runtime cap; the authentic upstream error is surfaced above it. Where the lane itself refuses above a published figure, the served boundary wins (DeepSeek V4.1 Flash: published 384,000, served 393,216). (Measured runtime caps: MiMo ~348K, GLM 5.3 Flash ~297K, Laguna S 262K.) Lane-published hard caps stay authoritative where the lane refuses above them: OVH's advertised context windows, the 1,000,000-token Nemotron 3 Ultra ceiling, and Dots3-Note's 393,216 served window (its only provider refused a 460,800 output budget on 2026-10-20). These tables mirror `src/models.ts`, and the scheduled health check retires a model only after a live model-level 404/410 — so a row that no longer answers is a bug worth filing.

The host catalog carries text and image inputs only. Upstream video and audio support (MiMo: audio + video; GLM 5.3 Flash: video + PDF; Nemotron Super VL and Nano Omni: video) is therefore not selectable from the picker and is not declared in `input`.

#### OpenCode Zen (11 models), Chat Completions API

Good defaults for long coding sessions and agentic work.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `cat-jam-free` | Cat Jam | **1M** (1.048.576) | **131K** (131.072) | `low … max` | ❌ |
| `mimo-v2.6-flash-free` | Xiaomi MiMo | **1M** (1.048.576) | **128K** (131.072) | `minimal … xhigh`\* | ✅ |
| `nemotron-3.5-lightning-free` | NVIDIA | **1M** (1.000.000) | **235K** (235.929) | `minimal … xhigh` | ❌ |
| `nemotron-3.5-super-vl-free` | NVIDIA | **1M** (1.048.576) | **235K** (235.929) | `minimal … xhigh` | ✅ |
| `nemotron-3-ultra-free` | NVIDIA | **1M** (1.000.000) | **182K** (182.520) | `minimal … xhigh` | ❌ |
| `big-pickle` | Big Pickle | **200K** (200.000) | **32K** (32.000) | `high / max` | ❌ |
| `longcat-2.5-preview-free` | Meituan LongCat | **1M** (1.048.576) | **131K** (131.072) | `minimal … xhigh` | ✅ |
| `glm-5.3-flash-free` | Zhipu AI | **1M** (1.048.576) | **131K** (131.072) | `low / high / max` | ✅ |
| `beam-free` | Reflection AI | **1M** (1.048.576) | **131K** (131.072) | `low … max` | ❌ |
| `deepseek-v4.1-flash-free` | DeepSeek | **1M** (1.048.576) | **393K** (393.216) | `low / high / max` | ✅ |
| `flint-40b-free` | Recursive | **262K** (262.144) | **65K** (65.536) | `low … max` | ❌ |

#### KiloCode Gateway (15 models), OpenRouter compatible

Keyless access. Most rows have a short alias (shown with the full ID in parentheses); a row that shows only the full ID has no short form.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dots-3-note-preview` (`dots-studio/...:free`) | Dots Studio | **384K** (393.216) | **256K** (262.144) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-nano-omni` (`nvidia/...:free`) | NVIDIA | **262K** (262.144) | **65K** (65.536) | `minimal…xhigh`\* | ✅ |
| `nemotron-3-ultra-550b` (`nvidia/...:free`) | NVIDIA | **1M** (1.000.000) | **182K** (182.520) | `minimal…xhigh`\* | ❌ |
| `nemotron-3.5-lightning` (`nvidia/nemotron-3.5-lightning:free`) | NVIDIA | **1M** (1.000.000) | **235K** (235.929) | `minimal…xhigh`\* | ❌ |
| `north-mini-code` (`cohere/...:free`) | Cohere | **256K** (256.000) | **64K** (64.000) | `minimal…xhigh`\* | ❌ |
| `laguna-s-2.1:free` (`poolside/...:free`) | Poolside | **1M** (1.048.576) | **131K** (131.072) | `minimal…xhigh`\* | ❌ |
| `laguna-xs-2.1:free` (`poolside/...:free`) | Poolside | **262K** (262.144) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `lfm-2.5` (`liquid/lfm-2.5-2.6b:free`) | Liquid AI | **128K** (128.000) | **32K** (32.768) | `minimal…xhigh`\* | ❌ |
| `kilo-auto` (`kilo-auto/free`) | Kilo Gateway Auto | **256K** (256.000) | **10K** (10.000) | `minimal…xhigh`\* | ❌ |
| `openrouter` (`openrouter/free`) | OpenRouter Free | **200K** (200.000) | **65K** (65.536) | `minimal…xhigh`\* | ✅ |
| `glyph-cluster` (`stealth/glyph-cluster`) | Stealth preview (lab undisclosed) | **256K** (256.000) | **256K** (256.000) | `minimal…xhigh`\* | ❌ |
| `nvidia/nemotron-3.5-super-vl:free` | NVIDIA | **1M** (1.000.000) | **131K** (131.072) | `minimal…xhigh`\* | ✅ |
| `beam-kilo` (`reflection/beam-free`) | Reflection AI | **1M** (1.048.576) | **131K** (131.072) | `low…max`\* | ❌ |
| `flint-kilo` (`recursive/flint-v1.0:free`) | Recursive | **262K** (262.144) | **65K** (65.536) | `minimal…xhigh`\* | ❌ |
| `xing4.0` (`xingchen-agi/xing4.0-29b-a4b:free`) | XingChen | **262K** (262.144) | **235K** (235.929) | `minimal…xhigh`\* | ❌ |

\* Levels are forwarded as-is through the OpenRouter-style nested `reasoning` parameter; effort mapping is decided by each model. MiMo collapses `minimal→low` and `xhigh→high` upstream, so its selector shows 5 labels but only 3 distinct effort values.

#### Cline (1 model), OpenAI compatible

Rotating per-account promo, direct only (never through the relay pool). Sign in through your browser with `/freeflow cline login`, manage with `/freeflow cline accounts` and `/freeflow cline logout`. Requests roll across saved logins when one hits its daily free limit.

Add as many logins as you want — each one gets its own slot (`default`, `slot-2`, `slot-3`, …) and a request that hits a limit on one rolls straight to the next. To sign in with a different email, sign out of Cline in that browser first (`/freeflow cline signout` prints the link), or use a private window so your current session stays put.

Each account can only be saved once: an extra login for an account you already have shares the same free quota, so it is refused rather than saved. If a pool already holds two logins for one account (saved before this check), `/freeflow cline accounts` marks the later one `— same account as [default]`, and `/freeflow cline logout <slot>` drops it.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `z-ai/glm-5.3-flash` | Zhipu AI | **1M** (1.048.576) | **131K** (131.072) | `low/high/max` | ✅ |
#### OVHcloud AI Endpoints (8 models), OpenAI compatible

Anonymous access — no account, no key, nothing to sign in to. Direct only (never through the relay pool), because OVH has no per-IP gate for relays to route around. OVH rate-limits anonymous callers per IP, so a burst of parallel subagents can hit `429 API rate limit exceeded`; the model list itself never costs anything.

Pick them with the slash-free short name (the full ID is in parentheses). The lane's rows publish `low`/`medium`/`high`; the 3.6 and 3.8 Qwens add `minimal`, and nothing on this lane offers `xhigh`/`max`.
All eight talk the normal chat API. Hosts that prefer the responses API work too — the proxy maps that shape to chat and maps the answer back, so tool calls and streamed output behave exactly as they do on the other providers.

| Model ID | Creator / Lab | Context | Max Output | Thinking | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `gpt-oss-120b` (`ovh-free/gpt-oss-120b`) | OpenAI | **128K** (131.072) | **65K** (65.536) | `low/medium/high` | ❌ |
| `gpt-oss-20b` (`ovh-free/gpt-oss-20b`) | OpenAI | **128K** (131.072) | **65K** (65.536) | `low/medium/high` | ❌ |
| `qwen3.5-397b` (`ovh-free/Qwen3.5-397B-A17B`) | Alibaba Qwen | **256K** (262.144) | **235K** (235.929) | `low/medium/high` | ✅ |
| `qwen3.5-9b` (`ovh-free/Qwen3.5-9B`) | Alibaba Qwen | **256K** (262.144) | **65K** (65.536) | `low/medium/high` | ✅ |
| `qwen3.6-27b` (`ovh-free/Qwen3.6-27B`) | Alibaba Qwen | **256K** (262.144) | **65K** (65.536) | `minimal … high` | ✅ |
| `qwen3.8-27b` (`ovh-free/Qwen3.8-27B`) | Alibaba Qwen | **256K** (262.144) | **235K** (235.929) | `minimal … high` | ✅ |
| `mistral-small-3.2` (`ovh-free/Mistral-Small-3.2-24B-Instruct-2506`) | Mistral AI | **128K** (131.072) | **32K** (32.768) | ❌ | ✅ |
| `llama-3.3-70b` (`ovh-free/Meta-Llama-3_3-70B-Instruct`) | Meta | **128K** (131.072) | **32K** (32.768) | ❌ | ❌ |

---

### Logs and debugging

```bash
/freeflow logs
cat ~/.pi/agent/pi-freeflow.log | tail -n 50

# full debug logging is on by default; `off` restores info level
/freeflow debug on
```

**Tool-call audit.** A streamed turn that declares tools — and a non-streamed Chat Completions turn — also writes a line to `~/.pi/agent/toolcall-audit.jsonl`, so a turn the host abandoned or retried can be explained without reproducing it:

- `summary` — one line per finished turn: the tool names the caller declared, the calls the model made (argument byte size and whether they parsed), the finish reason, and a classified failure when there was one.
- `attempt-failure` — one line per upstream attempt abandoned in favour of another, with the reason (rate limit, timeout, payload too large, rejected relay, final upstream verdict) and the HTTP status when one arrived.
- `retry-detected` — the host re-sent a conversation the proxy had already seen; `retryOf` names the earlier turn and carries its failure.

The log holds names, sizes, booleans and reasons only: no message text, no tool schemas, no argument values. It rotates once to `toolcall-audit.jsonl.1` at 5MB, and a turn that declared no tools writes nothing. `docs/pages/architecture.md` documents every field and has jq recipes for the common questions.

---

### Design

This package stays thin. It ships three things: a model catalog, a relay proxy, and logs. There is no build step and one runtime dependency (`undici`). Thinking and prompt normalization stay with the host (`pi-ai`).

About 57k lines including tests: `src/` is roughly 21.1k across 31 files, and the 93 test files add roughly 35.6k more. The full suite (sandboxed, network-mocked) and typecheck pass before every release. See CHANGELOG.md.

---

### FAQ

**Do I need API keys?**
No. OpenCode and Kilo free models need no key of your own. The proxy strips the placeholder credential the host provider registers with — forwarding it upstream gets a `401` (for Kilo, `Bearer kilo-free` answers `401 INVALID_TOKEN`) — so your key, if any, never leaves the machine. For OpenCode Zen it then adds the fixed `Authorization: Bearer public` the current `/inference/v1` gateway requires; the Kilo and OVHcloud lanes go out with no `Authorization` header at all. You never paste a key. Cline free models need a browser login instead: `/freeflow cline login` saves it to a per-user pool on your machine. OVHcloud AI Endpoints models need no account and no key at all.

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
├── models.ts                # 35-model catalog definitions
├── index.ts                 # extension entry, lifecycle hooks
├── catalog.ts               # model catalog cache (24h disk)
├── proxy.ts                 # local proxy server (127.0.0.1:28180)
├── client.ts                # session-side daemon attach/spawn and heartbeat
├── daemon.ts                # detached proxy daemon process (owns the port)
├── lease.ts                 # client lease registry and TTL retirement
├── health.ts                # loopback /_health relay snapshot
├── responses.ts             # Responses-API reasoning portability
├── tool-translation.ts      # tool reshape across chat/responses/messages
├── tool-args.ts             # schema-driven repair of model tool-call arguments
├── relay.ts                 # relay fetch, rolling on retryable failures
├── relay-state.ts           # relay pool state, health tracking
├── probe.ts                 # relay reachability and latency probe
├── upstream-health.ts       # Zen free-tier gating watch and Kilo failover
├── stream-pipe.ts           # SSE stream piping and truncation resilience
├── toolcall-audit.ts        # per-turn tool-call audit log (names and sizes only)
├── opencode-fingerprint.ts  # Zen free-tier client fingerprint enforcement
├── system-ca-fetch.ts       # OS-trust-store retry for intercepted TLS
├── commands.ts              # /freeflow CLI subcommands
├── deploy.ts                # guided relay deploy (vercel/cloudflare/deno)
├── cline-accounts.ts        # per-slot Cline key pool with failover
├── cline-device-auth.ts     # Cline WorkOS device-flow login
├── update-checker.ts        # npm registry version check, cached
├── update-core.ts           # version facts and update step runner
├── updater.ts               # package-manager choice for /freeflow update
├── atomic-write.ts          # temp-file + rename writes, retried across Windows locks
├── config.ts                # constants, whitelists, paths, and runtime settings
├── logger.ts                # file logger with 10MB rotation
└── types.ts                 # shared type definitions
extensions/
└── index.ts                 # OMP/Pi extension manifest
test/
└── *.test.ts                # mirrors src/, node:test runner
```

#### Guidelines

- **Stay thin.** One runtime dependency (`undici`), no build step. If it belongs in the host (`pi-ai`), don't add it here.
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
