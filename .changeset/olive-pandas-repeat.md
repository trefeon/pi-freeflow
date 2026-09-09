---
"pi-freeflow": patch
---

Oversized requests no longer fail at the relay hop: when a relay answers 413 payload limit, the proxy transparently tries the next relay and then the direct route, keeping the stream alive. Long sessions that outgrow the relay payload cap now complete instead of surfacing a function payload error.
