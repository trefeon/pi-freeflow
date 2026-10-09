---
"pi-freeflow": patch
---

Correct the OpenCode Zen Step 5 Preview entry: it is a reasoning model with 1M context, 64K max output, text/image/video input, and only `low`/`medium`/`high` thinking levels (`minimal` is explicitly disabled). Previously the entry mirrored the Kilo sibling and the fallback heuristic, so the picker showed no thinking support.
