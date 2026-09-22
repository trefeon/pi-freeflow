# Changelog

## 1.24.0

### Minor Changes

- Cline requests now identify as the Cline desktop app. That client identity is what makes Cline advertise its sixth free model, Kimi K3, so it joins the model list next to the four Cline models you already had.

  Kimi K3 (`cline-free/kimi-k3`) has a 1M-token context window, reads images, and takes the same `low` / `high` / `max` thinking depths as the other flash-class Cline models. It uses the login you already saved with `/freeflow cline login` and the same daily free quota, so a request that hits the limit on one saved login rolls to the next exactly like every other Cline model. Nothing about the other providers changes.

### Patch Changes

- Cline logins are used more sensibly, and the message you get when they are all out matches what actually happened.

  A saved login that has used up its daily free allowance for a model is now skipped instead of being retried on every request, so a turn goes straight to a login that still has allowance for that model. A login that starts working again is picked back up on its own.

  When every saved login is out for that model, the answer now says so: it names how many logins were tried, when the nearest reset is, and that switching models or adding another login (`/freeflow cline login`) is what helps — instead of implying that a single login was at fault.

- Kilo models work again. Kilo's gateway now rejects the placeholder credential the proxy used to send and accepts the same request without one, which broke every Kilo-model turn with a 401 "invalid token" error. The proxy no longer sends a credential for Kilo, so its models answer again instead of failing with a 401.
- Model selection can no longer lose models the extension ships with. When the saved copy of the live catalog was newer than the built-in list and the live refresh could not run, the provider used to be re-registered from that saved copy alone, so a model added in a later update could drop out of model selection until the app was restarted. The saved copy is now always overlaid on the built-in list, so no update can lose models that way.
- Removed Union Alpha from the model list. It stopped being served upstream: every request is rejected as an unsupported model, on both the chat and the Anthropic Messages paths, so picking it only produced an error. It is gone from model selection and cannot come back through a stale catalog cache. The Anthropic Messages request path itself stays supported for future models.

## 1.23.3

### Patch Changes

- Fix a test that failed intermittently on CI: it compared the whole response body of a chat request, including the timestamp each side stamps when it builds the body. When a request happened to cross a second boundary the two timestamps differed by one and the test went red even though nothing was wrong. The timestamp is no longer compared digit-for-digit, and the test now checks it is a real timestamp instead. No change to how the proxy behaves.

## 1.23.2

### Patch Changes

- Saved Cline logins are now recoverable. The pool keeps a backup copy beside it, so a pool that is missing or unreadable restores itself from the last good set of logins instead of silently coming back empty — losing every saved login to one bad write is no longer permanent. The backup also holds the largest set of logins ever seen, so it survives a run of smaller bad writes rather than being overwritten by the first one. Removing your last login still sticks: an intentionally empty pool is left alone rather than being repopulated from the backup.

## 1.23.1

### Patch Changes

- Cline logins no longer accept the same account twice. Two logins for one account share a single free quota, so the second one added nothing while making it look like you had more capacity — signing in with an account you already saved now says which slot has it and leaves your logins untouched. If a set of logins already contains the same account twice, `/freeflow cline accounts` marks the later one `— same account as [slot]` so you can tell them apart and remove the spare.

## 1.23.0

### Minor Changes

- Adding more Cline logins is now easy. Every login gets its own slot (`default`, `slot-2`, `slot-3`, …) and requests roll across all of them, so a second or third account keeps you working when one hits its free daily limit. The sign-in prompt now shows the link to sign out of Cline in your browser (`/freeflow cline signout` prints it any time), which is what you need to approve the next account with a different email — or use a private window and keep the session you already have. `/freeflow cline accounts` shows each login's email so you can tell them apart.

## 1.22.4

### Patch Changes

- Cline fixes after live testing with a real account. Restoring a signed-in Cline login could return a body that had already been discarded, so instead of Cline's actual error you got a bare "internal error" or an empty message; the real error text now reaches you. A login Cline itself rejects is now recognised as needing a fresh sign-in instead of being retried on every request forever. A request that finds no saved login no longer answers with a rate-limit status, so hosts stop treating "not signed in yet" as "wait and try later". Signing in through the browser no longer outlives its own code, survives a brief blip from the sign-in service, and a login added or removed while a request is running is no longer reverted. The model list now always includes every catalogued model even when a cached copy predates it, and `/freeflow cline accounts` and the remove picker show the account email so logins are easier to tell apart.

