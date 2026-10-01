---
"pi-freeflow": patch
---

Remove two free models that had stopped serving upstream, so they no longer appear in the model list:

- **Ling 3.0 Flash Fin** on OpenCode (`ling-3.0-flash-fin-free`) — upstream answers `400 Endpoint is unavailable`.
- **Ling 3.0 Flash Fin** on KiloCode (`inclusionai/ling-3.0-flash-fin:free`) — upstream answers `404 does not exist`.

Both are excluded permanently, so a stale on-disk catalog or a later catalog refresh cannot bring them back. The short name `ling-3.0-flash-fin` no longer resolves; `ling-3.0-flash-sante` is unaffected and still works.
