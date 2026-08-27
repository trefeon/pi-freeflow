# Multi-Cloud Egress Relays & Failover

pi-freeflow features a rolling egress proxy architecture that distributes requests across multiple cloud providers, preventing IP rate limits and providing high availability through automatic failover.

## The `x-relay-target` Egress Pattern

Instead of VPN tunnels, pi-freeflow uses standard edge worker scripts across **Cloudflare Workers**, **Vercel Edge Functions**, and **Deno Deploy**:

```
[Local Proxy :28180]
       │
       │ (1) Request with headers:
       │     x-relay-target: https://opencode.ai
       │     x-relay-path: /zen/v1/chat/completions
       ▼
[Edge Relay Proxy (Cloudflare / Vercel)]
       │
       │ (2) Whitelist validation (allows only opencode.ai & api.kilo.ai)
       │ (3) Strips x-relay-* headers, forges clean upstream headers
       ▼
[Direct Upstream Provider]
```

## Failover Rules

| Status / Event | Action | Rationale |
| :--- | :--- | :--- |
| **HTTP 200 (OK)** | Success (sticky active) | Active relay is saved as sticky target |
| **HTTP 429 (Rate Limit)** | Roll to next relay | IP quota exceeded; fresh egress IP per relay |
| **HTTP 404 / 410** | Roll to next relay | Stale or deleted edge deployment |
| **HTTP 502 / 503** | Roll to next relay | Upstream edge transient error |
| **HTTP 504** | Fast fallback to direct | Vercel Edge 25s execution timeout |
| **HTTP 520-530** | Roll to next relay | Cloudflare network/origin drops |
| **Socket / DNS error** | Roll to next relay | Relay host unreachable |
| **Pool exhausted** | Direct upstream fallback | All relays failed; direct to provider |

## Relay Pool Management

Relay state is persisted in `~/.pi/agent/pi-freeflow-relay-state.json`:

```json
{
  "enabled": true,
  "url": "https://active-relay.workers.dev",
  "relays": [
    { "url": "https://active-relay.workers.dev", "label": "CF-Primary" },
    { "url": "https://backup-relay.vercel.app", "label": "Vercel-Backup" }
  ]
}
```

## Deployment Options

### Cloudflare Worker (Recommended)
Free tier: 100,000 requests/day, no 25-second execution limit. Deploy via `/pi-freeflow deploy cloudflare` or manually paste a 40-line edge worker script.

### Vercel Edge Function
Free tier: 1,000,000 requests/month. Deploy via `/pi-freeflow deploy vercel` (in-memory token, auto-adds to pool) or manual Git deploy with `api/relay.js` + `vercel.json`.

### Deno Deploy
Free tier: 100,000 requests/day. Deploy via `/pi-freeflow deploy deno` or manual playground paste.
