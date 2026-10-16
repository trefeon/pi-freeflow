---
"pi-freeflow": patch
---

Streaming requests now pass through replies that arrive in a non-streaming format instead of dropping the answer, concurrent startups share a single connection attempt instead of racing, and a foreign process squatting the local proxy port is no longer mistaken for the daemon we own.
