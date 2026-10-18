# Multi-Cloud Egress Relays & Failover

pi-freeflow features a rolling egress proxy architecture that distributes requests across multiple cloud providers, preventing IP rate limits and providing high availability through automatic failover.

## The `x-relay-target` Egress Pattern

Instead of VPN tunnels, pi-freeflow talks to two families of relays over one contract: **serverless edge workers** (Cloudflare Workers, Vercel Edge Functions, Deno Deploy) and **self-hosted egress pools** (the WARP pool below):

```
[Local Proxy :28180]
       │
       │ (1) Request with headers:
       │     x-relay-target: https://opencode.ai
       │     x-relay-path: /inference/v1/chat/completions
       ▼
[Relay — edge worker or self-hosted pool]
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
| **HTTP 403 from a relay** | Roll to next relay, relay marked failed | An egress that transforms the request fingerprint (e.g. stripped User-Agent) makes the free-tier gate reject everything from that relay; without this it could be recorded healthy and pinned as primary |
| **Relay Edge 404 (Dead Deployment)** | Roll to next relay | Deployment missing or deleted on relay host; auto-failover |
| **HTTP 408 (Request Timeout)** | Roll to next relay | Transient request timeout; treated as retriable like the other edge failures |
| **HTTP 502 / 503** | Roll to next relay | Upstream edge transient error |
| **HTTP 504** | Roll to next relay | The response already arrived, so there is no 25s wait to repeat; a sibling relay is worth trying before the direct fallback |
| **HTTP 413 (Payload Too Large)** | Continue to next relay, no health penalty | The pool is heterogeneous — one platform caps request size lower than another, so a later relay may well accept it; a failure mark would wrongly report a healthy relay as failed |
| **HTTP 520-530** | Roll to next relay | Cloudflare network/origin drops |
| **HTTP 500 (Model Error)** | Retry once on next relay | Transient model-side failure; surfaces unchanged if the next relay fails too |
| **Interrupted stream** | Resume once on next relay | Stream cut mid-answer retries a text-only turn; turns already running tools are never replayed |
| **Socket / DNS error** | Roll to next relay | Relay host unreachable |
| **Pool exhausted** | Direct upstream fallback | All relays failed; direct to provider |

## Relay Modes

| Command | Behaviour |
| :--- | :--- |
| `/freeflow off` | Always talk direct to upstream — no relays. |
| `/freeflow auto` | Default. Relay turns on when you pick a `freeflow/*` model. Every request starts at the active relay and rolls to the next healthy one on a rate limit, timeout, or edge failure. |
| `/freeflow sticky` | Explicit sticky primary mode (alias for `auto`). Sticks to the active relay until an HTTP 429 rate limit or edge error occurs before rolling. |
| `/freeflow on` | Always relay (sticky primary), regardless of which model is selected. |
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

## Choosing a relay setup

Both families implement the same `x-relay-target` contract and can sit in the
same pool. What separates them is how many egress addresses you control:

| | Self-hosted WARP pool | Serverless edge worker |
| :--- | :--- | :--- |
| Egress IPs | N dedicated, yours to rotate | one shared platform egress per relay |
| Upstream rate limits | spread across N IPs — the Zen free tier counts per IP, so N relays buy N bursts | one IP's quota per relay |
| Platform quotas | none (your host's bandwidth) | 100k requests/day (Cloudflare, Deno); 10 GB transfer (Vercel Hobby) |
| Request fidelity | the client's fingerprint forwarded as-is | Deno rewrites `User-Agent` → Zen refuses |
| Infrastructure | one Linux host with Docker | none |
| Best for | OpenCode Zen traffic, parallel subagents | a zero-infra start, Kilo models, light use |

### Self-hosted WARP relay pool (recommended for OpenCode Zen)

[trefeon/warp-relay-pool](https://github.com/trefeon/warp-relay-pool) runs a pool of isolated Cloudflare WARP egress addresses on one small host:

- **Many egress IPs, tiny footprint**: ~1.8 MiB of RAM per relay node; the default five-relay pool fits a 512 MB VPS (~50 MB of stack over a private mesh-VPN URL, ~160 MB with public tunnel URLs).
- **Automatic rotation**: a background service probes each egress and rotates only the throttled node when upstream answers HTTP 429, so client URLs stay stable while the address behind them changes.
- **No quotas, no rewriting**: your host's bandwidth, and upstream sees the client's own request fingerprint.
- **Same contract**: implements `x-relay-target`, so it can be pooled together with edge workers.

Setup: `git clone https://github.com/trefeon/warp-relay-pool.git && cd warp-relay-pool && ./setup.sh`, then register each relay it prints with `/freeflow add <url> <label>`. HTTPS relay URLs work as-is; mesh-VPN addresses in the private ranges pi-freeflow whitelists are accepted too. With several relays in the pool, `/freeflow spread` sends parallel sessions and subagents to different egress IPs.

## Zero-infra edge relays

Deploy order among edge relays: Cloudflare first, Deno second, Vercel only as a last resort.

### Cloudflare Worker (recommended edge relay)
Free tier: 100,000 requests/day with no meter on origin transfer, so streaming stays free. Deploy via `/freeflow deploy cloudflare` or manually paste a 40-line edge worker script.

### Deno Deploy
Free tier: 100,000 requests/day. Deploy via `/freeflow deploy deno` or manual playground paste.

**Known limitation:** Deno Deploy replaces the outbound `User-Agent` at the platform layer, so OpenCode Zen free-tier requests through a Deno relay are rejected with `403 FreeTierError` (verified 2026-10-17). The deploy flow warns about this up front, and its post-deploy inference probe surfaces the failure at deploy time rather than leaving a relay that silently cannot serve Zen traffic. Kilo models are unaffected. Prefer Cloudflare/Vercel for Zen traffic.

### Vercel Edge Function (Last Resort)
Only use with a paid plan or a spare Hobby project you can afford to lose: the Hobby plan caps Fast Origin Transfer at 10 GB, and a streaming relay burns roughly 1.2 MB per turn (about 8,000 turns total). Once the cap is hit, every deployment in the project returns HTTP 402 and the whole pool goes dark until the quota resets. Deploy via `/freeflow deploy vercel` (in-memory token, auto-adds to pool) or manual Git deploy with `api/relay.js` + `vercel.json`.


