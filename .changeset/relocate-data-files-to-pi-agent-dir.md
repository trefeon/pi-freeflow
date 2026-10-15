---
"pi-freeflow": minor
---

Follow pi's config-dir global: data files (relay state, logs, caches — including the staged daemon sources) now root at `PI_CODING_AGENT_DIR` when set, instead of always `~/.pi/agent`. CI and containers can relocate pi's config dir once and the extension writes alongside it. A leading `~` in either override expands to the home directory, and `PI_FREEFLOW_DATA_DIR` still overrides everything.
