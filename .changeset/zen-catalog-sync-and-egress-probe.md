---
"pi-freeflow": minor
---

- Update the OpenCode Zen free-model catalog: retire `glm-5.3-flash-free` and `inkling-2-small-free`, add `tidepool-alpha-free` (`tidepool` alias, 1M context, 131K output), enrich dynamically discovered Zen models from upstream `limit`, `modalities`, `capabilities`, and non-free twin specs, and skip non-chat protocols automatically.
- Add egress-identity verification (`/freeflow test pool` and `/freeflow test <target> --egress`) to inspect relay exit IPs / IPv6 `/64` blocks and warn when saved relay URLs share an upstream egress.
- Share upstream quota cooldown buckets across Zen models backed by the same quota (`deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-super-vl-free`), detect in-band `FreeUsageLimitError` frames during streaming for sibling-relay failover, and update live OpenCode CLI version discovery to OpenCode's CLI release feed.
