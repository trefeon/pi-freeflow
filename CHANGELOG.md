# Changelog

All notable changes to pi-freeflow. Public, user-visible behavior only.

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
