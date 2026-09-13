---
"pi-freeflow": patch
---

Sessions survive a relay change without a rejected turn.

Responses models sign each thinking block for the upstream backend that produced it, and only that backend can read it back. When a later turn reached a different backend, the replayed blocks were rejected as unreadable ("reasoning `encrypted_content` was not issued to this caller"), the host repeated the same failing request, and the session could not continue.

pi-freeflow now keeps each conversation on the relay that issued its reasoning while that relay is healthy, and when a relay change is unavoidable (rate limit, relay removed or redeployed, direct-mode switch) it sends that turn without the signed thinking blocks, so the new backend accepts it on the first attempt. If a rejection still happens (the provider can change backends behind a relay), the request is retried once without the blocks, and only the rejected blocks are dropped on later turns, so the model keeps whatever reasoning the current backend can read. Messages, tool calls and tool results are always preserved.
