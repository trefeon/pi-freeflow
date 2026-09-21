---
"pi-freeflow": patch
---

Removed Union Alpha from the model list. It stopped being served upstream: every request is rejected as an unsupported model, on both the chat and the Anthropic Messages paths, so picking it only produced an error. It is gone from model selection and cannot come back through a stale catalog cache. The Anthropic Messages request path itself stays supported for future models.
