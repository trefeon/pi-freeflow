---
"pi-freeflow": patch
---

Fix tool calls being rejected with an invalid-arguments error when a model makes
several calls in one turn. Some models label every parallel call `0`, so the
pieces of different calls were joined together and arrived as one unreadable
blob — a planning tool could then reject every update, even a minimal one, and
leave its task list stuck mid-turn. Calls are now kept apart by their own
identifier, and a call whose text arrives in several pieces still reassembles
whole.