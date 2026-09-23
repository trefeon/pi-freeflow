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
  applied). Never keyless through Zen or Kilo.
- Suspected GLM-5.3 variant on tokenizer and error-code matches across
  several testers. Later unmask claims are unconfirmed.
- Verdict: not in the picker (window expired, wrong auth). Successor path:
  a named `glm-5.3-flash` style ID on a free list.

## Pony Alpha

- Expired February 2026 preview, later presented as a GLM-5 precursor.
- Verdict: historical only.

## Cypher Alpha

- OpenRouter test placeholder from 2025-07-01. The provider name is
  confirmed fictional per the announcement. Free on OpenRouter with a key
  and training-logging consent.
- Verdict: out of scope. OpenRouter-key models are not part of this
  keyless picker.

## Graduated to the picker

- Space Bunny (`space-bunny-free`, OpenCode Zen free list, 2026-09-23):
  stealth preview with the lab undisclosed, but live on the free list and
  answering keyless probes (1M context, vision + tool calls). In the
  picker as `space-bunny`.

## Decision

Add nothing now. A stealth ID enters the picker only when it is live on
the OpenCode Zen or KiloCode Gateway free list and answers a live inference
probe. Re-check any new `stealth/*` or `omen` ID against both free lists
before treating a client-side listing as an endpoint.

## Expiry watch

Free slots with a printed expiry leave the picker when the window closes:

- `dots-3-note-preview` (KiloCode Gateway free list) — expiry extended to
  2026-12-31. Still in the picker; re-check as the date approaches.
- `nex-n2.5-pro` and `nex-n2.5-mini` (KiloCode Gateway free list) — expire
  2026-09-25. If either drops off the free list it leaves the picker with
  it; the paid versions under the same names don't count.

## Sources

- https://kie.ai/blog/what-is-glm-omen-alpha
- https://kie.ai/blog/what-is-ox-alpha
- https://openrouter.ai/blog/announcements/new-stealth-model-cypher-alpha/
- https://blog.kilo.ai/p/the-secret-is-out-pony-alpha-is-glm
