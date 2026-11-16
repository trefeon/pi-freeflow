# Multi-Cloud Egress Relays & Failover

pi-freeflow features a rolling egress proxy architecture that distributes requests across multiple cloud providers, preventing IP rate limits and providing high availability through automatic failover.

## The `x-relay-target` Egress Pattern

pi-freeflow talks to **serverless edge workers** (Cloudflare Workers, Vercel Edge Functions, Deno Deploy) and **self-hosted egress pools** (the WARP pool below) over two contracts, picked per lane:

**1. `x-relay-target` forwarding** (default) — the relay re-originates the request from its own egress:

```
[Local Proxy :28180]
       │
       │ (1) Request with headers:
       │     x-relay-target: https://opencode.ai
       │     x-relay-path: /inference/v1/chat/completions
       ▼
[Relay — edge worker or self-hosted pool]
       │
       │ (2) Whitelist validation (allows opencode.ai, api.kilo.ai & oai.endpoints.kepler.ai.cloud.ovh.net)
       │ (3) Strips x-relay-* headers, forges clean upstream headers
       ▼
[Direct Upstream Provider]
```

**2. `CONNECT` tunnel** — the relay carries only the TCP connection; the local process still performs the TLS handshake and sends its own request bytes:

```
[Local Bun sidecar] ──CONNECT opencode.ai:443──► [Relay egress] ──► [OpenCode Zen]
        │  (TLS + HTTP bytes originate locally)
```

The tunnel form is what lets OpenCode Zen free models use the relay pool at
all: the free tier fingerprints the TLS stack, so an egress that
re-originates the connection is refused no matter how fresh its IP is (see
[OpenCode Zen: native-TLS egress](#opencode-zen-native-tls-egress)).

## Failover Rules

| Status / Event | Action | Rationale |
| :--- | :--- | :--- |
| **HTTP 200 (OK)** | Success | In `auto` the winner becomes the sticky target; in `spread` the pool is left as-is |
| **HTTP 429 with quota language** | Roll to next relay, bucket cooldown | A real bucket exhaustion; the relay endpoint stays healthy, only that model family is parked |
| **HTTP 429 bare `FreeUsageLimitError`, request carries its `<env>` block** | Probe the next candidate, no health mark | The body alone cannot separate a quota bucket from a transport/shape refusal; an egress that serves settles the earlier refusals as bucket quota, and an all-ambiguous pool surfaces the original 429 without poisoning the relays |
| **HTTP 429 and the outgoing request lacks the `<env>` block** | Surface, no roll | A provable request-shape fault: every candidate answers it identically |
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

## OpenCode Zen: native-TLS egress

The Zen free lane checks the transport stack below HTTP: a request that rides
Bun's TLS stack is accepted while a Node or worker-fetch connection is refused
with `429 FreeUsageLimitError` even when the IP is fresh and the headers and
body are byte-identical (issue #120). That is why a relay that *re-originates*
the request cannot serve this lane, and why older builds disabled the pool
whenever `PI_FREEFLOW_ZEN_TRANSPORT=bun-sidecar` was set.

The fix is a tunnel, not a forward: a relay that answers `CONNECT` carries
only the TCP connection, while the local Bun sidecar keeps the TLS handshake
and the request bytes. The upstream therefore still sees Bun's fingerprint,
and the request still leaves through the relay's egress address.

| Requirement | Detail |
| :--- | :--- |
| Bun transport | `PI_FREEFLOW_ZEN_TRANSPORT=bun-sidecar`; Bun 1.1+ on `PATH` (or `~/.bun/bin`) |
| Relay capability | The relay must answer `CONNECT host:443` with `2xx`. `x-relay-auth`, when the pool entry has one, rides the `CONNECT` request and is never forwarded to the upstream |
| One URL per egress | Each pool entry is one tunnel and one upstream quota bucket; a URL that shares its platform egress with another buys nothing |
| Fallback | If no relay tunnels, the request goes direct through the same Bun sidecar — the pool is skipped, never the fingerprint |

Relays that answer `CONNECT` with a non-2xx (typical for edge workers) are
remembered as tunnel-incapable for 10 minutes and skipped for this lane with a
debug log. They are not marked failed: they still serve Kilo, OVH and the
other lanes through `x-relay-target`.

### Quota buckets are per model family

Zen tracks free-tier usage per egress **and** per model-id prefix
(`modelId[:2]`: `de` for `deepseek-*`, `ne` for `nemotron-*`, and so on).
A `429` therefore parks only that family through that relay:

- The relay stays healthy for every other family; its network health is untouched.
- The cooldown is short (90s) so the relay's own keep-cold rotation can hand back a fresh egress.
- `/freeflow status` lists the active cooldowns, e.g. `Quota cooldowns: relay-a[de] 42s`.
- A relay failure (socket, DNS, 5xx) is still relay-wide: a dead endpoint is dead for every family.

### Egress identity is not implied by a URL

A unique relay URL does not prove a unique upstream egress address. Several
Cloudflare Worker deployments can share a platform egress range, and Zen
refuses shared ranges outright (issue #116). What buys quota is a pool that
controls its own addresses — the self-hosted WARP pool below exposes one port
per egress and its keep-cold controller rotates a `/64` block when that relay
answers 429. Verify independence at the pool, not by counting pool entries.

## Choosing a relay setup

Both families implement the same `x-relay-target` contract and can sit in the
same pool. What separates them is how many egress addresses you control:

| | Self-hosted WARP pool | Serverless edge worker |
| :--- | :--- | :--- |
| Egress IPs | N dedicated, yours to rotate | one shared platform egress per relay |
| Upstream rate limits | spread across N IPs — the Zen free tier counts per IP, so N relays buy N bursts | one IP's quota per relay |
| Platform quotas | none (your host's bandwidth) | 100k requests/day (Cloudflare, Deno); 10 GB transfer (Vercel Hobby) |
| Request fidelity | the client's fingerprint forwarded as-is | Deno rewrites `User-Agent` → Zen refuses |
| Zen native-TLS tunnel | `CONNECT` on the same relay port, exact-origin allowlist | not offered — a worker cannot tunnel |
| Infrastructure | one Linux host with Docker | none |
| Best for | OpenCode Zen traffic, parallel subagents | a zero-infra start, Kilo models, light use |

### Self-hosted WARP relay pool (recommended for OpenCode Zen)

[trefeon/warp-relay-pool](https://github.com/trefeon/warp-relay-pool) runs a pool of isolated Cloudflare WARP egress addresses on one small host:

- **Many egress IPs, tiny footprint**: ~1.8 MiB of RAM per relay node; the default five-relay pool fits a 512 MB VPS (~50 MB of stack over a private mesh-VPN URL, ~160 MB with public tunnel URLs).
- **Automatic rotation**: a background service probes each egress and rotates only the throttled node when upstream answers HTTP 429, so client URLs stay stable while the address behind them changes.
- **No quotas, no rewriting**: your host's bandwidth, and upstream sees the client's own request fingerprint.
- **Same contract**: implements `x-relay-target`, so it can be pooled together with edge workers.
- **CONNECT on the same port**: the router also answers `CONNECT host:443` and splices a raw TCP pipe through that relay's egress, which is what keeps the Zen free lane's Bun TLS fingerprint while the IP changes.

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


