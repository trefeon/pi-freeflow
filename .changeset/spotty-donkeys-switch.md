---
"pi-freeflow": patch
---

Remove three free models that stopped serving upstream, so they no longer appear in the model list:

- **Fledge Alpha** on OpenCode (`fledge-alpha-free`) — withdrawn upstream and no longer listed.
- **Ling 3.0 Flash Sante** on KiloCode (`inclusionai/ling-3.0-flash-sante:free`) — the free variant is gone; only the paid one remains.
- **Step 3.7 Flash** on KiloCode (`stepfun/step-3.7-flash:free`) — the free variant is gone; only the paid one remains.

All three are excluded permanently, so a stale on-disk catalog or a later catalog refresh cannot bring them back.