## 1.22.3

### Patch Changes

- Cline free models now work for real: DeepSeek V4.1 Flash, Muse Spark 1.3, GLM 5.3 Flash, and Solar Pro 4 all answered live against a signed-in account, over both the chat and responses endpoints, with and without tools. Removed the account lockouts that turned one failed attempt into a long "accounts are cooling down" wait, so every request now tries your saved logins fresh and reports the real upstream error instead of a made-up one. Removing a login is now a picker (`/freeflow cline logout`) instead of typing an exact slot name, and model list correctly labels Cline models as `clinecode`.

## 1.22.2

### Patch Changes

- Fix Cline login flow: the browser link and code now arrive in a single copy-paste block and stay pinned until login finishes, instead of the link scrolling away behind a separate waiting notice. Saved logins also refresh on their own again before expiring, and chatting with no logins saved tells you to add one instead of showing a rate-limit hint.

## 1.22.1

### Patch Changes

- Correct Cline free-model specs: DeepSeek V4.1 Flash and GLM 5.3 Flash are 1M context (not 262K) with vision support and low/high/max thinking levels; Solar Pro 4 is 512K context with the full thinking range. Model selection and docs now show the right numbers.

## 1.22.0

### Minor Changes

- Sign in to Cline right inside the extension: `/freeflow cline login` shows a browser link and code, approves your own Cline account, and saves it to a per-user pool on your machine — no pasting keys. Extra logins auto-name themselves (`default`, `slot-2`, …), saved logins refresh on their own, and requests roll across them when one hits its daily free limit. Pasting a key stays available behind `login --key`. Model selection labels every free model with its source ([OpenCode], [Kilo], [Cline]).

## 1.21.0

### Minor Changes

- Use Cline free models with your own Cline login: `/freeflow cline login` signs in through your browser and saves it to a per-user pool on your machine, `/freeflow cline accounts` lists saved logins, and `/freeflow cline logout` removes one. Adds DeepSeek V4.1 Flash, Muse Spark 1.3, GLM 5.3 Flash, and Solar Pro 4 from Cline's free rotation, and labels every free model with its source ([OpenCode], [Kilo], [Cline]) in model selection. Requests roll across saved logins when one hits its daily free limit or fails.

## 1.20.0

### Minor Changes

- Every tool from both supported hosts now works on every free model, including the models served on the dedicated responses endpoint. The proxy also tracks the latest client version in the background and always identifies itself with a supported one, so free-tier access keeps working as new releases come out.

  Also new: a daily automated check watches for upstream changes (new releases, free-model list and pricing changes) and files an issue when anything drifts, plus an opt-in script that verifies all tools end-to-end against the live free tier.

## 1.19.0

### Minor Changes

- Every tool your agent can use now works on every free model: the proxy translates tool definitions between chat, responses, and messages formats automatically, so built-in tools, MCP server tools, and custom tools all pass through intact on all request types. Strict tool schemas are preserved, and requests sent in one format to another endpoint are converted instead of rejected.

## 1.18.0

### Minor Changes

- OpenCode free-tier client fingerprinting: plain chat, subagent, evaluation, and background watchdog requests now pass upstream free-tier gates without error. The proxy automatically supplies compatibility tools and streaming conventions expected by the upstream gateway, while transparently converting responses to standard non-streaming format for callers that request it.

## 1.17.1

### Patch Changes

- Assistant and subagent requests now stay working when the shared free-tier gateway refuses sessions: retried and resumed conversations automatically continue on a healthy fallback model instead of repeating the refusal, and normal routing resumes on its own once the gateway recovers.

## 1.17.0

### Minor Changes

- Automatic upstream degradation: when the shared free-tier gateway starts refusing new sessions, new chat sessions seamlessly use a healthy fallback model on the same API, affected errors carry an actionable hint, in-progress chats are never rerouted, and normal routing resumes automatically on recovery. `/freeflow status` now shows live upstream state.

## 1.16.0

### Minor Changes

- New free model: Union Alpha Free joins the picker. It answers through a different upstream endpoint than the other free models, handled automatically — 262K context, image input, tool calling, and zero cost like the rest of the catalog.

## 1.15.2

