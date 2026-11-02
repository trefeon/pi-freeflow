---
"pi-freeflow": patch
---

Split oversized source modules into focused files with no behavior change. The proxy, command registry, stream pipeline, fingerprint, tool translation, Cline pool, and config internals now live in single-responsibility modules behind the same import paths, so updates and reviews land in smaller files while every command, lane, and gate behaves exactly as before.
