---
"pi-freeflow": minor
---

Security, wire-path and automation fixes from the October 2026 review:

- The local proxy now requires its own access token: every `/v1/*` and `/_*` request must carry `Authorization: Bearer <token>` (the token is written to the data directory on first start and the plugin supplies it automatically), the Host header must be loopback, and the daemon refuses to kill a process it cannot identify as its own. `GET /health` stays open for liveness checks. External tools that call the proxy directly must read the token file and send the header.
- A request for one model is never silently served by another: the internal Kilo 400 retry no longer substitutes a different model, so upstream verdicts reach the caller unchanged.
- Answers are no longer corrupted before they reach the client: a plain JSON reply that merely mentions `data:` is forwarded byte-identically instead of being replaced by an empty completion, a complete final SSE event that lost its trailing blank line is no longer dropped, and malformed tool arguments can no longer stall the proxy with a quadratic scan.
- Relay health reflects reality: an upstream 404 or 401 forwarded by a healthy relay no longer cools the pool, and a repeated 500 no longer resets the failing relay's health or steals the sticky slot.
- Cline logins: a rejected grant is parked instead of re-tried on every turn, a failed save is reported instead of being shown as saved, and logging out no longer leaves the removed token in the recovery file.
- Startup hooks and updates: the Windows logon task stores a command Windows can launch, a failed `systemctl --user enable` is reported, and auto-update no longer blocks the host while installing.
- Automation: the free-model health check has a timeout that fits a fully hanging catalog, a new guardrail keeps that budget honest, drift alerts close themselves once recovered, and the published-tarball check now also fails when the package ships a file the tree does not have.
