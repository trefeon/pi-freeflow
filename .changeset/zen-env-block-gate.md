---
"pi-freeflow": patch
---

Fix OpenCode Zen free-tier requests being refused with `429 FreeUsageLimitError` ("Free usage limit reached") when the system prompt carries no environment block. The same body answers `200` with the block and `429` without it on the same machine, in the same minute, so the countdown to 00:00 UTC is a generic error body rather than a spent quota. Outgoing Zen requests now carry exactly one `<env>` block containing `Working directory:`: a complete block the host already sent is passed through untouched, a stale or incomplete one is replaced instead of duplicated, and the Kilo, Cline and OVHcloud lanes are unchanged. A conversation that already ate a refusal also keeps failing over to Kilo on its retry instead of replaying the refusal.