### Patch Changes

- Relay traffic is now spent only on the free models the pool exists for: requests for other models go straight upstream even with the relay pool on, cutting relay bandwidth. Applies in automatic and always-on modes; relay-off behavior is unchanged.
- The disabled-deployment rollover now triggers only on genuine hosting verdicts, so ordinary payment and quota refusals always surface immediately without cooling a healthy relay. Relay-list imports also no longer show a negative removal count when the file holds more relays than the current pool.

## 1.15.1

### Patch Changes

- Requests now roll over to the next relay when the current one answers with a disabled-deployment verdict, instead of failing on the first relay and requiring a manual switch. Other payment and quota refusals still surface immediately.

## 1.15.0

### Minor Changes

- Free-tier requests now use native session identifiers and an up-to-date client version, after the upstream gateway began rejecting older formats with a free-tier error. `/freeflow test` also gains an end-to-end chat check that verifies a relay can actually run inference, not just list models.

## 1.14.0

### Minor Changes

- c28b7b5: Local proxy recovers on its own: if the background proxy stops unexpectedly, the extension now notices the refused local connection and starts a fresh proxy within seconds instead of leaving every model failing until the next session; shutdowns and crashes are also recorded in the log so the cause is visible.

### Patch Changes

- /freeflow update now goes through the host plugin managers first — reinstall under OMP, package update under Pi — and only then falls back to a global install, using Bun when npm is missing. Previously the first step called an update action the plugin manager does not define, so managed installs always fell through to the wrong target.

## 1.13.0

### Minor Changes

- 39a06b9: Carry a relay pool between machines: `/freeflow export` saves the relays to a file and `/freeflow import` loads them back, adding to the current pool by default or swapping it whole on confirmation.

## 1.12.1

### Patch Changes

- b32f208: Sessions survive a relay change without a rejected turn.

  Responses models sign each thinking block for the upstream backend that produced it, and only that backend can read it back. When a later turn reached a different backend, the replayed blocks were rejected as unreadable ("reasoning `encrypted_content` was not issued to this caller"), the host repeated the same failing request, and the session could not continue.

  pi-freeflow now keeps each conversation on the relay that issued its reasoning while that relay is healthy, and when a relay change is unavoidable (rate limit, relay removed or redeployed, direct-mode switch) it sends that turn without the signed thinking blocks, so the new backend accepts it on the first attempt. If a rejection still happens (the provider can change backends behind a relay), the request is retried once without the blocks, and only the rejected blocks are dropped on later turns, so the model keeps whatever reasoning the current backend can read. Messages, tool calls and tool results are always preserved.

## 1.12.0

### Minor Changes

- Free-model picker grows from 24 to 26: adds Nex N2.5 Pro, Nex N2.5 Mini, and Ling 3.0 Flash VL, and removes the discontinued Inkling entry. A new Stealth Models Watchlist docs page tracks masked preview IDs users ask about.

## 1.11.2

### Patch Changes

- 549b66e: Oversized requests no longer fail at the relay hop: when a relay answers 413 payload limit, the proxy transparently tries the next relay and then the direct route, keeping the stream alive. Long sessions that outgrow the relay payload cap now complete instead of surfacing a function payload error.

## 1.11.1

### Patch Changes

- Apologies for the daemon disconnect bug introduced in v1.11.0: in multi-agent workflows or when subagents, evaluations, and background tasks completed, the extension prematurely detached from the local proxy daemon, causing the proxy to shut down while your main session remained active. The heartbeat connection now persists throughout your active terminal session.
- Increased local health check and liveness probe timeouts from 800ms and 500ms to 2500ms and 1500ms, with an automatic probe retry to avoid false-alarm daemon restarts during heavy concurrent streaming.
- Added unhandled error logging inside the daemon to prevent silent process exits.
- Fresh installs now log full HTTP lifecycle debug output by default so diagnostic reports contain complete request context; turn it off anytime with `/freeflow debug off`.

## 1.11.0

### Minor Changes

- Proxy daemon now stays up while any session uses it, even when idle. It shuts down only after the last session leaves, instead of retiring after a short quiet window.

## 1.10.0

### Minor Changes

- cf48598: Hands-free proxy recovery plus catalog refresh: the proxy now watches its own health, restarts with backoff instead of leaving a dead port, and can start on login. Removed two discontinued free models from the picker.

