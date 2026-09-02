# Full E2E Test Design — pi-freeflow (Issue #3 + All User-Facing)

**Scope:** thin provider — `model list + dumb proxy 127.0.0.1:28180 + log`. Host `pi-ai` owns thinking/normalization. Tests are sandboxed via `test/setup.mjs` (`PI_*_DATA_DIR → tmpdir`), `withIsolatedRelayFiles` must capture `RELAY_STATE_FILE` + `.bak`.

**Envs validated:** `Windows` `omp/18.1.3` `pi 0.84.4` + `Linux acerblue-local` `Ubuntu 6.8.0-138` `node v22.23.2` `pi 0.84.4` (`/tmp/pi-freeflow-validation` `pnpm i` `tsc 0` `279/279`). `macOS not tested` this cycle.

**Existing:** `26 files, 279 tests` (`unit 80%`, `integration 15%`, `e2e 5%` — `catalog.test.ts`, `daemon-lease.test.ts`, `e2e-new-user.test.ts`, `lifecycle.test.ts`, `mock-upstream-e2e.test.ts`, `stream-pipe.test.ts`, etc.).

---

## 1. Claim & Failure Modes

**Claim:** Installing `pi-freeflow` never creates sessions/consoles when `pi` is idle, and never flashes a visible `cmd`/`conhost` on Windows; `pi` stays responsive after `pi` idle + close terminal (daemon survives correctly, retires cleanly, killable via `/freeflow kill`).

**Wrong if:** daemon `process.exit(1)` loop → `beatOnce` spawns storm; `killPortHolder`/`spawnWithProgress` without `windowsHide` flashes; `ensuring` guard missing → concurrent `ensureDaemon` spawns; `rtk` global skill wraps every `bash` → `cmd /C` flash (external, but must not be amplified); lease GC retires live daemon; version-mismatch kills busy daemon; catalog/update fetch hangs.

---

## 2. Evidence Path (Preferred → Alternatives)

**Preferred (fast, deterministic, no external network):** mocked `spawn`/`execSync` capture + sandboxed `fetch` mocks + `withIsolatedRelayFiles` + `startProxy` on ephemeral ports + `Agent` keepAlive checks. Already used in `daemon-lease.test.ts`, `user-flow.test.ts`.

**Alt weaker:** live `pi` TUI screenshot (flaky, slow). **Alt stronger:** real `pi` install on `acerblue` + `pi --help` smoke (minutes).

---

## 3. User-Facing Matrix (All Scenarios → Edge → Test)

