---
"pi-freeflow": patch
---

Kilo models work again. Kilo's gateway now rejects the placeholder credential the proxy used to send and accepts the same request without one, which broke every Kilo-model turn with a 401 "invalid token" error. The proxy no longer sends a credential for Kilo, so all 19 Kilo models answer normally again.
