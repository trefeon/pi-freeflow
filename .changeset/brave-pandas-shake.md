---
"pi-freeflow": minor
---

Every tool from both supported hosts now works on every free model, including the models served on the dedicated responses endpoint. The proxy also tracks the latest client version in the background and always identifies itself with a supported one, so free-tier access keeps working as new releases come out.

Also new: a daily automated check watches for upstream changes (new releases, free-model list and pricing changes) and files an issue when anything drifts, plus an opt-in script that verifies all tools end-to-end against the live free tier.
