---
"pi-freeflow": minor
---

OpenCode Zen requests now use the relay pool while keeping the Bun transport. Relays that answer `CONNECT` carry only the TCP connection, so the TLS handshake and request bytes still originate from the local Bun sidecar and the free tier keeps working while the egress address changes. Worker relays that cannot tunnel are skipped for this lane without a health mark instead of disabling the pool.

Rate-limit failover also distinguishes what was actually exhausted. A 429 with quota language cools only that relay and that model family (`modelId[:2]`) for 90 seconds, so the same relay keeps serving other models; a bare `FreeUsageLimitError` that cannot be classified from the body probes the next candidate first, and only an egress that serves settles the earlier refusals as quota. `/freeflow status` lists the active per-model cooldowns.
