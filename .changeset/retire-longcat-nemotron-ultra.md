---
"pi-freeflow": patch
---

Retire two OpenCode Zen models that upstream removed (issue #121): `longcat-2.5-preview-free` answers `410 Model has been deprecated`, and `nemotron-3-ultra-free` answers `400 Model is unavailable` — both ids are also absent from the live Zen free listing, so neither can serve traffic anymore. The catalog drops from 34 to 32 models (Zen lane 10 to 8); both ids are dead-listed so no stale disk cache or upstream merge can re-register them, and their `longcat` / `longcat-2.5-preview` short aliases are removed. The eight models that answered `429 FreeUsageLimitError` in the same run are untouched: rate-limit verdicts are an availability fault, never a catalog action. The sibling Kilo id `nvidia/nemotron-3-ultra-550b-a55b:free` is a separate serving route and is unaffected.
