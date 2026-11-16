---
"pi-freeflow": patch
---

Stop the local proxy restart storm in hosts that run many sessions in one long-lived process, such as a web UI. Every session used to keep its own connection to the proxy, its own health checks and its own restart logic, and closed sessions kept them running. After a short stall dozens of them restarted the proxy at once, shut down each other's fresh proxies, and drove system load up. Now one process keeps one connection and one set of health checks, closed sessions release it, the last closed session disconnects, a recovery check that finds the proxy healthy again reconnects instead of restarting it, and the process exit cleanup is registered once instead of once per session.
