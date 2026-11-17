---
"pi-freeflow": patch
---

Zen relay failover no longer cools a relay's network health when that relay simply refuses a `CONNECT` tunnel. Non-tunneling relays are skipped for the Bun transport lane as intended, and the structured refusal keeps the details the retry logic needs.
