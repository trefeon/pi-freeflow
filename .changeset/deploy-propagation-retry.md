---
"pi-freeflow": patch
---

Retry relay reachability verification after deployment so edge DNS and routing propagation delays (such as newly created Cloudflare Workers routes) do not show a false unreachable warning.
