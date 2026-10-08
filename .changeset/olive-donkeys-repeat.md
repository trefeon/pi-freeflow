---
"pi-freeflow": patch
---

Removed one free model from the catalog that could never be used in a coding session. It answers a plain chat request fine, but rejects any request that carries tool definitions — and coding agents always send tools, so picking it failed on every turn with a "no endpoints found that support tool use" error. The catalog is now 30 models.