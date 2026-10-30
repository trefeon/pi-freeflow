---
"pi-freeflow": minor
---

Add an opt-in Bun transport for direct OpenCode Zen requests, and fix stream handling on the same lane.

Setting `PI_FREEFLOW_ZEN_TRANSPORT=bun-sidecar` sends direct Zen traffic through a bundled Bun helper, so the TLS connection originates from Bun's networking stack while the request bytes stay identical. The helper is used only when a Bun 1.1+ binary is found and passes a quick version check; otherwise the proxy stays on its normal transport, and any helper failure falls back to it per request. Relay routing is skipped while the helper is active, because a relay would originate a different connection.

The direct lane also stops cutting a response body when the header wait expires after headers have arrived, reports a child that dies mid-body instead of ending the stream silently, and returns responses that must not carry a body (204, 205, 304) correctly. Bun installs whose path contains spaces are now detected, and the helper refuses plain-HTTP targets outside loopback and URLs carrying embedded credentials.

The working-directory project variant is now read only when `PI_FREEFLOW_OPENCODE_PROJECT=cwd`; setting the working directory alone keeps the default `global` project value. Opt-in extra request headers can no longer forward credentials, cookies, or hop-by-hop framing headers even when listed.

Default traffic is otherwise unchanged: with the new environment variables unset, requests match the previous release except for two deliberate session-continuity fixes. Bodies carrying only camelCase `promptCacheKey` now also gain `prompt_cache_key`, so camel-only callers keep a stable session instead of falling through to a fresh random id per request; and 29-character `ses_` session keys now pass through verbatim instead of being remapped, matching the live CLI shape. The 11-tool roster, User-Agent, project value, lane, and exactly-one environment block are otherwise byte-identical.
