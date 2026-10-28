# Changelog

## 1.43.0

### Minor Changes

- Auto-detect the installed OpenCode 1.x version and auto-repair the OpenCode lane on version drift. The proxy now parses the real client version (`parseOpenCodeBinaryVersion` plus a memoized `probeInstalledOpenCodeVersion` via `opencode --version`) with precedence env override > installed 1.x > live registry > disk > `1.19.4` fallback, so fingerprint User-Agent and headers track the actual installed client instead of a pinned constant. A 2.x major never auto-switches the compat UA; it surfaces via `getLiveOpenCodeVersion` only. Outgoing requests strip stale caller `x-opencode-*` stamps and always stamp the live roster, relay shape-429s stay terminal with no health mark, and the proxy retries once through `refreshOpenCodeUserAgent` on 426/version-drift language.

### Patch Changes

- Harden the OpenCode fingerprint, account pools, and relay/update paths. Requests collapse to a single live OpenCode fingerprint (11-tool roster, full client User-Agent, fresh request id per prepare); silent Zen-to-Kilo failover moves behind the `PI_FREEFLOW_ZEN_KILO_FAILOVER` opt-in. The Cline pool clones on load/save with trimmed tokens and tightened stream sniffing, hedge rate-limit signals are preserved, sticky relay removal is trimmed, quota markers are narrowed, and state writes share one atomic path. Also fixes version comparison, updater probing, token mtime caching, and lease validation. The OpenCode lane is live SERVING (200 billing free).
- fb521b1: Retire two OpenCode Zen models that upstream removed (issue #121): `longcat-2.5-preview-free` answers `410 Model has been deprecated`, and `nemotron-3-ultra-free` answers `400 Model is unavailable` — both ids are also absent from the live Zen free listing, so neither can serve traffic anymore. The catalog drops from 34 to 32 models (Zen lane 10 to 8); both ids are dead-listed so no stale disk cache or upstream merge can re-register them, and their `longcat` / `longcat-2.5-preview` short aliases are removed. The eight models that answered `429 FreeUsageLimitError` in the same run are untouched: rate-limit verdicts are an availability fault, never a catalog action. The sibling Kilo id `nvidia/nemotron-3-ultra-550b-a55b:free` is a separate serving route and is unaffected.
- fb521b1: Record opt-in OpenCode Zen free-tier request variants for A/B testing once upstream quota recovers, with no change to the default request. A newer four-part client identifier, alternate project header values (fixed, global, or working-directory digest), and the alternate usage-marked request lane are now available as selectable variants for controlled one-variable comparisons. Default traffic is byte-identical: same User-Agent, project value, lane, tool set, and exactly-one environment block as before.
- fb521b1: Fix OpenCode Zen free-tier requests being refused with `429 FreeUsageLimitError` ("Free usage limit reached") when the system prompt carries no environment block. The same body answers `200` with the block and `429` without it on the same machine, in the same minute, so the countdown to 00:00 UTC is a generic error body rather than a spent quota. Outgoing Zen requests now carry exactly one `<env>` block containing `Working directory:`: a complete block the host already sent is passed through untouched, a stale or incomplete one is replaced instead of duplicated, and the Kilo, Cline and OVHcloud lanes are unchanged. A conversation that already ate a refusal also keeps failing over to Kilo on its retry instead of replaying the refusal.

## 1.42.1

### Patch Changes

- 5ab7509: Enable forced round-robin relay selection for stateless OVHcloud AI requests across all healthy pool relays, load-balancing requests to prevent hitting upstream per-IP rate limits (2 req/min) while preserving sticky session affinity for OpenCode Zen.

## 1.42.0

### Minor Changes

- b247ea6: Enable relay pool routing for OVHcloud AI Endpoints to bypass per-IP rate limits during burst and subagent requests. Retire paid `z-ai/glm-5.3-flash` and update the Cline lane to true free-tier models (`cline/nemotron-3.5-super-vl`). Implement dynamic Cline version fetching from Open VSX with disk caching, and background keep-alive auto-probing so saved Cline account tokens never expire.

### Patch Changes

- 2b1f434: Roll Cline pool to the next slot when OpenRouter free models return in-stream 429 errors within HTTP 200 SSE streams.
- 92532c3: Fix DeepSeek follow-up requests in Pi being rejected when earlier assistant messages have no reasoning content.
- a6d9834: Retire unserved `cat-jam-free` (persistent upstream 404), correct `mimo-v2.6-flash-free` input modality to text-only (upstream rejects image input), and strip `max_output_tokens` on the OVH lane so translated Responses requests no longer trigger upstream 400 extra arguments errors. Model catalog count updated from 35 to 34 across documentation and tests.
- debb162: Report client version 1.19.4 to OpenCode, matching the current upstream release. The session-ID format is unchanged: upstream refactored its generator in the same release, and identifiers are still `ses_` followed by 12 hexadecimal timestamp characters and 14 random characters.
- b5083bd: Stop OVH Qwen models from failing with `400 feature 'extra arguments: {"chat_template_kwargs": …}' is not currently supported`.
  
  The host classifies the loopback proxy as a local OpenAI-compatible backend before model compat overrides land, so `Qwen3.x` ids were treated as template-dialect Qwen and every OVH request carried `chat_template_kwargs` (`enable_thinking`, `preserve_thinking`). OVH's OpenAI-compatible surface rejects those fields. The OVH lane now pins `thinkingFormat: "openai"` and clears `qwenPreserveThinking`, and `handleOvhRequest` strips any Qwen template controls that still reach the proxy.
- 92a818a: Normalize OVH reasoning stream chunks from `delta.reasoning` to standard `delta.reasoning_content` so OMP and OpenAI-compatible clients capture thinking tokens without reporting empty turns. Defensively strip `reasoning_effort` on non-reasoning OVH models (`Meta-Llama-3_3-70B-Instruct` and `Mistral-Small-3.2-24B-Instruct-2506`) to prevent upstream HTTP 400 unsupported feature errors.
- debb162: Remove MiniMax M3.1 Flash from the free catalog: both free endpoints are gone. OpenCode Zen answers HTTP 410 with a model-level deprecation pointing at `deepseek-v4.1-flash-free`, and the KiloCode free id answers HTTP 404 "does not exist" while the gateway listing keeps only a paid id. Both leave the picker and both stay dead-listed, so a stale cache cannot bring them back. The `minimax-m3.1-flash` short name is removed rather than pointing at a paid model. The catalog is 35 models: 11 from OpenCode Zen, 15 from KiloCode Gateway, 1 from Cline, 8 from OVHcloud AI Endpoints.

## 1.41.0

### Minor Changes

- Add seven new free models — all keyless — for 37 in total (12 OpenCode Zen + 16 KiloCode Gateway + 1 Cline + 8 OVHcloud AI Endpoints).
  
  New on OpenCode Zen:
  
  - `minimax-m3.1-flash-free` (MiniMax M3.1 Flash): 1M context, 524,288 output, vision. Effort `low` through `max`.
  - `flint-40b-free` (Flint 40B): 262,144 context, 65,536 output, text-only. Effort `low` through `max`. Availability is bursty — an upstream 503 burst means retry, not that the model is gone.
  
  New on KiloCode Gateway (OpenRouter-style reasoning, keyless):
  
  - `minimax/minimax-m3.1-flash:free` (MiniMax M3.1 Flash): 1M context, 524,288 output, vision. Reasoning is mandatory upstream and there are no reasoning deltas on tool turns.
  - `nvidia/nemotron-3.5-super-vl:free` (Nemotron 3.5 Super VL): 1M context, 131,072 output, vision. NVIDIA's trial terms allow training on prompts, and `max` effort can draw a transient 502/503 worth retrying.
  - `reflection/beam-free` (Beam 1.0), alias `beam-kilo`: 1,048,576 context, 131,072 output, text-only. Reasoning is always on.
  - `recursive/flint-v1.0:free` (Flint 40B), alias `flint-kilo`: 262,144 context, 65,536 output, text-only. Thinking is mandatory and can consume a tight output budget.
  - `xingchen-agi/xing4.0-29b-a4b:free` (Xing4.0 29B A4B), alias `xing4.0`: 262,144 context, 235,929 output, text-only. Expect the shared upstream 429 quota often; that is a rate limit, not a dead model.
  
  Short names: `minimax-m3.1-flash` and `flint` stay on the Zen lane. The Kilo twins answer to `flint-kilo` and `beam-kilo`, while `beam` and `nemotron-3.5-super-vl` keep pointing at their existing Zen entries, so no saved selection changes lane.

### Patch Changes

- Protocol cleanup around reasoning effort, failover limits and tool definitions.
  
  Three small drifts between what a lane accepted and what it advertised are settled. Unsupported reasoning-effort knobs are now clamped on the Chat Completions path exactly as the Responses path already clamped them, so a too-high or unsupported level keeps the turn on the same model instead of walking into an upstream refusal. Failover bodies headed to Kilo now clamp `max_completion_tokens` alongside `max_tokens`, saving a wasted round trip. The user-facing tool definitions now carry `strict` in the position the Chat Completions shape canonically uses, with both positions still accepted when reading a caller's tools back.
  
  The Anthropic-shaped messages lane no longer deletes Anthropic-native forced tool choices (`any` or a named tool) — it was documented to keep the caller's own choice semantics and now actually does; the chat and Responses lanes still normalize choices to `auto`-or-absent as upstream requires.
- Two OVH-hosted models no longer lose their answer to an upstream quirk, and an empty upstream stream now reports itself instead of looking like a blank reply.
  
  Qwen3.8 27B on OVH answers a request carrying a thinking-effort knob with an empty stream; the proxy now drops that knob for this one model, so the turn produces the model's own reasoning and answer as usual. Mistral Small 3.2 24B requires tool-call ids of exactly nine letters and digits and discards the whole turn otherwise, so ids replayed from your session history are rewritten to that shape — consistently, so an assistant call and the tool result that answers it still match.
  
  When OVH does return nothing at all, a non-streaming request now answers with a clear `502` and "upstream returned an empty stream" instead of a fabricated empty completion.
- Retire Cline's `cline-free/muse-spark-1.3-contributor` from the catalog.
  
  Cline stopped resolving the id: every request answers HTTP 404 `model not found` with the hint `Cline has no such model`, while the sibling Cline model still resolves on the same account. The picker no longer offers Muse Spark 1.3. The id stays on the retired list, so a stale local cache or a refreshed upstream listing cannot bring it back.
  
  The Cline model that remains (`z-ai/glm-5.3-flash`) still works once the signed-in account has free credit. Clients that already saved the retired model simply stop seeing it.
- Retire `exo-free` from the catalog.
  
  The free endpoint answers HTTP 410 "Model exo-free has been deprecated" on every request path and the model is no longer on the service's model list, so the picker no longer offers it. The id stays on the retired list, which means a stale local cache or a refreshed upstream listing cannot put it back.
- Parallel tool calls streamed through the proxy no longer corrupt each other.
  
  Several free models label every parallel tool call with the same index while still giving each call its own id. On streamed turns the proxy merged calls by index alone, so the argument fragments of two parallel calls interleaved into one packet: one call could vanish entirely, or the arguments came through as glued-alongside JSON the host had to reject (which looked like the model failing at tool calling and the turn being retried). Streamed tool calls are now tracked the same way the assembled (non-streamed) ones always were — per call id, falling back to the wire index only when a call carries none — and a call whose index collides with another is renumbered so the host still sees two well-formed, re-executable calls. Streams with a single tool call are byte-for-byte unchanged.
- Streamed tool calls now reach the client with the tool name exactly once.
  
  One upstream (OpenCode Zen) streams a single tool call as two frames that BOTH carry the complete name: a name-only frame, then a frame repeating that name together with the arguments. The proxy appended every name it saw, so the assembled call came out named `get_weatherget_weather` — a name no tool declaration matches. Streamed hosts bound the call by index and happened to tolerate it; anything reading the non-streamed aggregate, and any host that trusts the assembled packet, got a call it could not execute. A name that arrives alongside arguments is now treated as the authoritative whole name and replaces what was accumulated, while name-only deltas keep appending so ordinary piecewise-streamed names still reassemble. Both the streamed path and the assembled path apply the same rule.
- Failed and retried tool-call turns are now recorded locally so they can be diagnosed after the fact.
  
  Every streamed turn that declared tools — and every non-streamed Chat Completions turn — leaves one line in `<data dir>/toolcall-audit.jsonl` describing how it ended: the caller's declared tool names, the calls the model actually made (name, argument size, whether the arguments parsed, whether the name was one the caller declared), the finish reason, and the classified failure. A turn where the model answered with plain text instead of calling a tool, or called a name the host never declared, now says so instead of vanishing into a generic red error. A Responses or Messages body served without an event stream is recorded as unclassifiable rather than counted against the model.
  
  Each upstream attempt abandoned in favour of another is recorded with its reason — rate limit, gateway timeout, payload limit, relay auth rejection, header timeout, socket fault — and, when the host re-sends the same conversation within ten minutes, the new turn carries the earlier one's request id and failure, so a failed first attempt and its host retry are attributable to one conversation.
  
  The log records names, sizes, booleans and reasons only: message text, tool schemas and tool-argument values are never written. It is best-effort, never affects a request, stays empty for turns that declared no tools, and rotates to `.1` at 5 MiB. Two `jq` one-liners in the architecture docs list failures by model and retried conversations.

## 1.40.1

### Patch Changes

- Long streams are no longer cut at the five-minute ceiling mid-turn; a stalled relay is cut and re-fired instead.
  
  Relay attempts carried a single deadline for the whole request. When a heavy reasoning turn ran past five minutes — big-pickle and long deepseek sessions routinely do — the deadline fired on live bytes, the proxy saw the dead stream as an upstream truncation, and silently re-fired the turn on another relay: on the screen the answer suddenly stopped and then continued as a fresh full generation, with the earlier partial content above it. The deadline now bounds only the header wait and is released the moment headers arrive, so a streaming body lives as long as bytes keep flowing — exactly like the other proxy paths that already cleared their timer on headers.
  
  A body that stops flowing entirely is cut by a per-turn idle watchdog (120s of byte silence on a live socket is a wedged tunnel, not a thinking pause) and follows the existing one-refire truncation path, so a hung relay leg still hands the turn to a sibling instead of stalling until the host gives up.

## 1.40.0

### Minor Changes

- Streaming turns now survive a relay rate limit: a 429 error frame that arrives before any tool call is held, the relay is cooled, and the same turn resumes once on a sibling relay. Pre-stream 429s still roll before any client bytes, and tool-call turns keep the authentic verdict to avoid duplicate execution.

### Patch Changes

- Reconcile the remaining free-model specs with the highest published twin values, keeping lane hard caps authoritative:

  - Cat Jam now advertises its 1,048,576-token window: the endpoint refuses a 1.05M prompt with `context_length_exceeded` (max 1,048,576), and a 900,337-token needle probe recalled correctly.
  - Nemotron 3 Ultra (both lanes) now declares the 1,000,000-token lane cap; larger prompts are refused.
  - Nemotron 3.5 and Super now carry the highest published 235,929 output ceiling below the window.
  - Thinking selectors now expose only the depths published by the free or paid twin's datasheet; unlisted rungs stay locked off. The 3.6/3.8 Qwens add `minimal`, the other OVH reasoning rows expose `medium`, Inkling Small adds `max`, and Exo follows its paid twin's `minimal..xhigh` union.
  - OVH output ceilings follow the highest published twin value below the window: 235,929 for the 397B and 3.8 Qwens, 65,536 for the 9B, 3.6 and both gpt-oss models, and 32,768 for Mistral and Llama.
  - Remove Space Bunny: the free endpoint answers `410 ModelDeprecated` and points at `minimax-m3.1-flash-free`.
  - Declare only text and image inputs. The host catalog has no video or audio input type, so upstream video/audio/PDF support (MiMo, GLM 5.3 Flash, Nemotron Super VL, Nano Omni) is documented in the README instead of being advertised in the picker.
- Rate-limit rotation is now silent: a relay that answers 429 is cooled and deprioritized without a per-relay warning toast or per-relay WARN line while the pool still has a candidate. A pool-wide 429 burst alert still warns when many relays rate-limit in one minute. The rate-limit message appears only when no relay or direct fallback served the turn, including the existing 403-salvage path.
- Model specs refreshed against the latest upstream catalogs. Free and paid variants of the same model now share the highest published context window, output ceiling, and input modalities, so a picker entry no longer understates what the model accepts.
- Drop two Kilo models that stopped answering, so the picker only offers what is actually served: `nvidia/nemotron-3-super-120b-a12b:free` answers `404 Function ... Not found for account ...` from its Nvidia provider, and `thinkingmachines/inkling-small:free` answers `404 The requested model is currently unavailable`. Both verdicts reproduce from two independent egress IPs while the sibling Nvidia ids answer `200` with the same request shape. The catalog is 32 models; both ids stay on the retired list so a stale cache cannot bring them back.

## 1.39.0

### Minor Changes

- 7427771: Security, wire-path and automation fixes from the October 2026 review:
  
  - The local proxy now requires its own access token: every `/v1/*` and `/_*` request must carry `Authorization: Bearer <token>` (the token is written to the data directory on first start and the plugin supplies it automatically), the Host header must be loopback, and the daemon refuses to kill a process it cannot identify as its own. `GET /health` stays open for liveness checks. External tools that call the proxy directly must read the token file and send the header.
  - A request for one model is never silently served by another: the internal Kilo 400 retry no longer substitutes a different model, so upstream verdicts reach the caller unchanged.
  - Answers are no longer corrupted before they reach the client: a plain JSON reply that merely mentions `data:` is forwarded byte-identically instead of being replaced by an empty completion, a complete final SSE event that lost its trailing blank line is no longer dropped, and malformed tool arguments can no longer stall the proxy with a quadratic scan.
  - Relay health reflects reality: an upstream 404 or 401 forwarded by a healthy relay no longer cools the pool, and a repeated 500 no longer resets the failing relay's health or steals the sticky slot.
  - Cline logins: a rejected grant is parked instead of re-tried on every turn, a failed save is reported instead of being shown as saved, and logging out no longer leaves the removed token in the recovery file.
  - Startup hooks and updates: the Windows logon task stores a command Windows can launch, a failed `systemctl --user enable` is reported, and auto-update no longer blocks the host while installing.
  - Automation: the free-model health check has a timeout that fits a fully hanging catalog, a new guardrail keeps that budget honest, drift alerts close themselves once recovered, and the published-tarball check now also fails when the package ships a file the tree does not have.

### Patch Changes

- 152862b: Retire Muse Spark 1.2 contributor from the OpenCode Zen lineup — the model was deprecated upstream and now answers HTTP 410. The catalog, docs, and health checks move to the remaining 35 live models (12 on Zen), and the retired id is dead-listed so an old disk cache or an upstream merge cannot bring it back into the picker.

## 1.38.5

### Patch Changes

- Salvage relay rate-limit responses when direct fallback encounters network-level or abusive-IP 403 errors, preventing transient rate limits from locking up upstream models. Add the `/freeflow sticky` command to pin requests to one healthy relay until a rate limit or edge error occurs, preserving fresh pool relays. Recognize network-restricted and abusive-traffic 403 variants as free-tier gates so fresh sessions automatically fail over to healthy fallback models without interruption.

## 1.38.4

### Patch Changes

- A relay that the upstream free-tier gate rejects can no longer wedge the pool: when a relay forwards back a 403 the relay itself is marked failed and the request rolls to the next candidate (or the direct route), instead of that 403 being recorded as a healthy verdict and pinning the relay as the pool's primary. The machine-wide upstream gate now only trips when the direct route is refused too, so one incompatible relay cannot fail everyone over.

  Deploying a relay now proves inference through it, not just that its models list answers: the completion message verifies a real free-tier request and, when that fails, says so plainly — including the known Deno Deploy case (its platform rewrites the outbound User-Agent, so OpenCode Zen rejects traffic from it while Kilo still works). Deno Deploy deployments also resolve their public URL from the current API response again, so the deploy flow ends with a usable relay address instead of a "could not determine the public URL" error.

## 1.38.3

### Patch Changes

- Absorb tool-call argument fragments arriving on terminal finish_reason chunks into buffered prefixes to prevent argument rotation and corrupted JSON loops. Add Reflection AI's Beam Free (1M context) to the OpenCode Zen lineup, and retire deprecated LL Alpha and Muse Spark 1.3 contributor free models.

## 1.38.2

### Patch Changes

- Add Exo to the OpenCode free tier — a live preview model with chat, tools, reasoning, and image input that the official free lineup lists.
- Add GLM-5.3 Flash and LL Alpha to the OpenCode free tier, and retire Step 5 Preview — it is gone from the Zen lineup and demoted to paid on the Kilo lane, so those entries can no longer be selected.

## 1.38.1

### Patch Changes

- Add the Nemotron 3.5 Super VL free model and enable the max thinking level on Cat Jam — both live-verified through the proxy; align the README and docs with the shipped catalog.
- The first-run welcome now names the local proxy port actually in use instead of the default port.
- Streaming requests now pass through replies that arrive in a non-streaming format instead of dropping the answer, concurrent startups share a single connection attempt instead of racing, and a foreign process squatting the local proxy port is no longer mistaken for the daemon we own.
- Following logs now reads only the lines appended since the last tick instead of re-reading the whole log file every second, so `/freeflow logs --follow` stays light even on large logs.
- Fix a batch of verified edge cases: non-ASCII streaming text is no longer corrupted when a character spans network chunks, assistant text stays visible on the responses path when it is served from a chat-only upstream, tool-argument repair also works on strict tool schemas, a relay that rejects our auth rolls to the next egress instead of being marked healthy, the update flow restarts the proxy it is actually attached to, and daemon/health state handling no longer loops or reads stale data.

## 1.38.0

### Minor Changes

- Follow pi's config-dir global: data files (relay state, logs, caches — including the staged daemon sources) now root at `PI_CODING_AGENT_DIR` when set, instead of always `~/.pi/agent`. CI and containers can relocate pi's config dir once and the extension writes alongside it. A leading `~` in either override expands to the home directory, and `PI_FREEFLOW_DATA_DIR` still overrides everything.

### Patch Changes

- Startup no longer stalls for several seconds when the extension is installed as a package and runs under Node.js: the detached proxy daemon is now launched from a staged copy of its sources (Node refuses to strip types for files under `node_modules`), a daemon that exits immediately is detected instead of being awaited for the full ready timeout, and a free base port is no longer mistaken for an unresponsive port holder.

## 1.37.1

### Patch Changes

- **DeepSeek V4.1 Flash (`deepseek-v4.1-flash-free`)**: Added to the OpenCode Zen lane (catalog 34 → 35 models). Configured with full **1,000,000 context window**, **384,000 max output tokens**, vision support (`input: ["text", "image"]`), and reasoning ladder (`minimal..max`).
- **Sources of Truth & Highest-Spec Twin Policy**: Documented model reconciliation against [models.dev](https://models.dev/), [OpenRouter](https://openrouter.ai/), and OMP's built-in catalog, ensuring models are configured to the highest capability across twin models rather than artificially truncated limits.
- **Automated OpenCode Model Health Bot**: Added dedicated GitHub Actions workflow and probe engine to continuously detect affected or degraded OpenCode free-tier models.

## 1.37.0

### Minor Changes

- **Auto-Update Capability**: Added the `/freeflow autoupdate on|off` command (and `/freeflow update auto on|off`). When enabled, background update checks automatically download and install new versions, seamlessly restarting the proxy daemon.
- **Automatic Daemon Recovery on Version Mismatch**: When the client detects an outdated running proxy daemon (or after an update), it automatically stops the stale daemon and restarts with the current package version, eliminating manual intervention and stale port locks.
- **Documentation Sync**: Synchronized all documentation, specs, and routing tables to reflect the 34 verified free models across OpenCode Zen (10), KiloCode Gateway (14), Cline (2), and OVHcloud AI Endpoints (8).
- **Self-Hosted VPS Relay Option**: Added setup guidance and documentation for self-hosting an egress relay pool on a VPS using [trefeon/warp-relay-pool](https://github.com/trefeon/warp-relay-pool).

## 1.36.3

### Patch Changes

- Restore OpenCode free models following upstream endpoint and gate migration

  OpenCode free models were failing with HTTP 403 FreeTierError after upstream deprecated the older endpoint and moved free inference traffic to the v1 inference gateway. Upstream also requires public authorization and non-empty schema declarations on compatibility tools.

  Requests now route to the active endpoint with the required public credentials and schema declarations, restoring free model access across both direct connections and deployed relays.

## 1.36.2

### Patch Changes

- Auto-recover OpenCode Zen 403 FreeTierError: when upstream OpenCode Zen refuses a session with `403 FreeTierError` ("OpenCode's free tier can only be used from within OpenCode"), the local proxy now catches the gate error in-flight and transparently fails over to a healthy KiloCode fallback model on the same wire API, rather than bubbling the 403 back to the coding agent.
- Prune decommissioned `ling-3.1-flash-free` from the active catalog and add it to the exclusion list, locking the verified catalog to 36 models.
- Update OpenCode version fallback to 1.19.0.

## 1.36.1

### Patch Changes

- Fix tool calls being rejected as invalid JSON on every model, and tool names coming back under a name the host never registered.

  - A tool whose arguments arrived carrying the tail of the previous call is now repaired for **every** tool, not only tools declaring a nested object or array. The most-used tool, the shell command tool, declares nothing but scalars, so it was never repaired at all — the call was rejected and the turn looped on the same broken payload.
  - Buffered tool arguments are released when a stream ends without its normal ending event, instead of being dropped: a truncated stream used to deliver a call with no arguments at all.
  - The tool-name restore now runs on the Cline and OVH lanes too. Those lanes send a renamed tool upstream but never took it back, so a client received a call for a tool it does not have.
  - A caller that declares both file-pattern and semantic-search tools now keeps both. The two share a name across hosts but are different tools, and collapsing them handed the model one tool under the other's shape.
  - A truncated number is refused rather than completed, and an inner object is never promoted over the wrapper that declares it.
  - A non-streaming answer from the Kilo lane is repaired like a streamed one.
  - The free tier is the only lane that renames a tool now. The other lanes carry
    the caller's own names in both directions, so the host dispatches natively
    instead of waiting for a name that never comes back.
  - Tools that declare an optional value as "value or nothing" are repaired
    again. Both hosts describe optional settings that way when a tool is declared
    strictly, and reading that as "always send it" silently switched repair off
    for the shell command tool — the one that matters most.
  - A model answering an optional setting with the word "none" as text, instead of
    leaving it empty, is now corrected rather than rejected. Affects roughly one
    model in nine.
  - A streamed Anthropic-format answer is now repaired and mapped like the other
    two formats. It was forwarded untouched.
  - A stream that ends without an answer says so, instead of reporting an empty
    successful one.

## 1.36.0

### Minor Changes

- bf358da: A new free model on the OpenCode Zen lane: Cat Jam

  `cat-jam-free` joins the picker, bringing the catalog to 37 models (11 OpenCode, 15 Kilo, 2 Cline, 9 OVHcloud). No account, no key, no setup — it is keyless like every other Zen free model.

  It thinks, and it has a 262,144-token window. That number was measured the hard way: the gateway happily accepts prompts four times that size and answers normally, but the model can no longer read them. A marker planted at the end of a 248,232-token prompt comes back; at 250,272 tokens it does not. So the advertised window is what the model can actually use, not merely what the service tolerates.

  Two honest limits worth knowing before you pick it:

  - **It is not available on the Responses API.** Requests sent that way are refused with a protocol error. It works on chat completions, which is what hosts use by default, but a host pinned specifically to Responses will not see it.
  - **Thinking depth starts at "low".** The lowest setting is refused, so "minimal" is not offered; low, medium, high and extra-high all work.

  The output budget is 131,072, the published figure for this model.

### Patch Changes

- bf358da: Long sessions no longer stall on a tool call whose arguments arrived spliced

  Some models open their next tool call by echoing the tail of the one they had just seen, and occasionally stop before the closing brace. The result is a single argument string carrying both faults at once: the previous call's leftover text in front, and the last brace missing. The whole call was then rejected, the turn failed, and the host retried — which resent the same broken payload, so a long session could get stuck repeating it.

  Both faults are now repaired together, so the caller's own arguments arrive intact.

  The repair stays deliberately narrow. It only fires when a leftover fragment is actually present in front of the object, which is the evidence that the model was mid-call rather than that the request itself was malformed, and only when what follows is a complete object merely missing its closing brace. Arguments cut off part-way through a value are still refused untouched, because completing those would silently shorten them — and these arguments carry shell commands.

  Tool calls that were already well-formed are unaffected and pass through byte-identically.

## 1.35.0

### Minor Changes

- 9085408: Nine more free models, from OVHcloud's AI Endpoints — and no account needed

  The picker now offers nine open-weight models served by OVHcloud AI Endpoints, bringing the catalog to 36: GPT-OSS 120B and 20B, four Qwen models (3.5 397B, 3.5 9B, 3.6 27B, 3.8 27B), Mistral Small 3.2 and Mistral 7B, and Meta Llama 3.3 70B. The four Qwens and Mistral Small 3.2 also read images.

  Access is anonymous and keyless. There is nothing to sign up for and no key to paste — no login step, no saved credential, no setup of any kind. Pick a model and it works.

  The honest caveat: OVH rate-limits anonymous callers per IP address. A burst of parallel subagents can run into `API rate limit exceeded`, the same way a shared OpenCode or Kilo quota does. Wait it out or spread the work across models. Requests to these models always go straight to OVH from your machine, never through your relay pool — there is no per-IP gate for a relay to route around.

  Thinking depth is limited to the two levels OVH confirms, `low` and `high`, on the six models that reason. The output budgets are deliberately conservative: they are the smallest cap any provider offers for the same underlying model, so a turn never asks for more than OVH will give.

### Patch Changes

- 3408dad: Stop conversations from dying on request shapes the provider rejects

  Three shapes that the provider answers with `400 invalid parameters` are now reshaped on the way out instead of failing the whole turn.

  - **A model narrates a tool call instead of making one.** The reply is recorded as pre-tool commentary, and every later message replayed that turn back to the provider was rejected — the session could not continue or be resumed, because each retry sent the same history again.
  - **A host asks for a specific tool or forces a tool call.** The free provider accepts only automatic tool selection, so an unsupported choice is dropped rather than sent. Nothing is imposed on a host that did not ask.
  - **A tool name carries a character the provider rejects.** Spaces, colons and slashes are folded for the trip out and the caller's own name is restored on the way back, so the tool still runs under the name it was registered with. Names that are already accepted are sent exactly as they always were.

  Measured on Muse Spark 1.3: the same three requests that each failed with an error now answer normally, and a well-formed tool set reaches the model byte-identical to before.

- 9085408: Three free models that no longer answer are gone from the picker

  `cline-free/deepseek-v4.1-flash`, `cline-free/kimi-k3` and `cline-free/solar-pro4` were retired upstream, so every turn on them failed. All three were probed twice against the live service on 2026-10-13 and each time answered `404 model not found` ("Cline has no such model. Refresh the model list and retry."), while the two Cline models that survive — `cline-free/muse-spark-1.3-contributor` and `z-ai/glm-5.3-flash` — answered 200 with the same login and request shape. The login, the quota rollover and every other model are unchanged; the picker is now 36 models (10 OpenCode, 15 Kilo, 2 Cline, 9 OVH).

## 1.34.0

### Minor Changes

- aa6f259: Three new free models, picked the same way as the rest (`/model` → `freeflow` → pick):

  - **Step 5 Preview** on OpenCode Zen (`step-5-preview-free`, short name `step-5-preview`) — 1M context, answers with vision.
  - **Step 5 Preview** on KiloCode (`stepfun/step-5-preview-free`, short name `step-5-preview:kilo`) — 1M context, answers with vision.
  - **Glyph Cluster** on KiloCode (`stealth/glyph-cluster`, short name `glyph-cluster`) — 256K context, text answers.

### Patch Changes

- 50981fb: Align nine model entries with the specs their upstream catalogs publish. Models now advertise video input where the vendor lists it, two entries pick up a larger context window, and Step 5 Preview on KiloCode reports the full 64K output allowance.
- f637c58: Recover tool calls that arrive with the tail of the previous call stuck to the
  front. Some models open a new call by echoing the end of the one they have just
  seen, so a single call is delivered as `<tail of previous>{"…this call…"}` and
  the host refuses it as invalid JSON. When such a payload does not parse, the
  proxy now locates the complete call behind the stray text and hands that back.

  Only payloads that already fail to parse are rescanned, and only a position that
  yields a complete object is accepted — a well-formed call is never rewritten,
  and a truncated one is still refused rather than completed.

  Also adds a whole-inventory fidelity test covering every tool either host can
  declare, across all three API shapes.

- aa6f259: Remove three free models that stopped serving upstream, so they no longer appear in the model list:

  - **Fledge Alpha** on OpenCode (`fledge-alpha-free`) — withdrawn upstream and no longer listed.
  - **Ling 3.0 Flash Sante** on KiloCode (`inclusionai/ling-3.0-flash-sante:free`) — the free variant is gone; only the paid one remains.
  - **Step 3.7 Flash** on KiloCode (`stepfun/step-3.7-flash:free`) — the free variant is gone; only the paid one remains.

  All three are excluded permanently, so a stale on-disk catalog or a later catalog refresh cannot bring them back.

- 50981fb: Correct the OpenCode Zen Step 5 Preview entry: it is a reasoning model with 1M context, 64K max output, text/image/video input, and only `low`/`medium`/`high` thinking levels (`minimal` is explicitly disabled). Previously the entry mirrored the Kilo sibling and the fallback heuristic, so the picker showed no thinking support.

## 1.33.3

### Patch Changes

- Fix tool calls being rejected with an invalid-arguments error when a model makes several calls in one turn. Some models label every parallel call `0`, so the pieces of different calls were joined together and arrived as one unreadable blob — a planning tool could then reject every update, even a minimal one, and leave its task list stuck mid-turn. Calls are now kept apart by their own identifier, and a call whose text arrives in several pieces still reassembles whole.

## 1.33.2

### Patch Changes

- Document how the OpenCode free tier decides whether to answer a request: which request properties open the gate, which commonly repeated assumptions about it are wrong, and how to reproduce a check locally.
- Fix tool calls breaking down on free models.

  When a request carries a full set of agent tools, free models often return tool arguments that do not match the tool's declared shape. A planning tool asked for phased tasks could come back with the phases buried inside a JSON-encoded list under the wrong field, wrapped in an extra object, or under names the tool never declared — so the host rendered each phase as one long raw JSON string instead of real task lines.

  The proxy now checks returned arguments against the tool schema the caller declared and repairs them when the intended shape is unambiguous, across all three API shapes, streamed and non-streamed, and for every supported model provider. Well-formed calls, calls for tools without structured parameters, and arguments that were cut off mid-stream all pass through untouched.

## 1.33.1

### Patch Changes

- Removed one free model from the catalog that could never be used in a coding session. It answers a plain chat request fine, but rejects any request that carries tool definitions — and coding agents always send tools, so picking it failed on every turn with a "no endpoints found that support tool use" error. The catalog is now 30 models.

## 1.33.0

### Minor Changes

- One new free model, picked the same way as the rest (`/model` → `freeflow` → pick):

  - **Ling 3.1 Flash** on KiloCode (`inclusionai/ling-3.1-flash`, short name `ling-3.1-flash:kilo`) — 262K context, text answers.

### Patch Changes

- Remove four free models that stopped serving upstream, so they no longer appear in the model list:

  - **MiMo V2.5** on OpenCode (`mimo-v2.5-free`) — upstream answers `401 Model is not supported`.
  - **Exo** on OpenCode (`exo-free`) — upstream answers `503 Endpoint is unavailable`.
  - **Space Bunny Alpha** on KiloCode (`stealth/space-bunny-alpha`) — upstream answers `404 does not exist`.
  - **Qwen 3.8 27B** on KiloCode (`qwen/qwen3.8-27b:free`) — upstream answers `404 currently unavailable`.

  All four are excluded permanently, so a stale on-disk catalog or a later catalog refresh cannot bring them back.

- Requests that ask for a thinking level a model does not offer no longer fail: the level is clamped to the highest level that model supports (previously only Muse Spark was covered — now every model is), and a chat-style `response_format` left on a responses request is dropped instead of rejected upstream.

## 1.32.2

### Patch Changes

- Prevent JSON parse errors on interrupted responses: network packet boundaries split mid-delta no longer produce unterminated string syntax errors when a turn is retried or terminated.

## 1.32.1

### Patch Changes

- Recover interrupted answers automatically: when a response stream cuts off mid-answer, the pending turn is retried once on the next healthy relay instead of stopping partway
- Retry once automatically when the model briefly fails a request: a transient model-side error is now retried on the next relay instead of surfacing immediately, and health reporting distinguishes model failures from relay problems
- 9b523e9: Keep relay connections warm across turns for faster repeat requests

## 1.32.0

### Minor Changes

- Relay sessions now stick to their warm relay and release it after 20 minutes idle, so follow-up turns in one session reuse the fast path instead of paying a cold start.

## 1.31.0

### Minor Changes

- de0a0fe: Two new free models on OpenCode Zen, picked the same way as the rest (`/model` → `freeflow` → pick):

  - **Fledge Alpha Free** (`fledge-alpha-free`, short name `fledge-alpha`) — 1M context, answers with vision.
  - **Ling 3.1 Flash Free** (`ling-3.1-flash-free`, short name `ling-3.1-flash`) — 262K context, text answers.

### Patch Changes

- 48eec6d: Remove two free models that had stopped serving upstream, so they no longer appear in the model list:

  - **Ling 3.0 Flash Fin** on OpenCode (`ling-3.0-flash-fin-free`) — upstream answers `400 Endpoint is unavailable`.
  - **Ling 3.0 Flash Fin** on KiloCode (`inclusionai/ling-3.0-flash-fin:free`) — upstream answers `404 does not exist`.

  Both are excluded permanently, so a stale on-disk catalog or a later catalog refresh cannot bring them back. The short name `ling-3.0-flash-fin` no longer resolves; `ling-3.0-flash-sante` is unaffected and still works.

## 1.30.0

### Minor Changes

- **Spread relay mode.** `/freeflow spread` sends each request to a rotating healthy relay instead of always starting at one sticky relay, so parallel sessions and subagents land on different egress IPs rather than crowding a single one. A conversation's reasoning issuer still outranks the rotation, so in-progress chats are never rerouted, and a relay that is cooling down is never preferred. The interactive relay menu and `/freeflow status` show the new mode.

  **Helper tools the proxy injects for API compatibility can no longer reach your host.** On the messages API path those injected tool calls were passed straight through; they are now stripped on every path, and a host that declares no tools never receives tool calls at all.

  **Injected file-search helper now matches the shape your host expects**, so a call to it executes instead of being rejected.

## 1.29.0

### Minor Changes

- e119a71: Sync upstream tracking to v1.18.34 and land compatibility improvements: Vercel relays are now treated as a last resort behind Cloudflare with clear quota guidance, new relays show when a deployment is disabled by quota, and streamed responses plus tool-using callers stay compatible through the local proxy.

## 1.28.1

### Patch Changes

- Retry relay reachability checks after deployment so edge routing propagation delays do not show a fresh relay as unreachable — the check retries with progress notices and only warns if the relay stays dark.

  Fix upstream drift alerts to stop flagging commercial paid model families as free candidates, while known alpha and stealth free models keep their free status.

## 1.28.0

### Minor Changes

- 526d43f: Refresh the free model catalog to the current live rotation (33 models).

  - New: Space Bunny Alpha on the KiloCode Gateway free list (1M context window) — pick it with the short name `space-bunny-alpha`.
  - Back: Step 3.7 Flash returns to the KiloCode Gateway free list after a live serving re-check.
  - Retired from the picker: Nex N2.5 Pro, Nex N2.5 Mini, and GLM 5.2 free — all three are gone from the free list (only paid versions remain).

- 526d43f: Add LongCat 2.5 Preview Free (`longcat-2.5-preview-free`) from OpenCode Zen with a 1M context window, reasoning, and vision.

  Fix upstream drift detection to accurately recognize free and alpha models while excluding commercial paid model families from candidate suggestions.

### Patch Changes

- 526d43f: Retry relay reachability verification after deployment so edge DNS and routing propagation delays (such as newly created Cloudflare Workers routes) do not show a false unreachable warning.

## 1.27.0

### Minor Changes

- 2b20cbf: Cline accounts now show which login served requests: the accounts list shows per-login request totals with the last used model and time, and status shows a summary of the most recently used login.

### Patch Changes

- 0931e12: Fix deployed relay target matching and private-host protection.

## 1.26.1

### Patch Changes

- Fix `/freeflow deploy vercel` failing at the Vercel build step with `Unterminated string literal`. The generated relay file now passes syntax checks on all three deploy targets, and newly deployed relays come with a built-in password by default instead of being openly usable by anyone with the URL.
- Recover from expired conversation reasoning references instead of failing every turn. When the provider reports a reasoning item as expired, the request is retried without the unresolvable history on the same relay, so the session continues with one turn of lost reasoning context rather than dying.

## 1.26.0

### Minor Changes

- Three newly available free models: MiMo V2.6 Flash on OpenCode Zen (1M context, answers with vision), plus Qwen 3.8 27B (vision) and GLM 5.2 on the KiloCode Gateway — pick them with the short names `mimo-v2.6-flash`, `qwen3.8-27b`, and `glm-5.2`.
- New free model available: Space Bunny Free on OpenCode Zen (1M context, large output window, answers with vision) — pick it with the short name `space-bunny`. Two models left the picker because they are gone from the KiloCode Gateway free list: Step 3.7 Flash (only the paid version remains) and Ling 3.0 Flash VL (only the paid version remains).

### Patch Changes

- When Cline's daily free limit is used up on every saved login, the error message now says so directly — how many saved logins ran out, when the nearest one resets, and that switching models or adding another login helps. Previously that guidance sat in a field most clients never display, so you only saw Cline's own terse wording.

## 1.24.0

### Minor Changes

- Cline requests now identify as the Cline desktop app. That client identity is what makes Cline advertise its sixth free model, Kimi K3, so it joins the model list next to the four Cline models you already had.

  Kimi K3 (`cline-free/kimi-k3`) has a 1M-token context window, reads images, and takes the same `low` / `high` / `max` thinking depths as the other flash-class Cline models. It uses the login you already saved with `/freeflow cline login` and the same daily free quota, so a request that hits the limit on one saved login rolls to the next exactly like every other Cline model. Nothing about the other providers changes.

### Patch Changes

- Cline logins are used more sensibly, and the message you get when they are all out matches what actually happened.

  A saved login that has used up its daily free allowance for a model is now skipped instead of being retried on every request, so a turn goes straight to a login that still has allowance for that model. A login that starts working again is picked back up on its own.

  When every saved login is out for that model, the answer now says so: it names how many logins were tried, when the nearest reset is, and that switching models or adding another login (`/freeflow cline login`) is what helps — instead of implying that a single login was at fault.

- Kilo models work again. Kilo's gateway now rejects the placeholder credential the proxy used to send and accepts the same request without one, which broke every Kilo-model turn with a 401 "invalid token" error. The proxy no longer sends a credential for Kilo, so its models answer again instead of failing with a 401.
- Model selection can no longer lose models the extension ships with. When the saved copy of the live catalog was newer than the built-in list and the live refresh could not run, the provider used to be re-registered from that saved copy alone, so a model added in a later update could drop out of model selection until the app was restarted. The saved copy is now always overlaid on the built-in list, so no update can lose models that way.
- Removed Union Alpha from the model list. It stopped being served upstream: every request is rejected as an unsupported model, on both the chat and the Anthropic Messages paths, so picking it only produced an error. It is gone from model selection and cannot come back through a stale catalog cache. The Anthropic Messages request path itself stays supported for future models.

## 1.23.3

### Patch Changes

- Fix a test that failed intermittently on CI: it compared the whole response body of a chat request, including the timestamp each side stamps when it builds the body. When a request happened to cross a second boundary the two timestamps differed by one and the test went red even though nothing was wrong. The timestamp is no longer compared digit-for-digit, and the test now checks it is a real timestamp instead. No change to how the proxy behaves.

## 1.23.2

### Patch Changes

- Saved Cline logins are now recoverable. The pool keeps a backup copy beside it, so a pool that is missing or unreadable restores itself from the last good set of logins instead of silently coming back empty — losing every saved login to one bad write is no longer permanent. The backup also holds the largest set of logins ever seen, so it survives a run of smaller bad writes rather than being overwritten by the first one. Removing your last login still sticks: an intentionally empty pool is left alone rather than being repopulated from the backup.

## 1.23.1

### Patch Changes

- Cline logins no longer accept the same account twice. Two logins for one account share a single free quota, so the second one added nothing while making it look like you had more capacity — signing in with an account you already saved now says which slot has it and leaves your logins untouched. If a set of logins already contains the same account twice, `/freeflow cline accounts` marks the later one `— same account as [slot]` so you can tell them apart and remove the spare.

## 1.23.0

### Minor Changes

- Adding more Cline logins is now easy. Every login gets its own slot (`default`, `slot-2`, `slot-3`, …) and requests roll across all of them, so a second or third account keeps you working when one hits its free daily limit. The sign-in prompt now shows the link to sign out of Cline in your browser (`/freeflow cline signout` prints it any time), which is what you need to approve the next account with a different email — or use a private window and keep the session you already have. `/freeflow cline accounts` shows each login's email so you can tell them apart.

## 1.22.4

### Patch Changes

- Cline fixes after live testing with a real account. Restoring a signed-in Cline login could return a body that had already been discarded, so instead of Cline's actual error you got a bare "internal error" or an empty message; the real error text now reaches you. A login Cline itself rejects is now recognised as needing a fresh sign-in instead of being retried on every request forever. A request that finds no saved login no longer answers with a rate-limit status, so hosts stop treating "not signed in yet" as "wait and try later". Signing in through the browser no longer outlives its own code, survives a brief blip from the sign-in service, and a login added or removed while a request is running is no longer reverted. The model list now always includes every catalogued model even when a cached copy predates it, and `/freeflow cline accounts` and the remove picker show the account email so logins are easier to tell apart.

## 1.22.3

### Patch Changes

- Cline free models now work for real: DeepSeek V4.1 Flash, Muse Spark 1.3, GLM 5.3 Flash, and Solar Pro 4 all answered live against a signed-in account, over both the chat and responses endpoints, with and without tools. Removed the account lockouts that turned one failed attempt into a long "accounts are cooling down" wait, so every request now tries your saved logins fresh and reports the real upstream error instead of a made-up one. Removing a login is now a picker (`/freeflow cline logout`) instead of typing an exact slot name, and model list correctly labels Cline models as `clinecode`.

## 1.22.2

### Patch Changes

- Fix Cline login flow: the browser link and code now arrive in a single copy-paste block and stay pinned until login finishes, instead of the link scrolling away behind a separate waiting notice. Saved logins also refresh on their own again before expiring, and chatting with no logins saved tells you to add one instead of showing a rate-limit hint.

## 1.22.1

### Patch Changes

- Correct Cline free-model specs: DeepSeek V4.1 Flash and GLM 5.3 Flash are 1M context (not 262K) with vision support and low/high/max thinking levels; Solar Pro 4 is 512K context with the full thinking range. Model selection and docs now show the right numbers.

## 1.22.0

### Minor Changes

- Sign in to Cline right inside the extension: `/freeflow cline login` shows a browser link and code, approves your own Cline account, and saves it to a per-user pool on your machine — no pasting keys. Extra logins auto-name themselves (`default`, `slot-2`, …), saved logins refresh on their own, and requests roll across them when one hits its daily free limit. Pasting a key stays available behind `login --key`. Model selection labels every free model with its source ([OpenCode], [Kilo], [Cline]).

## 1.21.0

### Minor Changes

- Use Cline free models with your own Cline login: `/freeflow cline login` signs in through your browser and saves it to a per-user pool on your machine, `/freeflow cline accounts` lists saved logins, and `/freeflow cline logout` removes one. Adds DeepSeek V4.1 Flash, Muse Spark 1.3, GLM 5.3 Flash, and Solar Pro 4 from Cline's free rotation, and labels every free model with its source ([OpenCode], [Kilo], [Cline]) in model selection. Requests roll across saved logins when one hits its daily free limit or fails.

## 1.20.0

### Minor Changes

- Every tool from both supported hosts now works on every free model, including the models served on the dedicated responses endpoint. The proxy also tracks the latest client version in the background and always identifies itself with a supported one, so free-tier access keeps working as new releases come out.

  Also new: a daily automated check watches for upstream changes (new releases, free-model list and pricing changes) and files an issue when anything drifts, plus an opt-in script that verifies all tools end-to-end against the live free tier.

## 1.19.0

### Minor Changes

- Every tool your agent can use now works on every free model: the proxy translates tool definitions between chat, responses, and messages formats automatically, so built-in tools, MCP server tools, and custom tools all pass through intact on all request types. Strict tool schemas are preserved, and requests sent in one format to another endpoint are converted instead of rejected.

## 1.18.0

### Minor Changes

- OpenCode free-tier client fingerprinting: plain chat, subagent, evaluation, and background watchdog requests now pass upstream free-tier gates without error. The proxy automatically supplies compatibility tools and streaming conventions expected by the upstream gateway, while transparently converting responses to standard non-streaming format for callers that request it.

## 1.17.1

### Patch Changes

- Assistant and subagent requests now stay working when the shared free-tier gateway refuses sessions: retried and resumed conversations automatically continue on a healthy fallback model instead of repeating the refusal, and normal routing resumes on its own once the gateway recovers.

## 1.17.0

### Minor Changes

- Automatic upstream degradation: when the shared free-tier gateway starts refusing new sessions, new chat sessions seamlessly use a healthy fallback model on the same API, affected errors carry an actionable hint, in-progress chats are never rerouted, and normal routing resumes automatically on recovery. `/freeflow status` now shows live upstream state.

## 1.16.0

### Minor Changes

- New free model: Union Alpha Free joins the picker. It answers through a different upstream endpoint than the other free models, handled automatically — 262K context, image input, tool calling, and zero cost like the rest of the catalog.

## 1.15.2

### Patch Changes

- Relay traffic is now spent only on the free models the pool exists for: requests for other models go straight upstream even with the relay pool on, cutting relay bandwidth. Applies in automatic and always-on modes; relay-off behavior is unchanged.
- The disabled-deployment rollover now triggers only on genuine hosting verdicts, so ordinary payment and quota refusals always surface immediately without cooling a healthy relay. Relay-list imports also no longer show a negative removal count when the file holds more relays than the current pool.

## 1.15.1

### Patch Changes

- Requests now roll over to the next relay when the current one answers with a disabled-deployment verdict, instead of failing on the first relay and requiring a manual switch. Other payment and quota refusals still surface immediately.

## 1.15.0

### Minor Changes

- Free-tier requests now use native session identifiers and an up-to-date client version, after the upstream gateway began rejecting older formats with a free-tier error. `/freeflow test` also gains an end-to-end chat check that verifies a relay can actually run inference, not just list models.

## 1.14.0

### Minor Changes

- c28b7b5: Local proxy recovers on its own: if the background proxy stops unexpectedly, the extension now notices the refused local connection and starts a fresh proxy within seconds instead of leaving every model failing until the next session; shutdowns and crashes are also recorded in the log so the cause is visible.

### Patch Changes

- /freeflow update now goes through the host plugin managers first — reinstall under OMP, package update under Pi — and only then falls back to a global install, using Bun when npm is missing. Previously the first step called an update action the plugin manager does not define, so managed installs always fell through to the wrong target.

## 1.13.0

### Minor Changes

- 39a06b9: Carry a relay pool between machines: `/freeflow export` saves the relays to a file and `/freeflow import` loads them back, adding to the current pool by default or swapping it whole on confirmation.

## 1.12.1

### Patch Changes

- b32f208: Sessions survive a relay change without a rejected turn.

  Responses models sign each thinking block for the upstream backend that produced it, and only that backend can read it back. When a later turn reached a different backend, the replayed blocks were rejected as unreadable ("reasoning `encrypted_content` was not issued to this caller"), the host repeated the same failing request, and the session could not continue.

  pi-freeflow now keeps each conversation on the relay that issued its reasoning while that relay is healthy, and when a relay change is unavoidable (rate limit, relay removed or redeployed, direct-mode switch) it sends that turn without the signed thinking blocks, so the new backend accepts it on the first attempt. If a rejection still happens (the provider can change backends behind a relay), the request is retried once without the blocks, and only the rejected blocks are dropped on later turns, so the model keeps whatever reasoning the current backend can read. Messages, tool calls and tool results are always preserved.

## 1.12.0

### Minor Changes

- Free-model picker grows from 24 to 26: adds Nex N2.5 Pro, Nex N2.5 Mini, and Ling 3.0 Flash VL, and removes the discontinued Inkling entry. A new Stealth Models Watchlist docs page tracks masked preview IDs users ask about.

## 1.11.2

### Patch Changes

- 549b66e: Oversized requests no longer fail at the relay hop: when a relay answers 413 payload limit, the proxy transparently tries the next relay and then the direct route, keeping the stream alive. Long sessions that outgrow the relay payload cap now complete instead of surfacing a function payload error.

## 1.11.1

### Patch Changes

- Apologies for the daemon disconnect bug introduced in v1.11.0: in multi-agent workflows or when subagents, evaluations, and background tasks completed, the extension prematurely detached from the local proxy daemon, causing the proxy to shut down while your main session remained active. The heartbeat connection now persists throughout your active terminal session.
- Increased local health check and liveness probe timeouts from 800ms and 500ms to 2500ms and 1500ms, with an automatic probe retry to avoid false-alarm daemon restarts during heavy concurrent streaming.
- Added unhandled error logging inside the daemon to prevent silent process exits.
- Fresh installs now log full HTTP lifecycle debug output by default so diagnostic reports contain complete request context; turn it off anytime with `/freeflow debug off`.

## 1.11.0

### Minor Changes

- Proxy daemon now stays up while any session uses it, even when idle. It shuts down only after the last session leaves, instead of retiring after a short quiet window.

## 1.10.0

### Minor Changes

- cf48598: Hands-free proxy recovery plus catalog refresh: the proxy now watches its own health, restarts with backoff instead of leaving a dead port, and can start on login. Removed two discontinued free models from the picker.

All notable changes to pi-freeflow. Public, user-visible behavior only.

## 1.9.9 - 2026-09-06

### Fixes

- **Removed our own request cap — sorry, that one was on us.** The proxy used to enforce a built-in request limit and could answer 429 before upstream quota was actually exhausted. That was a bug, not your quota. From this version the proxy never rejects on quota itself: a 429 only surfaces when the upstream — and every relay in your pool — genuinely is rate-limited, and that response now points you at `/freeflow deploy` to add relay egress.

## 1.9.8 - 2026-09-06

### Fixes

- **Stale model list heals itself (follow-up to #6).** If your saved model list predates a newly added model, the background refresh now repairs the entry (correct endpoint and details) instead of sending requests to the wrong address — no manual `/freeflow refresh` or cache deletion needed.
- **Paid models stay out of the picker even from old saved lists.** Every read of the saved model list now drops non-free entries, so models requiring an API key cannot linger after an upgrade.
- **Old saved lists without a sync marker now re-sync once.** A saved list that could never trigger a network check now performs one plain revalidation (then syncs normally), so newly added free models appear without manual intervention. Missing or corrupt lists still fall back silently with no network call.
- **Upstream errors are now visible in the proxy log.** Failed upstream responses log their status code and model, and a model routed to the wrong endpoint logs the mismatch with the fix (restart Pi/OMP after upgrade).

### Validation

- TypeScript typecheck passed cleanly (`tsc --noEmit`).
- Full test suite passed on Windows (304 tests) and Ubuntu Linux (`acerblue`, 305/305 tests passed), including new regressions for the stale-cache shape from #6.
- Live sweep of all 26 models through a fresh install on `acerblue`: 23/26 answered on first try (both Muse Spark models via the Responses endpoint); the 3 misses are upstream per-model daily quotas (429), zero server errors.

## 1.9.7 - 2026-09-06

### Fixes

- **Model picker only shows verified free models (fixes #6).** Background catalog refresh now filters out non-free models from upstream endpoints so paid models requiring an API key no longer leak into your picker.
- **Relay pool automatically recovers from dead deployments (fixes #5).** If a relay URL in your pool returns an infrastructure 404 (such as a missing or deleted Vercel deployment), the proxy marks it as failed and immediately rolls over to your next healthy relay or direct mode instead of getting trapped in a 404 loop.

### Changes

- **Updated model catalog (26 verified free models: 7 OpenCode Zen + 19 KiloCode Gateway).**
  - Added `inclusionai/ling-3.0-flash-sante:free` (Ling 3.0 Flash Sante, 262K context, 32K output, reasoning supported). Clean CLI alias `ling-3.0-flash-sante` supported.
  - Removed `laguna-s-2.1-free` (OpenCode Zen) after upstream dropped free-tier access. `poolside/laguna-s-2.1:free` on Kilo remains active.
- **Public by default for new relay deployments.** Relays deployed via `/freeflow deploy` are now public by default with no mandatory authentication tokens. This enables seamless copy-paste migration across proxy tools (such as 9router) while maintaining safety guards for allowed AI upstreams.

### Validation

- TypeScript typecheck passed cleanly (`tsc --noEmit`).
- Full test suite passed across Windows (299 tests) and Ubuntu Linux (`acerblue-local`, 300/300 tests passed).
- End-to-end concurrency and failover stress testing verified (100 parallel requests, 20 subagent leases, burst failover).

## 1.9.6 - 2026-09-03

### Fixes

- **Hiding the status widget now sticks.** `/freeflow hide` survives restarts, new sessions, and background update notices — previously the widget could reappear on the next session.
- **Calmer startup with many sessions.** Sessions starting at the same time now converge on a single background proxy instead of each spawning its own; a spawn that never becomes ready falls back to in-process mode instead of running untracked.
- **Survives daemon restarts mid-session.** If the background proxy is replaced while sessions run, connected sessions re-register automatically instead of silently losing their lease (which could retire the daemon mid-use).
- **Stale-version cleanup targets the right process.** Windows port matching is now exact, and Linux without `lsof`/`fuser` resolves the holder via `/proc` instead of giving up.
- **`/freeflow logs --follow` no longer runs forever.** The live tail stops when the session ends and caps burst output; the update/install subprocess now has a 2-minute timeout.

### Validation

- `npx tsc --noEmit` clean, `npm test` 299 (298 pass + 1 Linux-only skip) + smoke green on Windows; stress harness 7/7 on Windows and Linux `acerblue-local`. **`macOS not tested`** this cycle.

## 1.9.5 - 2026-09-03

### Changes

- **Catalog refreshed against live upstream model lists (26 models: 8 OpenCode Zen + 18 KiloCode Gateway).** Re-checked both upstreams against their live endpoints and live inference probes:
  - **Added** `muse-spark-1.3-contributor-free` (OpenCode Zen, Responses API, 1M context, 131K output, vision) — verified live: completes with reasoning, accepts effort levels, and answers vision queries.
  - **Removed** `hy3-free` (OpenCode Zen) — upstream no longer serves it (`Model hy3-free is not supported`).
  - **Removed** `tencent/hy3:free` and `meituan/longcat-2.0-free` (KiloCode Gateway) — upstream free tier dropped them (model unavailable / sign-in required).
- Pruned IDs added to the dead-model filter so a stale disk cache cannot resurrect them.

### Validation

- `npx tsc --noEmit` clean, `npm test` full suite green on Windows.

## 1.9.4 - 2026-09-02

### Dependencies

- **Zero runtime dependencies.** Removed `undici@8.10.0` — `pi` (`0.84.4`) and `omp` (`18.1.3`) already bundle `undici` 6.x/7.x and expose `global fetch` with keep-alive pooling. `relayFetch` and proxy now use `global fetch` directly (`src/relay.ts` `Agent` + `canUseCustomDispatcher` + `dispatcher: agent` removed; `src/proxy.ts` dispatcher removed). Keeps thin `11.3k` + `298 tests` + `0 deps` compatible directly with `reference/pi` + `reference/oh-my-pi`.

### Validation

- `npx tsc --noEmit` clean, `npm test 298/298` on **Windows** (`omp/18.1.3`, `pi 0.84.4`) and **Linux `acerblue-local`** (`Ubuntu 6.8.0-138`, `node v22.23.2`, `pi 0.84.4`) via `/tmp/pi-freeflow-validation`. **`macOS not tested`** this cycle.

## 1.9.3 - 2026-09-02

### Fixes

- **Windows console flood fixed.** Two Windows-only helpers flashed a visible `conhost`/`cmd` window on every daemon probe: `netstat -ano | findstr :28180` / `taskkill` in the stale-daemon replace path and `spawn(omp|npm, shell:true)` for `/freeflow update`. Both now use `windowsHide: true` (no-op on Linux/macOS) and `spawnWithProgress` was refactored to `Promise.withResolvers` to satisfy `ts-promise-with-resolvers`. Idle `pi` no longer spawns many visible consoles even after closing the terminal (detached daemon at `127.0.0.1:28180` survives by design; `beatOnce` 10s heartbeat now throttled 2s via `lastSpawnAt`).
- Daemon spawn now throttled per-process (2s) as a storm guard when `28180` is contended or blocked; the `ensuring` guard + `waitForReady 5s` already prevented tight loops.

### Validation

- `npx tsc --noEmit` clean, `npm test 279/279` on **Windows** (`omp/18.1.3`, `pi 0.84.4`) and **Linux `acerblue-local`** (`Ubuntu 6.8.0-138`, `node v22.23.2`, `pi 0.84.4`) via `/tmp/pi-freeflow-validation`. **`macOS not tested`** this cycle.
- Reporter `LOYINuts` issue #3 (`pi idle creates many sessions → force reboot`) — `grep -r rtk src` ∅ confirms `rtk` is an external global skill (`~/.agents/skills/rtk` → `Command::new("cmd")` without `CREATE_NO_WINDOW`), not `pi-freeflow`. After this fix, closing the terminal no longer leaves flashing zombies; kill via `netstat -ano | findstr :28180` → `taskkill /F /PID` or `/freeflow kill`.

## 1.9.2 - 2026-08-31

### Fixes

- **Closing one session no longer stops the shared local proxy.** The proxy daemon
  is now a fully detached background process: it outlives any single OMP/Pi session
  (previously, closing the session that owned the daemon could shut it down even
  while other sessions were still using it). It retires by itself only when no
  session is connected, no request is in flight, and it has been idle for a grace
  period. The next use starts it again automatically.
- New command: `/freeflow kill` (aliases `stop`, `shutdown`) stops the background
  daemon on demand. The next freeflow use restarts it.

### Improvements

- The proxy tracks connected sessions and last request time; `/freeflow status`
  and the health endpoint now report active session leases, so you can see when
  other sessions are keeping the daemon alive.
- Docs: the command reference now lists `kill`, and the FAQ explains the shared
  daemon lifecycle (survives session close; self-retires when unused).

## 1.9.1 - 2026-08-30

### Fixes

- Stale-daemon guard completed: a pre-1.9.0 daemon cannot report its in-flight requests, and usage cannot be verified — so it is now left running instead of being replaced. Previously such a daemon could still be killed mid-stream while busy (a one-time window when upgrading from 1.8.x). The guarantee now holds in every case: only older, verified-idle daemons are replaced.
- The stale-daemon kill ritual was consolidated into one path (it was duplicated at five call sites); behavior unchanged.
- Tests: new coverage for the pre-1.9 daemon case; shared sandbox helpers extracted.

## 1.9.0 - 2026-08-30

### Development hardening

- Test suite now runs fully sandboxed: every test uses a temporary data directory, so no test can ever write to your real `~/.pi/agent/` files or interfere with a running local proxy. A single env override (`PI_*_DATA_DIR`) re-roots all data files for tests/CI.
- Added a complete mocked user-flow e2e suite: fresh install → onboarding → proxy health → direct chat → relay add/roll/fallback → guided deploy → update check → command surface — all deterministic, zero network.
- Docs: test counts no longer hardcoded in README (they drifted with releases); release history tracked here.

### Fixes

- **Stale-daemon replacement no longer interrupts running sessions.** The shared local proxy can be held by another OMP/Pi session; the old upgrade logic killed that holder on version mismatch, which could terminate the session that owned the proxy mid-stream. Replacement now only happens when the running daemon is strictly older AND idle (0 in-flight requests, reported via `/_health`); newer or busy daemons are reused with a log note instead. Optional opt-out: set the no-kill env to `1` (see README FAQ for upgrades).

## 1.8.2 - 2026-08-30

### Fixes & polish

- Deploy: compare-and-swap on concurrent deployments (no duplicate relays when two sessions deploy at once).
- Proxy: URL-encoding edge cases (`%` in paths), startup timeout and kill handling, port conflict fallback.
- Logs: sanitized sensitive headers in debug output.
- Kilo gateway models: compatibility pass for all 25 models.
- Docs site build included; README per-host usage guide (Oh My Pi & Pi install + pick + manage).

## 1.8.1 - 2026-08-29

- Fix: stale-daemon auto-heal is now shipped in the published package (previously only in the repo).

## 1.8.0 - 2026-08-29

### Automatic upgrades

- On version upgrade, the extension detects a stale local proxy daemon and replaces it automatically — users get fixes without manual restarts or killing sessions.
- Fix: client auth key stripped before reaching the opencode.ai/zen upstream (failed with 401 for some clients).
- 3 new free models (28 total).

## 1.7.1 - 2026-08-29

- Docs: clarified npm is the distribution channel (the package is an extension loaded by OMP/Pi, not a standalone CLI).

## 1.7.0 - 2026-08-29

- 4 new free models (25 total) with live-verified specs (context/output limits, vision, thinking levels).
- New alias map aligned with host model selectors.

## 1.6.1 - 2026-08-29

- Catalog: thinking-level map locked per model; docs sync.

## 1.6.0 - 2026-08-29

### Onboarding & UX

- First-run onboarding message; 429 guidance hint (add your own relay egress).
- `/freeflow test` to probe a relay; relay latency tracking with health badges in `/freeflow list`.
- Guided deploy with context picker + confirmation; post-deploy health check.
- Status clarity: current mode + state file path; log text filter; per-relay usage counters; throttled roll notifications.

### Reliability

- Relay state write-protection: before every save, the current state is snapshotted to `.bak`; if the main file is corrupted or missing, the backup is recovered automatically.
- New-user flow never seeds a fake relay; starts in direct mode with an empty pool.

## 1.5.1 - 2026-08-28

- Edge-sweep fixes: port 28180 with legacy 18080 dual-probe auto-migration, OMP/Pi compatibility.
