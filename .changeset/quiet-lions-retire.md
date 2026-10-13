---
"pi-freeflow": patch
---

Three free models that no longer answer are gone from the picker

`cline-free/deepseek-v4.1-flash`, `cline-free/kimi-k3` and `cline-free/solar-pro4` were retired upstream, so every turn on them failed. All three were probed twice against the live service on 2026-10-13 and each time answered `404 model not found` ("Cline has no such model. Refresh the model list and retry."), while the two Cline models that survive — `cline-free/muse-spark-1.3-contributor` and `z-ai/glm-5.3-flash` — answered 200 with the same login and request shape. The login, the quota rollover and every other model are unchanged; the picker is now 36 models (10 OpenCode, 15 Kilo, 2 Cline, 9 OVH).
