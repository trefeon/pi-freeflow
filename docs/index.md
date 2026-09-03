---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "pi-freeflow"
  text: "26 free models. Up to 1M context. Zero API keys."
  tagline: "Thin OMP/Pi provider: model list + dumb relay proxy + log. Host pi-ai owns thinking & normalization."
  actions:
    - theme: brand
      text: Get Started
      link: /pages/architecture
    - theme: alt
      text: View on GitHub
      link: git+https://github.com/trefeon/pi-freeflow

features:
  - title: "26 Curated Free Models"
    details: 8 OpenCode Zen + 18 KiloCode Gateway — up to 1M context, 512K output, vision support, no API keys.
  - title: "BYO Relay Pool"
    details: Round-robin across your Cloudflare Workers, Vercel Edge, and Deno Deploy for zero upstream rate limits.
  - title: "Adaptive Failover"
    details: Auto-rolls on 429/5xx, cooldown for unhealthy relays, transparent direct fallback when pool exhausted.
  - title: "Master/Worker Proxy"
    details: Single-port 28180 shared across OMP subagents — 0ms startup for parallel workers, no port conflicts.
  - title: "Thin by Design"
    details: No build step, one runtime dep, no payload normalizer — host pi-ai owns thinking and reasoning translation.
  - title: "Observable Logging"
    details: Auto-rotating 10MB file logger at ~/.pi/agent/pi-freeflow.log with request correlation IDs.
---
