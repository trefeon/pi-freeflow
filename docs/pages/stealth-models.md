# Stealth Models Watchlist

Masked preview IDs appear from time to time: labs publish a model under an
anonymous name, offer a short free window, then unmask it or withdraw it.
This page tracks the ones users ask about and why they are or are not in
the free-model picker.

## Omen Alpha

- Seen as a hidden entry inside the OpenCode client (reported early
  September 2026). Community fingerprinting leans GLM family, Kimi second,
  but evidence is one report plus infra probes. No vendor confirmation.
- No public keyless endpoint. Nothing named `omen` appears in the OpenCode
  Zen or KiloCode Gateway free lists as of 2026-09-12.
- Verdict: not in the picker. Re-check trigger: a stable public ID shows
  up on either free list, confirmed by a second independent report.

## OX Alpha

- Stealth preview on OpenRouter from 2026-08-20, about a week, priced at
  $0 during the window. Needed an OpenRouter key (free-tier rate limits
  applied).
- Suspected GLM-5.3 variant on tokenizer and error-code matches across
  several testers. Later unmask claims are unconfirmed.
- Confirmed on the OpenCode Zen side as `x-preview-f-free` (it is
  `stealth/ox-alpha` on OpenRouter, and the Zen picker shows the friendly
  name while the API takes the masked id). Re-checked 2026-10-08: absent
  from the live Zen list, and both `ox-alpha` and `ox-alpha-free` answer
  `401` "Model ... is not supported". Recorded in the dead-model list.
- Verdict: not in the picker (window expired, model decommissioned).

## Pony Alpha

- Expired February 2026 preview, later presented as a GLM-5 precursor.
- Verdict: historical only.

## Cypher Alpha

- OpenRouter test placeholder from 2025-07-01. The provider name is
  confirmed fictional per the announcement. Free on OpenRouter with a key
  and training-logging consent.
- Verdict: out of scope. OpenRouter-key models are not part of this
  keyless picker.

## Currently in the picker, and former entries

- Space Bunny (`space-bunny-free`, OpenCode Zen free list, 2026-09-23):
  stealth preview with the lab undisclosed, but live on the free list and
  answering keyless probes (1M context, vision + tool calls). In the
  picker as `space-bunny`.
- Space Bunny Alpha (`stealth/space-bunny-alpha`, KiloCode Gateway free
  list, 2026-09-28): same stealth family under a Kilo-native ID, live on
  the free list then and answering keyless probes. **Left the Kilo free
  list on 2026-10-07** — keyless chat now answers `404` "The requested
  model does not exist". Out of the picker and recorded in the dead-model
  list.

## Decision

Add nothing now. A stealth ID enters the picker only when it is live on
the OpenCode Zen or KiloCode Gateway free list and answers a live inference
probe. Re-check any new `stealth/*` or `omen` ID against both free lists
before treating a client-side listing as an endpoint.

## Expiry watch

Free slots with a printed expiry leave the picker when the window closes:

- `dots-3-note-preview` (KiloCode Gateway free list) — expiry extended to
  2026-12-31. Still in the picker; re-check as the date approaches.
- `nex-n2.5-pro` and `nex-n2.5-mini` left the Kilo free list on 2026-09-28
  (absent from the listing, keyless 404) and left the picker with it; the
  paid versions under other names don't count.
- `space-bunny-free` (OpenCode Zen free list) — OpenCode announced on
  2026-10-08 that the free period is ending, with the model sponsored in
  the free tier for a few more days before reveal. Still answering
  keyless probes, still in the picker. The self-hosted relay now probes
  it every pass, so a withdrawal shows up as one actionable log line
  instead of surfacing to whoever picks the model next.

## Sources

- https://kie.ai/blog/what-is-glm-omen-alpha
- https://kie.ai/blog/what-is-ox-alpha
- https://openrouter.ai/blog/announcements/new-stealth-model-cypher-alpha/
- https://blog.kilo.ai/p/the-secret-is-out-pony-alpha-is-glm
