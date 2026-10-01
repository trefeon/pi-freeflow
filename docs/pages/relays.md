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
| **HTTP 200 (OK)** | Success | In `auto` the winner becomes the sticky target; in `spread` the pool is left as-is |
| **HTTP 429 (Rate Limit)** | Roll to next relay | IP quota exceeded; fresh egress IP per relay |
| **Relay Edge 404 (Dead Deployment)** | Roll to next relay | Deployment missing or deleted on relay host; auto-failover |
| **HTTP 502 / 503** | Roll to next relay | Upstream edge transient error |
| **HTTP 504** | Fast fallback to direct | Vercel Edge 25s execution timeout |
| **HTTP 520-530** | Roll to next relay | Cloudflare network/origin drops |
| **Socket / DNS error** | Roll to next relay | Relay host unreachable |
| **Pool exhausted** | Direct upstream fallback | All relays failed; direct to provider |

## Relay Modes

| Command | Behaviour |
| :--- | :--- |
| `/freeflow off` | Always talk direct to upstream — no relays. |
| `/freeflow auto` | Default. Relay turns on when you pick a `freeflow/*` model. Every request starts at the active relay and rolls to the next healthy one on a rate limit, timeout, or edge failure. |
| `/freeflow on` | Always relay, regardless of which model is selected. |
| `/freeflow spread` | Relay turns on and each request starts at a rotating healthy relay instead of one sticky primary, so parallel sessions and subagents land on different egress IPs. A conversation's reasoning issuer still outranks the rotation, and a rate-limited relay is never preferred. |

## Relay Pool Management

Relay state is persisted in `~/.pi/agent/pi-freeflow-relay-state.json`:

```json
{
  "enabled": true,
  "mode": "auto",
  "url": "https://active-relay.workers.dev",
  "relays": [
    { "url": "https://active-relay.workers.dev", "label": "CF-Primary" },
    { "url": "https://backup-relay.vercel.app", "label": "Vercel-Backup" }
  ]
}
```

## Deployment Options

Deploy order: Cloudflare first, Deno second, Vercel only as a last resort.

### Cloudflare Worker (Recommended)
Free tier: 100,000 requests/day with no meter on origin transfer, so streaming stays free. Deploy via `/freeflow deploy cloudflare` or manually paste a 40-line edge worker script.

### Deno Deploy
Free tier: 100,000 requests/day. Deploy via `/freeflow deploy deno` or manual playground paste.

### Vercel Edge Function (Last Resort)
Only use with a paid plan or a spare Hobby project you can afford to lose: the Hobby plan caps Fast Origin Transfer at 10 GB, and a streaming relay burns roughly 1.2 MB per turn (about 8,000 turns total). Once the cap is hit, every deployment in the project returns HTTP 402 and the whole pool goes dark until the quota resets. Deploy via `/freeflow deploy vercel` (in-memory token, auto-adds to pool) or manual Git deploy with `api/relay.js` + `vercel.json`.
