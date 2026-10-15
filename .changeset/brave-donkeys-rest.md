---
"pi-freeflow": patch
---

Startup no longer stalls for several seconds when the extension is installed as a package and runs under Node.js: the detached proxy daemon is now launched from a staged copy of its sources (Node refuses to strip types for files under `node_modules`), a daemon that exits immediately is detected instead of being awaited for the full ready timeout, and a free base port is no longer mistaken for an unresponsive port holder.
