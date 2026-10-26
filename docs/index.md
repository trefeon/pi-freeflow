---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "pi-freeflow"
  text: "32 free models. Up to 1M context. Zero API keys."
  tagline: "Thin OMP/Pi provider: model list + relay proxy + logs. Host pi-ai owns thinking & normalization."
  actions:
    - theme: brand
      text: Get Started
      link: /pages/architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/trefeon/pi-freeflow

features:
  - title: "32 Curated Free Models"
    details: 8 OpenCode Zen + 15 KiloCode Gateway + 1 Cline + 8 OVHcloud AI Endpoints — up to 1M context, 384K output, vision support, no API keys.
  - title: "BYO Relay Pool"
    details: Round-robin across your own relays — a self-hosted pool that runs many egress IPs on one small host, or Cloudflare Workers / Vercel Edge / Deno Deploy workers.
  - title: "Adaptive Failover"
    details: Auto-rolls on 429/5xx, cooldown for unhealthy relays, transparent direct fallback when pool exhausted.
  - title: "Master/Worker Proxy"
    details: Single-port 28180 shared across OMP subagents — 0ms startup for parallel workers, no port conflicts.
  - title: "Thin by Design"
    details: No build step, one runtime dep, no payload normalizer — host pi-ai owns thinking and reasoning translation.
  - title: "Observable Logging"
    details: Auto-rotating 10MB file logger at ~/.pi/agent/pi-freeflow.log with request correlation IDs, plus a per-turn tool-call audit log for failed and retried turns.
---
