---
"pi-freeflow": patch
---

Following logs now reads only the lines appended since the last tick instead of re-reading the whole log file every second, so `/freeflow logs --follow` stays light even on large logs.
