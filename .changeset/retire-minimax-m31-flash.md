---
"pi-freeflow": patch
---

Remove MiniMax M3.1 Flash from the free catalog: both free endpoints are gone. OpenCode Zen answers HTTP 410 with a model-level deprecation pointing at `deepseek-v4.1-flash-free`, and the KiloCode free id answers HTTP 404 "does not exist" while the gateway listing keeps only a paid id. Both leave the picker and both stay dead-listed, so a stale cache cannot bring them back. The `minimax-m3.1-flash` short name is removed rather than pointing at a paid model. The catalog is 35 models: 11 from OpenCode Zen, 15 from KiloCode Gateway, 1 from Cline, 8 from OVHcloud AI Endpoints.