All notable changes to pi-freeflow. Public, user-visible behavior only.

## 1.9.9 - 2026-09-06

### Fixes

- **Removed our own request cap — sorry, that one was on us.** The proxy used to enforce a built-in request limit and could answer 429 before upstream quota was actually exhausted. That was a bug, not your quota. From this version the proxy never rejects on quota itself: a 429 only surfaces when the upstream — and every relay in your pool — genuinely is rate-limited, and that response now points you at `/freeflow deploy` to add relay egress.

## 1.9.8 - 2026-09-06

### Fixes

- **Stale model list heals itself (follow-up to #6).** If your saved model list predates a newly added model, the background refresh now repairs the entry (correct endpoint and details) instead of sending requests to the wrong address — no manual `/freeflow refresh` or cache deletion needed.
- **Paid models stay out of the picker even from old saved lists.** Every read of the saved model list now drops non-free entries, so models requiring an API key cannot linger after an upgrade.
- **Old saved lists without a sync marker now re-sync once.** A saved list that could never trigger a network check now performs one plain revalidation (then syncs normally), so newly added free models appear without manual intervention. Missing or corrupt lists still fall back silently with no network call.
- **Upstream errors are now visible in the proxy log.** Failed upstream responses log their status code and model, and a model routed to the wrong endpoint logs the mismatch with the fix (restart Pi/OMP after upgrade).

### Validation

- TypeScript typecheck passed cleanly (`tsc --noEmit`).
- Full test suite passed on Windows (304 tests) and Ubuntu Linux (`acerblue`, 305/305 tests passed), including new regressions for the stale-cache shape from #6.
- Live sweep of all 26 models through a fresh install on `acerblue`: 23/26 answered on first try (both Muse Spark models via the Responses endpoint); the 3 misses are upstream per-model daily quotas (429), zero server errors.

## 1.9.7 - 2026-09-06

### Fixes

- **Model picker only shows verified free models (fixes #6).** Background catalog refresh now filters out non-free models from upstream endpoints so paid models requiring an API key no longer leak into your picker.
- **Relay pool automatically recovers from dead deployments (fixes #5).** If a relay URL in your pool returns an infrastructure 404 (such as a missing or deleted Vercel deployment), the proxy marks it as failed and immediately rolls over to your next healthy relay or direct mode instead of getting trapped in a 404 loop.

### Changes

- **Updated model catalog (26 verified free models: 7 OpenCode Zen + 19 KiloCode Gateway).**
  - Added `inclusionai/ling-3.0-flash-sante:free` (Ling 3.0 Flash Sante, 262K context, 32K output, reasoning supported). Clean CLI alias `ling-3.0-flash-sante` supported.
  - Removed `laguna-s-2.1-free` (OpenCode Zen) after upstream dropped free-tier access. `poolside/laguna-s-2.1:free` on Kilo remains active.
- **Public by default for new relay deployments.** Relays deployed via `/freeflow deploy` are now public by default with no mandatory authentication tokens. This enables seamless copy-paste migration across proxy tools (such as 9router) while maintaining safety guards for allowed AI upstreams.

### Validation

- TypeScript typecheck passed cleanly (`tsc --noEmit`).
- Full test suite passed across Windows (299 tests) and Ubuntu Linux (`acerblue-local`, 300/300 tests passed).
- End-to-end concurrency and failover stress testing verified (100 parallel requests, 20 subagent leases, burst failover).

## 1.9.6 - 2026-09-03

### Fixes

- **Hiding the status widget now sticks.** `/freeflow hide` survives restarts, new sessions, and background update notices — previously the widget could reappear on the next session.
- **Calmer startup with many sessions.** Sessions starting at the same time now converge on a single background proxy instead of each spawning its own; a spawn that never becomes ready falls back to in-process mode instead of running untracked.
- **Survives daemon restarts mid-session.** If the background proxy is replaced while sessions run, connected sessions re-register automatically instead of silently losing their lease (which could retire the daemon mid-use).
- **Stale-version cleanup targets the right process.** Windows port matching is now exact, and Linux without `lsof`/`fuser` resolves the holder via `/proc` instead of giving up.
- **`/freeflow logs --follow` no longer runs forever.** The live tail stops when the session ends and caps burst output; the update/install subprocess now has a 2-minute timeout.

### Validation

- `npx tsc --noEmit` clean, `npm test` 299 (298 pass + 1 Linux-only skip) + smoke green on Windows; stress harness 7/7 on Windows and Linux `acerblue-local`. **`macOS not tested`** this cycle.

## 1.9.5 - 2026-09-03

### Changes

- **Catalog refreshed against live upstream model lists (26 models: 8 OpenCode Zen + 18 KiloCode Gateway).** Re-checked both upstreams against their live endpoints and live inference probes:
  - **Added** `muse-spark-1.3-contributor-free` (OpenCode Zen, Responses API, 1M context, 131K output, vision) — verified live: completes with reasoning, accepts effort levels, and answers vision queries.
  - **Removed** `hy3-free` (OpenCode Zen) — upstream no longer serves it (`Model hy3-free is not supported`).
  - **Removed** `tencent/hy3:free` and `meituan/longcat-2.0-free` (KiloCode Gateway) — upstream free tier dropped them (model unavailable / sign-in required).
- Pruned IDs added to the dead-model filter so a stale disk cache cannot resurrect them.

### Validation

- `npx tsc --noEmit` clean, `npm test` full suite green on Windows.

## 1.9.4 - 2026-09-02

### Dependencies

- **Zero runtime dependencies.** Removed `undici@8.10.0` — `pi` (`0.84.4`) and `omp` (`18.1.3`) already bundle `undici` 6.x/7.x and expose `global fetch` with keep-alive pooling. `relayFetch` and proxy now use `global fetch` directly (`src/relay.ts` `Agent` + `canUseCustomDispatcher` + `dispatcher: agent` removed; `src/proxy.ts` dispatcher removed). Keeps thin `11.3k` + `298 tests` + `0 deps` compatible directly with `reference/pi` + `reference/oh-my-pi`.

### Validation

- `npx tsc --noEmit` clean, `npm test 298/298` on **Windows** (`omp/18.1.3`, `pi 0.84.4`) and **Linux `acerblue-local`** (`Ubuntu 6.8.0-138`, `node v22.23.2`, `pi 0.84.4`) via `/tmp/pi-freeflow-validation`. **`macOS not tested`** this cycle.

## 1.9.3 - 2026-09-02

### Fixes

- **Windows console flood fixed.** Two Windows-only helpers flashed a visible `conhost`/`cmd` window on every daemon probe: `netstat -ano | findstr :28180` / `taskkill` in the stale-daemon replace path and `spawn(omp|npm, shell:true)` for `/freeflow update`. Both now use `windowsHide: true` (no-op on Linux/macOS) and `spawnWithProgress` was refactored to `Promise.withResolvers` to satisfy `ts-promise-with-resolvers`. Idle `pi` no longer spawns many visible consoles even after closing the terminal (detached daemon at `127.0.0.1:28180` survives by design; `beatOnce` 10s heartbeat now throttled 2s via `lastSpawnAt`).
- Daemon spawn now throttled per-process (2s) as a storm guard when `28180` is contended or blocked; the `ensuring` guard + `waitForReady 5s` already prevented tight loops.

### Validation

- `npx tsc --noEmit` clean, `npm test 279/279` on **Windows** (`omp/18.1.3`, `pi 0.84.4`) and **Linux `acerblue-local`** (`Ubuntu 6.8.0-138`, `node v22.23.2`, `pi 0.84.4`) via `/tmp/pi-freeflow-validation`. **`macOS not tested`** this cycle.
- Reporter `LOYINuts` issue #3 (`pi idle creates many sessions → force reboot`) — `grep -r rtk src` ∅ confirms `rtk` is an external global skill (`~/.agents/skills/rtk` → `Command::new("cmd")` without `CREATE_NO_WINDOW`), not `pi-freeflow`. After this fix, closing the terminal no longer leaves flashing zombies; kill via `netstat -ano | findstr :28180` → `taskkill /F /PID` or `/freeflow kill`.

## 1.9.2 - 2026-08-31

### Fixes

- **Closing one session no longer stops the shared local proxy.** The proxy daemon
  is now a fully detached background process: it outlives any single OMP/Pi session
  (previously, closing the session that owned the daemon could shut it down even
  while other sessions were still using it). It retires by itself only when no
  session is connected, no request is in flight, and it has been idle for a grace
  period. The next use starts it again automatically.
- New command: `/freeflow kill` (aliases `stop`, `shutdown`) stops the background
  daemon on demand. The next freeflow use restarts it.

### Improvements

- The proxy tracks connected sessions and last request time; `/freeflow status`
  and the health endpoint now report active session leases, so you can see when
  other sessions are keeping the daemon alive.
- Docs: the command reference now lists `kill`, and the FAQ explains the shared
  daemon lifecycle (survives session close; self-retires when unused).

## 1.9.1 - 2026-08-30

### Fixes

- Stale-daemon guard completed: a pre-1.9.0 daemon cannot report its in-flight requests, and usage cannot be verified — so it is now left running instead of being replaced. Previously such a daemon could still be killed mid-stream while busy (a one-time window when upgrading from 1.8.x). The guarantee now holds in every case: only older, verified-idle daemons are replaced.
- The stale-daemon kill ritual was consolidated into one path (it was duplicated at five call sites); behavior unchanged.
- Tests: new coverage for the pre-1.9 daemon case; shared sandbox helpers extracted.

## 1.9.0 - 2026-08-30

### Development hardening

- Test suite now runs fully sandboxed: every test uses a temporary data directory, so no test can ever write to your real `~/.pi/agent/` files or interfere with a running local proxy. A single env override (`PI_*_DATA_DIR`) re-roots all data files for tests/CI.
- Added a complete mocked user-flow e2e suite: fresh install → onboarding → proxy health → direct chat → relay add/roll/fallback → guided deploy → update check → command surface — all deterministic, zero network.
- Docs: test counts no longer hardcoded in README (they drifted with releases); release history tracked here.

### Fixes

- **Stale-daemon replacement no longer interrupts running sessions.** The shared local proxy can be held by another OMP/Pi session; the old upgrade logic killed that holder on version mismatch, which could terminate the session that owned the proxy mid-stream. Replacement now only happens when the running daemon is strictly older AND idle (0 in-flight requests, reported via `/_health`); newer or busy daemons are reused with a log note instead. Optional opt-out: set the no-kill env to `1` (see README FAQ for upgrades).

## 1.8.2 - 2026-08-30

### Fixes & polish

- Deploy: compare-and-swap on concurrent deployments (no duplicate relays when two sessions deploy at once).
- Proxy: URL-encoding edge cases (`%` in paths), startup timeout and kill handling, port conflict fallback.
- Logs: sanitized sensitive headers in debug output.
- Kilo gateway models: compatibility pass for all 25 models.
- Docs site build included; README per-host usage guide (Oh My Pi & Pi install + pick + manage).

## 1.8.1 - 2026-08-29

- Fix: stale-daemon auto-heal is now shipped in the published package (previously only in the repo).

## 1.8.0 - 2026-08-29

### Automatic upgrades

- On version upgrade, the extension detects a stale local proxy daemon and replaces it automatically — users get fixes without manual restarts or killing sessions.
- Fix: client auth key stripped before reaching the opencode.ai/zen upstream (failed with 401 for some clients).
- 3 new free models (28 total).

## 1.7.1 - 2026-08-29

- Docs: clarified npm is the distribution channel (the package is an extension loaded by OMP/Pi, not a standalone CLI).

## 1.7.0 - 2026-08-29

- 4 new free models (25 total) with live-verified specs (context/output limits, vision, thinking levels).
- New alias map aligned with host model selectors.

## 1.6.1 - 2026-08-29

- Catalog: thinking-level map locked per model; docs sync.

## 1.6.0 - 2026-08-29

### Onboarding & UX

- First-run onboarding message; 429 guidance hint (add your own relay egress).
- `/freeflow test` to probe a relay; relay latency tracking with health badges in `/freeflow list`.
- Guided deploy with context picker + confirmation; post-deploy health check.
- Status clarity: current mode + state file path; log text filter; per-relay usage counters; throttled roll notifications.

### Reliability

- Relay state write-protection: before every save, the current state is snapshotted to `.bak`; if the main file is corrupted or missing, the backup is recovered automatically.
- New-user flow never seeds a fake relay; starts in direct mode with an empty pool.

## 1.5.1 - 2026-08-28

- Edge-sweep fixes: port 28180 with legacy 18080 dual-probe auto-migration, OMP/Pi compatibility.
