---
"pi-freeflow": patch
---

Recover from a frozen local proxy back to a proper background proxy. When the proxy stopped answering but still held its port, recovery started a new proxy first; that proxy moved to the next port, where nothing ever connected to it, and the session ended up running the proxy inside its own process until restart. Now recovery clears the frozen proxy before starting a new one, a new proxy that cannot get its usual port exits instead of moving to another one, and when a fresh start freezes too, the port is cleared and the proxy is started one more time.
