# OpenCode Free-Tier Gate

How the OpenCode Zen free tier decides whether to answer a request, measured
directly against the live gateway. This page exists because the answer is not
what the error message suggests, and because two widely-shared assumptions
about it are provably wrong.

Every result below was reproduced against `https://opencode.ai/zen/v1` on
2026-10-08. Each row is a controlled comparison: one variable changed, same
request otherwise.

## The refusal

A refused request answers `403` with a plain JSON envelope:

```json
{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}
```

From a plain external IP this is the **dominant** outcome: of 12 free-suffixed
model IDs on the Zen list, 11 were refused and only one answered.

Paid models fail differently and are not part of this problem:

| Class | Status | Body |
| --- | --- | --- |
| Free model, gate satisfied | `200` | SSE or JSON completion |
| Free model, gate refused | `403` | `FreeTierError` |
| Paid model, no key | `401` | `AuthError` — "Missing API key." |
| Model gone upstream | `400` | "Model is unavailable." |

## What actually opens the gate

Two request properties must **both** hold. Either alone is refused.

| Tool declarations | Streaming | Result |
| --- | --- | --- |
| placeholder sextet | `stream: true` | **`200`** |
| placeholder sextet | absent | `403` |
| placeholder sextet | `stream: false` | `403` |
| none | `stream: true` | `403` |
| none | absent | `403` |

Two details worth stating precisely:

- **`stream: false` is refused, not just "no `stream` key".** Sending an
  explicit `stream: false` is refused the same way an absent key is. What the
  gateway requires is that the request is actually a streaming request.
- **The placeholder tools must be declared, but never called.** They are
  compatibility stubs. pi-freeflow ships them as
  `OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read", "edit", "write"]`
  in `src/tool-translation.ts`, with a description telling the model not to
  call them. Requests without them are refused.

Reproduced across four models — `nemotron-3.5-lightning-free`,
`mimo-v2.6-flash-free`, `longcat-2.5-preview-free` all flip 403 → 200 when
streaming is on and the sextet is declared.

### The one exception

`space-bunny-free` answers `200` in **both** shapes, with or without streaming
and tools. It is the single model on the free list that a bare probe can
always reach, which makes it a useful control when testing the gate — and a
poor choice for probing *other* models, because it will never reproduce a
refusal.

## What does not matter

Each of these was varied while streaming and the placeholder sextet were held
present. None changed the outcome away from `200`:

- `User-Agent` version, across `opencode/1.0.0` … `opencode/1.22.0`
- `x-opencode-client: cli` vs `desktop`
- `x-opencode-project`, whether the SHA-1 of the upstream git remote, the
  literal `global`, a random hex value, or empty
- payload size, from ~100 B to ~640 KB
- a fresh session ID per request vs one session reused across four requests

Request identity is still worth sending, and pi-freeflow still sends it —
`src/config.ts` mints a canonical `ses_…` session and a per-turn `msg_…`
request ID, matching the vendor's own identifier encoding. But **none of it is
load-bearing for the gate.** It is good hygiene, not the mechanism.

## What is wrong about the popular workaround

A widely-copied third-party plugin states that the lane is called with
`Authorization: Bearer public`. Measured live, that header is
**actively harmful**:

| Authorization header | Status | Body |
| --- | --- | --- |
| *(none)* | `200` | completion |
| `Bearer public` | `401` | "Invalid API key." |

pi-freeflow deliberately sends no `Authorization` on this lane —
`src/proxy.ts` documents why in `sanitizeHeaders`: the host provider registers
with a dummy key, every free upstream here is keyless, and forwarding that
dummy gets a `401`. Sending `Bearer public` would put it in the same trap from
the other direction.

The same plugin describes the tool gate as a *fingerprint* the client must
present. The gate is not a fingerprint. The OpenCode client at tag `v1.18.35`
contains no required tool names and no free-tier tool check: its tools are
caller-supplied and filtered only by permission rules. The stubs exist because
this lane requires a tool declaration, not because it is checking one.

## Handling a refusal

pi-freeflow treats a `403 FreeTierError` as a terminal upstream verdict, not a
relay fault — the rule is stated in `src/proxy.ts` and the state machine lives
in `src/upstream-health.ts`.

That policy is **correct**, and it is worth keeping explicit, because the
opposite looks reasonable: on a refusal, roll to a different relay. Measured:
all 10 relays in a healthy pool returned an **identical** `403` for a model the
running daemon served `200` at the same moment. Rolling buys nothing and
burns quota on retries.

What the daemon does instead is correct in the same situation: it records the
refusal, fails fresh sessions over to a healthy KiloCode model on the same
wire API, and remembers the rejection so a retried or resumed conversation
fails over immediately rather than replaying a refusal that cannot succeed.

## Testing this yourself

A minimal direct probe that satisfies the gate:

```js
const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "opencode/1.18.35",
    "x-opencode-client": "cli",
  },
  body: JSON.stringify({
    model: "nemotron-3.5-lightning-free",
    messages: [{ role: "user", content: "hi" }],
    stream: true,              // required
    max_tokens: 16,
    tools: ["bash", "glob", "grep", "read", "edit", "write"].map((name) => ({
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

Drop either `stream: true` or `tools` and it returns `403`.

Note that `max_tokens: 16` is fine on the chat-completions wire but rejected
on `/responses`, where the floor is 16 or higher — `muse-spark-1.3-contributor-free`
and `muse-spark-1.2-contributor-free` answer `400` below it.

## Operational notes

- **A live probe costs free-tier quota.** Every request above is a real
  inference request. A catalog sweep across 12 models is 12 requests.
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
