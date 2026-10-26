# OpenCode Free-Tier Gate

How the OpenCode Zen free tier decides whether to answer a request, measured
directly against the live gateway. This page exists because the answer is not
what the error message suggests, and because three widely-shared assumptions
about it are provably wrong.

Unless a line says otherwise, every result below was reproduced against
`https://opencode.ai/zen/v1` on 2026-10-08. Each row is a controlled
comparison: one variable changed, same request otherwise.

::: info 2026-10-15 Gateway Migration
OpenCode migrated keyless free-tier traffic from `/zen/v1` to `/inference/v1` (`/inference/v1/chat/completions` and `/inference/v1/responses`). The new gateway requires `Authorization: Bearer public`, non-empty tool parameter schemas, and omission of `x-opencode-request: msg_*` headers. pi-freeflow handles all of these transparently.
:::

## The refusal

A refused request answers `403` with a plain JSON envelope:

```json
{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}
```

From a plain external IP this is the **dominant** outcome: of 12 free-suffixed
model IDs on the Zen list, 11 were refused and only one answered.

Re-measured 2026-10-13, the twelfth is refused too: nothing on the free list
answers a bare probe. See [No exception](#no-exception).

Paid models fail differently and are not part of this problem:

| Class | Status | Body |
| --- | --- | --- |
| Free model, gate satisfied | `200` | SSE or JSON completion |
| Free model, gate refused | `403` | `FreeTierError` |
| Paid model, no key | `401` | `AuthError` — "Missing API key." |
| Model gone upstream | `400` | "Model is unavailable." |

## What actually opens the gate

**Four** request properties must **all** hold. Any one missing is refused, and
the refusal is the same `403` in every case, so the error never says which one
was wrong.

| # | Axis | Accepted | Missing |
| --- | --- | --- | --- |
| 1 | `User-Agent` | `opencode/1.19.4` and other `opencode/*` values | `403` |
| 2 | Session header | `x-opencode-session` **or** `x-session-affinity`, carrying a canonical id | `403` |
| 3 | Tool declarations | the placeholder sextet `{bash, glob, grep, read, edit, write}` | `403` |
| 4 | Streaming | `stream: true` | `403` |

Measured 2026-10-13 against `space-bunny-free` and
`nemotron-3.5-lightning-free`, on both the chat and the responses path, with
the other axes held correct:

| Variation | Result |
| --- | --- |
| all four axes | **`200`** |
| no request-identity headers at all | `403` |
| `User-Agent` alone, no session header | `403` (0/4) |
| every header except `User-Agent` | `403` (0/4) |
| `User-Agent` + `x-opencode-session` | **`200`** (2/2) |
| `User-Agent` + `x-session-affinity` | **`200`** (2/2) |
| `User-Agent` + `x-opencode-client` | `403` |
| `User-Agent` + `x-opencode-project` | `403` |
| `User-Agent` + `x-opencode-session-id` | `403` |
| `User-Agent` + `x-opencode-request` | `403` |

Two results in that table are worth dwelling on, because both were widely
believed to be the opposite:

- **`User-Agent` is load-bearing on its own account.** Dropping it from an
  otherwise complete header set turns `200` into `403`.
- **`x-opencode-session-id` is not the session header.** It is present in the
  set and is *not* sufficient — `User-Agent` plus `x-opencode-session-id` is
  still refused. The two header names the gateway accepts are
  `x-opencode-session` and `x-session-affinity`.

Axis 2 carries a value constraint, not just a presence check. The session id
must be one the upstream generator would have produced: prefix `ses_`, exactly
26 characters, the first 12 of them hexadecimal. A near-miss is refused —

| Session value | Result |
| --- | --- |
| generator output | **`200`** |
| correct prefix, 25 characters | `403` |
| `sesx` instead of `ses_` | `403` |
| a non-hex character inside the first 12 | `403` |

The **timestamp inside it is not range-checked.** Ids encoding 2000-01-01 and
2050-01-01 both answer `200`, as does one an hour in the future, so a session
id minted at start-up stays valid for the life of a long-running daemon. That
is fortunate, because pi-freeflow mints exactly one per process.

Two details worth stating precisely:

- **`stream: false` is refused, not just "no `stream` key".** Sending an
  explicit `stream: false` is refused the same way an absent key is. What the
  gateway requires is that the request is actually a streaming request. The
  proxy sends `stream: true` upstream regardless and converts the answer back
  for a caller that asked for JSON.
- **The placeholder tools must be declared, but never called.** They are
  compatibility stubs. pi-freeflow ships them as
  `OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read", "edit", "write"]`
  in `src/tool-translation.ts`, with a description telling the model not to
  call them. Requests without them are refused.

These four axes are stated where they are enforced, at the top of
`src/opencode-fingerprint.ts`. A fifth, body-side axis refuses with `429`
instead of `403` — see
[the other refusal](#the-other-refusal-429-freeusagelimiterror).

### No exception

`space-bunny-free` used to answer `200` in **both** shapes, with or without
streaming and tools, which made it the one model a bare probe could always
reach. That has stopped. Measured 2026-10-13, a direct request to
`https://opencode.ai/zen/v1/chat/completions` declaring no tools at all:

| Model | `stream` | Status |
| --- | --- | --- |
| `space-bunny-free` | key absent | `403` |
| `space-bunny-free` | `true` | `403` |
| `nemotron-3.5-lightning-free` | key absent | `403` |

All three returned the same envelope, and the middle row is the important one:
streaming on its own is no longer enough, where it was on 2026-10-08.

That is the whole explanation, and it is not that the model changed its mind.
On 2026-10-08 a request carrying no identity headers was accepted. It no longer
is, because the gateway now checks request identity as part of the gate. A model
that used to answer a probe with nothing but a model name now needs the same
four axes as every other model.

```json
{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

So the free list has no reachable model left to use as a control, and that
changes how a negative probe result should be read. A bare probe returning
`403` used to be ambiguous between "the probe is broken" and "the model is
gone`, and `space-bunny-free` settled it by always answering. It can no longer
settle anything, and a bare-probe `403` now proves neither hypothesis. Only a
request that satisfies all four axes, as in the gate table above, reaches a
model at all, so a refusal is only interpretable when it comes from that shape.

## The other refusal: `429 FreeUsageLimitError`

Measured 2026-10-24 (issues #117/#118). A request that satisfies all four axes
can still be refused, and this time it looks like a spent quota:

```json
{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Subscribe to OpenCode Go to keep going"}}
```

It is not the quota. Same machine, same minute, same model:

| System prompt | Status |
| --- | --- |
| `You are a coding agent.` | `429` |
| the same, plus an `<env>` block containing `Working directory:` | **`200`** |
| a block carrying `Platform:` / `Shell:` but no `Working directory:` | `429` |
| only an opening tag, or only a closing tag | `429` |
| the block in the 1st, 2nd or 3rd system message | **`200`** |

Repeating the pair six times flips `200`/`429` every six requests, and the
`retry-after` that arrives with the `429` keeps counting down to 00:00 UTC
while requests succeed — so that countdown is a generic error body, not a
window.

Two details decide whether a block works:

- **Only the first pair is read.** A stale, partial or duplicated copy above the
  real block shadows it, and the request is refused even though the real block
  is complete and correct. Exactly one pair must be present.
- **`Working directory:` is load-bearing.** Any value passes, but a
  plausible-looking block keyed `Platform:` or `Shell:` is refused.

pi-freeflow repairs this on the outgoing request for every Zen wire shape —
chat `messages[]`, Responses `instructions`, the Anthropic `system` field. A
block the host already sent that satisfies both rules rides through untouched;
anything else is folded into exactly one block appended to the last system
prompt. The Kilo, Cline and OVHcloud lanes are not touched.

This is separate from the relay egress refusal: a request that leaves through a
Cloudflare/WARP-class egress is refused whatever its body says, so a relay
`429` is not fixed by the block (see [Relays](/pages/relays)).

## What does not matter

Once all four axes are present, these make no difference to the outcome:

- `User-Agent` version, across `opencode/1.0.0` … `opencode/1.22.0` — the value
  matters, the exact version does not
- `x-opencode-client: cli` vs `desktop`
- `x-opencode-project`, whether the SHA-1 of the upstream git remote, the
  literal `global`, a random hex value, or empty
- `x-opencode-session-id` and `x-opencode-request` — on the pre-migration
  gateway both ride every request, and neither is one of the two session
  headers the gateway reads (the current `/inference/v1` gateway wants
  `x-opencode-request` omitted entirely)
- payload size, from ~100 B to ~640 KB
- a fresh session id per request vs one session reused across four requests
- the timestamp encoded in the session id, from 2000 to 2050

An earlier version of this page claimed request identity was not load-bearing at
all — "good hygiene, not the mechanism" — and was wrong. `User-Agent` and a
canonical session id are two of the four axes. For the current
`/inference/v1` gateway, `src/config.ts` sends: `Authorization: Bearer public`,
a `User-Agent`, `x-opencode-client`, `x-opencode-project`, the canonical `ses_…`
session on `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`
and `x-session-id`. It deliberately omits `x-opencode-request` (`msg_…`): on the
post-migration gateway that header marks the caller as a non-OpenCode client and
is refused with `403 FreeTierError`. The identity headers the gateway does not
read are kept because they cost nothing and matching the real client is the
safer default.

## The popular workaround, revisited

A widely-copied third-party plugin states that the lane is called with
`Authorization: Bearer public`. On the **old** `/zen/v1` gateway (measured
2026-10-08) that header was **actively harmful**:

| Authorization header | Status | Body |
| --- | --- | --- |
| *(none)* | `200` | completion |
| `Bearer public` | `401` | "Invalid API key." |

The 2026-10-15 migration to `/inference/v1` flipped this: that gateway
**requires** `Authorization: Bearer public` (see the migration note above), and
pi-freeflow now sends exactly that. Two different pieces of the code are easy to
conflate here:

- `sanitizeHeaders` in `src/proxy.ts` strips the caller's own `Authorization`,
  because the host provider registers with a dummy key and forwarding that
  placeholder upstream gets `401 Invalid API key`.
- `opencodeHeaders()` in `src/config.ts` then injects
  `Authorization: Bearer public`, which `sanitizeHeaders` copies onto the
  outbound request for the Zen lane. The Kilo and OVHcloud lanes stay keyless
  and send no `Authorization` at all.

So the placeholder-key trap above is real, but `Bearer public` is not it — it is
the credential the current gateway expects.

The same plugin describes the tool gate as a *fingerprint* the client must
present. The gate is not a fingerprint. The OpenCode client at tag `v1.18.35`
contains no required tool names and no free-tier tool check: its tools are
caller-supplied and filtered only by permission rules. The stubs exist because
this lane requires a tool declaration, not because it is checking one.

## Handling a refusal

A `403 FreeTierError` that comes back on the **direct** route is a terminal
upstream verdict, not a relay fault — the rule is stated in `src/proxy.ts` and
the state machine lives in `src/upstream-health.ts`.

That policy is **correct** for the direct route, and it is worth keeping
explicit, because the opposite looks reasonable: on a refusal, roll to a
different relay. Measured: all 10 relays in a healthy pool returned an
**identical** `403` for a model the running daemon served `200` at the same
moment. Rolling buys nothing and burns quota on retries.

A refusal that arrives **through a relay** is attributed differently
(2026-10-18): an egress that rewrites the request fingerprint — Deno Deploy
replaces the outbound `User-Agent` at the platform layer — refuses everything
that rides it, so the relay is marked failed and the request rolls once to the
next candidate or the direct route. A refusal from the direct route (or from
every candidate after the same request shape) is the gate itself and stays
terminal; the four axes above are then the thing to check.

On the direct route, what the daemon does instead is the right call: it records
the refusal, fails fresh sessions over to a healthy KiloCode model on the same
wire API, and remembers the rejection so a retried or resumed conversation
fails over immediately rather than replaying a refusal that cannot succeed.

## Variants to try once quota recovers

Right now the free tier answers every request with `429`, so no header or lane
change can be measured — every shape fails the same way. The three variants
below are recorded for the moment quota returns, so the comparison can run
then instead of burning requests now. Nothing about the default request
changes in the meantime: it keeps the `opencode/1.19.4`-style User-Agent, the
pinned project value, the `/inference/v1` lane with no usage-accounting
marker, and the six placeholder tools.

- **Newer client shape.** The client that passes the gate today identifies
  itself with a four-part string — name, channel, 2.x version, client kind
  (for example `opencode/latest/2.0.27/cli`) — where the default lane sends
  the older two-part form. Worth one controlled request pair: same session,
  same body, only the User-Agent differs.
- **Project value.** The default lane sends a fixed project identifier. The
  client instead sends the literal word `global` outside a repository and a
  digest of the working directory inside one. Worth the same one-variable
  comparison per value, since the gateway reads this header but has accepted
  every value tried so far.
- **Alternate lane plus usage marker.** The client addresses the free tier on
  a lane with an extra path segment and marks the body for usage accounting
  (`stream_options` carrying `include_usage`). Either half without the other
  is a different request than the client's, so test path and marker together
  against the default — never separately.

Run each comparison as a pair on the same model within the same minute, keep
the environment block in the system prompt (a request without it fails for an
unrelated reason — see above), and treat a transport-level difference as a
separate question: if the passing client and an identical replay from another
runtime disagree, no header variant will close that gap.

## Testing this yourself

A minimal direct probe that satisfies all four axes. The session id has to be
one the upstream generator would produce — `ses_` plus 26 characters, the first
12 hexadecimal. Anything hand-rolled and close enough to pass a shape check is
still refused:

```js
const session = "ses_" + createOpenCodeId(); // opencode's own generator

const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "opencode/1.19.4",      // axis 1
    "x-opencode-client": "cli",
    "x-opencode-session": session,        // axis 2
  },
  body: JSON.stringify({
    model: "nemotron-3.5-lightning-free",
    messages: [{ role: "user", content: "hi" }],
    stream: true,                         // axis 4
    max_tokens: 16,
    tools: ["bash", "glob", "grep", "read", "edit", "write"].map((name) => ({  // axis 3
      type: "function",
      function: {
        name,
        description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
        parameters: { type: "object", properties: {} },
      },
    })),
  }),
});
```

Drop the `user-agent`, the session header, `stream: true`, or `tools` and it
returns `403` — the same `403` in all four cases, with nothing in the body to
say which axis was wrong.

Note that `max_tokens: 16` is fine on the chat-completions wire but rejected
on `/responses`, where the floor is 16 or higher — measured live on the
now-retired `muse-spark-1.2-contributor-free`, which answered `400` below it.

## Operational notes

- **A live probe costs free-tier quota.** Every request above is a real
  inference request. A catalog sweep across 13 models is 13 requests.
- **Probe through the local proxy, not against a relay directly.** Direct
  relay probing drives the relay health machine, and a burst of deliberate
  failures will park relays in cooldown for the duration of their backoff.
- **Absence of tools is the usual cause of a surprise refusal.** Tool-less
  turns — subagent and advisor watchdog calls in particular — are exactly the
  shape that gets refused if the placeholder injection is ever skipped.

## Related

- [Architecture](/pages/architecture) — how the proxy applies this fingerprint
- [Model Catalog](/pages/models) — which models are listed
- [Commands & Troubleshooting](/pages/commands) — reading the log for refusals

## Third-party corroboration (2026-10-27)

Independent public projects that proxy the same free tier agree on the
mechanics above, and pin down three disputed details against the official
client source:

- **Session ids are 30 characters** (`ses_` + 12 lowercase hex + 14 base62),
  generated from the clock with a small pinned counter. Shorter shapes are
  miscounts; longer counters are refused.
- **The project header is a sha1 digest of the working checkout by default**
  (`global` is only the fallback when nothing is discoverable). Either value
  currently passes, but the digest is what the real client sends.
- **The client sends its full tool roster, never a fixed subset.** The gate
  itself only needs a non-empty tool list containing `read` — which is why
  minimal tool pairs work and tool-less requests do not.
- **The current client lane is the OpenAI-compatible one**
  (`/inference/openai/v1/chat/completions`); the older `/zen/v1` paths now
  refuse free requests. Both `/inference/v1` and `/inference/openai/v1`
  answer when the rest of the fingerprint holds.
- **No third party synthesizes the `<env>` block** — every other proxy passes
  the caller's system prompt through untouched, so hosts that never emit the
  block fail on those proxies exactly as in issue #117. The Bun-based proxies
  additionally document a transport-level check: byte-identical requests pass
  from Bun's network stack and are refused from Node's.