| # | User Flow | Happy | Edge / Failure | Current Test | New Test (Issue #3) |
|---|---|---|---|---|---|
| **A. Install** | `omp plugin install pi-freeflow` / `omp plugin link .` / `pi install npm:pi-freeflow` | registers `28 models` via `registerProvider("freeflow", baseUrl 127.0.0.1:28180)` | linked install (`isLinkedInstall` → symlink at `extensions/index.ts`) skips `checkForUpdateInBackground`; `node <22.19` rejected by `engines` | `host-compat.test.ts`, `update-checker [h1]` | — |
| **B. Fresh install idle** | `pi` → `session_start` → no prompt, should not spawn sessions/consoles | `ensureDaemon` probes `28180`+`18080`, `spawnDaemonProcess` once (`detached:true, stdio:"ignore", windowsHide:true`), `attachTo` + `10s heartbeat` + `touchActivity()` at bind | `28180` blocked by AV/firewall → `waitForReady 5s` timeout → fallback `startProxy` in-process; `process.execPath` is `node` (not `pi` bun binary) — verify `isBunRuntime`; concurrent `session_start`+`model_select` ( `ensuring` guard → second returns `attachedPort||PORT`); rapid `beatOnce gone` → `lastSpawnAt` 2s throttle | `lifecycle [a-f]`, `daemon-lease` | **`issue-3-regression.test.ts`: idle creates 0 `node` processes (mock `spawn` count==1, `tasklist` stable over 30s heartbeat cycles)** |
| **C. Pick model** | `/model → freeflow → muse-spark-1.2:…` / `pi -p --model freeflow/...` | `model_select` → `ensureDaemon` → `setActiveRelayState(freshRelay)` if `mode!="off"` → `updateStatusBar`; `buildProviderConfig` maps `:effort` via `thinkingLevelMap` | invalid `modelId` → `isFreeFlowModelMatch` false → `ui.setStatus("freeflow", undefined)`; `ctx.model` missing → defaults to `true` so widget present | `user-flow [1/6]`, `models.test.ts` | — |
| **D. Chat (opencode vs kilo)** | `freeflow/mimo-v2.5-free` (Zen `openai-responses`) vs `kilo-auto` (`Bearer kilo-free`) | `isKilo` routing → `relayFetch(KILO_CHAT_URL)` vs `Upstream opencode` direct/relay; `stream:true` pipes `Readable.fromWeb` + `x-relay-target` | body >32MB → `413`; `stream` truncated mid-SSE → synthetic `response.incomplete`/`failed` (`stream-pipe.test.ts`); `AbortError` vs `FF_INTERNAL_ABORT` (`relayFetch` cancels `body` on roll) | `mock-upstream-e2e`, `stream-pipe.test.ts`, `relay.test.ts`, `error-matrix` | **`stream-pipe` add: `[DONE]` split across chunks, late `response.completed` coalesced (already locked)** |
| **E. Relay pool** | `direct` (empty pool) vs `auto` (`add`/`deploy` → `getOrderedRelayUrls` round-robin) | `willUseRelay` guard bypasses local `checkRateLimit` when pool active; `429/408/502/503/504/520-530` → `markRelayFailure` → cooldown `30-90s` escalates `4x` → next relay; `getRateLimitStatus` `hint` throttled 10min | all relays `429` → direct fallback; `client abort` ( `res.close` ) → **does not** mark failure ( `relay-state` counters unchanged); `isPrivateRelayHostname` rejects `localhost, 127.0.0.1, 192.168/16, 10/8, fc/fd, fe80` unless `ALLOW_UNSAFE=1` | `relay-state*`, `rate-limiter*`, `rate-limit-hint` | **`windows-hide.test.ts`: assert `killPortHolder` / `spawnWithProgress` called with `windowsHide:true`** |
| **F. Commands** | `/freeflow status/list/use/add/label/remove/test/on/off/auto/deploy/logs/trace/refresh/update/debug/kill` (10+ cmds) | `createCommandSpec` → `updateStatusBar` + `withRelayState` CAS; `deploy` builds `Vercel/Cloudflare/Deno` worker with `x-relay-auth` denylist (14 headers), `ALLOWED_TARGETS` `opencode.ai, api.kilo.ai` | `add <url>` invalid → `validateRelayUrl` error; `remove` last relay → `enabled=false` but `mode=auto` stays; `test <idx>` probe timeout `PROBE_TIMEOUT_MS 5s`; `logs [n] --follow` poller re-baselines on rotation; `update` with `shell:true` for `.cmd` shims must be `windowsHide:true` | `commands.test.ts`, `commands-surface.test.ts`, `deploy.test.ts`, `edges-commands` | **`commands-surface` add: windowsHide assertion** |
| **G. Daemon lifecycle** | close one `pi` session → daemon outlives others, retires when `leaseCount 0 && activeRequests 0 && idle >10s grace` | `registerClient`/`renewClient`/`unregisterClient` + `startLeaseGC(ttl 30s, gc 5s, grace 10s)` + `touchActivity` at `bind` + `/_client/attach|heartbeat|detach` + `/_health` `activeRequests` guard | older idle daemon `compareVersions >0` → `killStaleDaemon` → `killPortHolder` (netstat→taskkill `windowsHide:true`) → re-spawn; older **busy** (`activeRequests>0`) or **newer** → reuse (`lifecycle [b,c]`); `NO_KILL=1` or pre-1.9 (`activeRequests undefined`) → reuse; `EADDRINUSE` → try `28181..28200` (20 attempts) then attach to winner; `bind fail → process.exit(1)` → client fallback to `startProxy` in-process | `daemon-lease.test.ts`, `lifecycle.test.ts` | **`daemon-storm.test.ts`: simulate `bind fail` + `beatOnce gone` every 10s → `spawn` count throttled to ≤1 per 2s, no leaked `fallbackServer`** |
| **H. Catalog** | `refreshCatalog` on boot, `24h TTL`, `ETag If-None-Match → 304` → extend timestamp | `readCatalogCache` / `writeCatalogCache` atomic `tmp+rename` + `ETAG`; `mergeCatalog` keeps base `28`; `DEAD_MODEL_IDS` filtered (`deepseek-v4-flash-free`, `x-preview-f-free`) | network hang → `CATALOG_REFRESH_TIMEOUT_MS 10s` → fallback to `stale disk` → `static ALL_MODELS`; corrupt cache → `static 28`; `force:true` bypasses TTL | `catalog.test.ts`, `edges-catalog`, `e2e-new-user [g1-3]`, `activation [i1]` | — |
| **I. Update** | `checkForUpdateInBackground` on `extension init` + `session_start` + `model_select` | `UPDATE_CHECK_TTL_MS 24h`, `isLinkedInstall` skip, `compareVersions` → `ui.setStatus("freeflow","update: …")` | `fetch REGISTRY_URL` 404/offline → swallow; `latest==local` → silent; `status/update` cmds handle offline | `update-checker [h1-2]`, `onboarding` | — |
| **J. Security** | `validatePath` `/v1/...` + `ALLOWED_METHODS GET|POST|OPTIONS|HEAD` + `MAX_BODY_BYTES 32MB` + `sanitizeHeaders` denylist 14 + `x-relay-target` allowlist | `pathTraversal` `..` → `403`; oversized `content-length` → `413` before buffering; `host` header stripped | private SSRF via `x-relay-auth` never forwarded | `config-and-security`, `proxy-server`, `relay.test` | — |
| **K. Logs** | `~/.pi/agent/pi-freeflow.log` `10MB×10` (110MB), `log` level `debug/info/warn/error/audit` (audit freezes) | `readRecentLogs` filter `level|reqId|text` + `logsFollowTimer` 1s poll (re-baseline on rotate) | `LOG_MAX_BYTES` rotation | `logger-filter` | — |
| **L. External `rtk`** | not `pi-freeflow` (`grep -r rtk src` ∅) — global `~/.agents/skills/rtk` tells LLM to prefix `rtk` → `rtk/src/main.rs:2214` `Command::new("cmd").arg("/C")` **without** `CREATE_NO_WINDOW` → flash per bash call | loop on `429` → LLM retries `bash rtk …` → flood | — | **`issue-3-regression`: assert `grep rtk src` ∅ + doc `rtk` is external, `windowsHide` on our spawns hides our flashes, but `rtk` upstream needs `CREATE_NO_WINDOW` (tracked separately)** |
| **M. Idle leak (reported)** | `pi` idle with extension → `tasklist | findstr node` stable, `ls ~/.pi/sessions` stable, `~/.pi/agent/pi-freeflow.log` no `spawnDaemonProcess` storm | `close terminal` → `stopHeartbeat` → `detach` → daemon retires after `TTL 30s + grace 10s` if no other clients; `/freeflow kill` immediate | lingering `node --experimental-strip-types daemon.ts` after uninstall → `netstat -ano | findstr :28180` → `taskkill` | `daemon-lease` | **`idle-leak.test.ts`: start daemon, attach 1 client, idle 15s → `getLeaseCount 0` → daemon retires, no new sessions`** |
| **N. Cross-platform** | `windowsHide:true` no-op on Linux/macOS (`createLocalShellOperations` `windowsHide:true` already) | Linux `acerblue` `windowsHide` ignored, still `279/279`; `macOS not tested` noted in `CHANGELOG 1.9.3` | `host-compat` | — |

---

## 4. Verification Affordances (Durable)

* `test/setup.mjs` `PI_*_DATA_DIR → tmpdir` (already) — isolates `RELAY_STATE_FILE/.bak`, `LOG_FILE`, `CATALOG_CACHE`, `UPDATE_CACHE`, `ONBOARDED_FLAG`.
* `test/_sandbox-helpers.ts` `withIsolatedRelayFiles` (captures `.bak`) — used in `relay-state-lifecycle.test.ts`.
* New helpers needed: `captureSpawnOptions()` (mock `child_process.spawn`/`execSync` to assert `windowsHide:true`), `withMockedBeatOnce` (advance timers 10s, assert `spawn` count), `withIsolatedDaemon` (ephemeral `PORT`).

---

## 5. Test Design (New Files for 1.9.3)

```
test/windows-hide.test.ts          // small, mock spawn/execSync → windowsHide:true on win32
test/daemon-storm.test.ts           // medium, beatOnce gone → throttled storm (fake timers)
test/idle-leak.test.ts              // medium, lease GC → retire after idle, no session leak
test/issue-3-regression.test.ts     // large, user-flow: pi idle → 0 new sessions/consoles over 3 heartbeats
```

Each test: **Arrange** isolated tmpdir + mock fetch/spawn, **Act** `ensureDaemon` / `beatOnce` / `startProxy`, **Assert** `spawn calls`, `getLeaseCount`, `getActiveRequests`, `isProxyAlive`, `windowsHide` flag — DAMP, one concept per `it`.

---

## 6. Runnable Path

```bash
# Windows + Linux acerblue-local (macOS not tested)
pnpm install
npx tsc --noEmit
node --experimental-strip-types --import ./test/setup.mjs --test --test-concurrency=1 test/**/*.test.ts  # 279 → 283 with new 4
# smoke
node --experimental-strip-types -e "import('./extensions/index.ts').then(()=>console.log('✓'))"
# manual idle leak check (Windows)
tasklist | findstr node & pi & timeout /t 30 & tasklist | findstr node
cat ~/.pi/agent/pi-freeflow.log | grep -E "daemon|spawn|lease|throttled" | tail
```

**Close:** after implementation, `git diff` should be only `src/client.ts, src/commands.ts, src/proxy.ts, CHANGELOG.md, package.json` + 4 new tests; `gh run view` `CI` `3/3` green on `ubuntu-latest` + `macos` (expected fail `not tested` note) + `load k6` may be flaky → rerun.

