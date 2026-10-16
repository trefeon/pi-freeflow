---
"pi-freeflow": patch
---

Fix a batch of verified edge cases: non-ASCII streaming text is no longer corrupted when a character spans network chunks, assistant text stays visible on the responses path when it is served from a chat-only upstream, tool-argument repair also works on strict tool schemas, a relay that rejects our auth rolls to the next egress instead of being marked healthy, the update flow restarts the proxy it is actually attached to, and daemon/health state handling no longer loops or reads stale data.
