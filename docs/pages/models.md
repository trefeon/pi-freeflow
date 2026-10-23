# Model Catalog & Upstream Routing

pi-freeflow provides unified access to **35 curated free models** across four upstream providers: **OpenCode Zen**, **KiloCode Gateway**, **Cline**, and **OVHcloud AI Endpoints**.

## Upstream Protocol Distinction

### OpenCode Zen — Responses API (`/v1/responses`)
- **Endpoint**: `https://opencode.ai/inference/v1/responses`
- **Models**: none right now — the lane is wired for any model that declares `api: "openai-responses"`, but the two Zen muse-spark contributor ids were retired upstream (1.3 on 2026-10-17, 1.2 on 2026-10-18) and Cline's Muse Spark 1.3 entry stopped resolving on 2026-10-22 (404 `Cline has no such model`). No static entry declares the flavor any more; stale caches and a future id still get it.
- **Config**: `api: "openai-responses"`, session affinity via OpenAI-nosession

### OpenCode Zen — Chat Completions (`/v1/chat/completions`)
- **Endpoint**: `https://opencode.ai/inference/v1/chat/completions`
- **Models**: 11 models (Cat Jam, DeepSeek V4.1 Flash, LongCat, GLM-5.3 Flash, Beam, Flint, MiMo, Nemotron, Big Pickle, etc.)
- **Config**: `api: "openai-completions"`, supports reasoning effort

### OpenCode Zen — Messages API (`/v1/messages`)
- **Endpoint**: `https://opencode.ai/inference/v1/messages`
- **Models**: none right now — the flavor is wired and supported, but no current free model serves it
- **Config**: `api: "anthropic-messages"`, no effort levels — the host sends a plain Anthropic body when a model declares this flavor

### KiloCode Gateway (`/v1/chat/completions`)
- **Endpoint**: `https://api.kilo.ai/api/gateway/chat/completions`
- **Auth**: keyless — no `Authorization` header at all (the gateway rejects a placeholder credential with `401 INVALID_TOKEN`; 200 req/hr per IP)
- **Models**: 15 models with OpenRouter-style thinking format

### Cline (`/api/v1/chat/completions`)
- **Endpoint**: `https://api.cline.bot/api/v1/chat/completions`
- **Auth**: per-user login via `/freeflow cline login` (browser approval, saved to a per-user pool on your machine)
- **Models**: 1 model from Cline's rotating free promo; requests roll across saved logins on the daily free limit
- **Routing**: direct only, never through the relay pool

### OVHcloud AI Endpoints (`/v1/chat/completions`)
- **Endpoint**: `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`
- **Auth**: keyless — no account and no `Authorization` header at all
- **Models**: 8 open-weight models (GPT-OSS, Qwen 3.5/3.6/3.8, Mistral, Llama)
- **Routing**: direct only, never through the relay pool
- **Config**: `api: "openai-completions"`. Chat is the only upstream shape: OVH's responses endpoint rejects every array `input` with `422 input: data did not match any variant of untagged enum ResponseInput` and accepts only a bare string, so a responses-path request is translated to chat upstream and the answer mapped back — the same shape mapping the Cline lane uses.

## 35 Model Specifications

### OpenCode Zen (11 models)

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `cat-jam-free` | 1,048,576 | 131,072 | low..max | ❌ |
| `mimo-v2.6-flash-free` | 1,048,576 | 131,072 | minimal..xhigh | ✅ |
| `nemotron-3-ultra-free` | 1,000,000 | 182,520 | minimal..xhigh | ❌ |
| `nemotron-3.5-lightning-free` | 1,000,000 | 235,929 | minimal..xhigh | ❌ |
| `nemotron-3.5-super-vl-free` | 1,048,576 | 235,929 | minimal..xhigh | ✅ |
| `big-pickle` | 200,000 | 32,000 | high, max | ❌ |
| `longcat-2.5-preview-free` | 1,048,576 | 131,072 | minimal..xhigh | ✅ |
| `glm-5.3-flash-free` | 1,048,576 | 131,072 | low, high, max | ✅ |
| `beam-free` | 1,048,576 | 131,072 | low..max | ❌ |
| `deepseek-v4.1-flash-free` | 1,048,576 | 393,216 | low, high, max | ✅ |
| `flint-40b-free` | 262,144 | 65,536 | low..max | ❌ |

### KiloCode Gateway (15 models)

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `dots-studio/dots-3-note-preview:free` | 393,216 | 262,144 | minimal..xhigh | ✅ |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 262,144 | 65,536 | minimal..xhigh | ✅ |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 182,520 | minimal..xhigh | ❌ |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 235,929 | minimal..xhigh | ❌ |
| `cohere/north-mini-code:free` | 256,000 | 64,000 | minimal..xhigh | ❌ |
| `poolside/laguna-s-2.1:free` | 1,048,576 | 131,072 | minimal..xhigh | ❌ |
| `poolside/laguna-xs-2.1:free` | 262,144 | 32,768 | minimal..xhigh | ❌ |
| `liquid/lfm-2.5-2.6b:free` | 128,000 | 32,768 | minimal..xhigh | ❌ |
| `kilo-auto/free` | 256,000 | 10,000 | minimal..xhigh | ❌ |
| `openrouter/free` | 200,000 | 65,536 | minimal..xhigh | ✅ |
| `stealth/glyph-cluster` | 256,000 | 256,000 | minimal..xhigh | ❌ |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | minimal..xhigh | ✅ |
| `reflection/beam-free` | 1,048,576 | 131,072 | low..max | ❌ |
| `recursive/flint-v1.0:free` | 262,144 | 65,536 | minimal..xhigh | ❌ |
| `xingchen-agi/xing4.0-29b-a4b:free` | 262,144 | 235,929 | minimal..xhigh | ❌ |

### Cline (1 model)

Cline free models come from a rotating per-account promo and need a browser login (`/freeflow cline login`; manage with `/freeflow cline accounts` and `/freeflow cline logout`). They run direct only, never through the relay pool. Cline's Muse Spark 1.3 entry stopped resolving upstream on 2026-10-22 (404 `Cline has no such model`), so the lane carries one model.

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `z-ai/glm-5.3-flash` | 1,048,576 | 131,072 | low, high, max | ✅ |

### OVHcloud AI Endpoints (8 models)

Anonymous access: no account, no key, no login step. Direct only, never through the relay pool — there is no per-IP gate for a relay to route around. OVH does rate-limit anonymous callers, so parallel subagents can hit `429 API rate limit exceeded` per IP. The `ovh-free/` prefix namespaces the lane in the picker; upstream only ever sees the part after the slash, which is case-sensitive.

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `ovh-free/gpt-oss-120b` | 131,072 | 65,536 | low..high | ❌ |
| `ovh-free/gpt-oss-20b` | 131,072 | 65,536 | low..high | ❌ |
| `ovh-free/Qwen3.5-397B-A17B` | 262,144 | 235,929 | low..high | ✅ |
| `ovh-free/Qwen3.5-9B` | 262,144 | 65,536 | low..high | ✅ |
| `ovh-free/Qwen3.6-27B` | 262,144 | 65,536 | minimal..high | ✅ |
| `ovh-free/Qwen3.8-27B` | 262,144 | 235,929 | minimal..high | ✅ |
| `ovh-free/Mistral-Small-3.2-24B-Instruct-2506` | 131,072 | 32,768 | ❌ | ✅ |
| `ovh-free/Meta-Llama-3_3-70B-Instruct` | 131,072 | 32,768 | ❌ | ❌ |

\* Max output is the highest published ceiling the lane serves. OVH itself only enforces `context − prompt`.

\* MiMo collapses `minimal→low` and `xhigh→high` upstream — 5 labels, 3 effective effort values (low/medium/high).

## Sources of Truth & Twin-Model Reconciliation

pi-freeflow configures models using a rigorous multi-source validation pipeline rather than copying unverified claims:

| Authority | Source | Role in pi-freeflow |
| :--- | :--- | :--- |
| **models.dev** | [`https://models.dev/`](https://models.dev/) (`api.json`) | Canonical open-source registry aggregating 230+ providers and model architectures. |
| **OpenRouter** | [`https://openrouter.ai/api/v1/models`](https://openrouter.ai/api/v1/models) | Sibling-lane cross-validation for gateway specifications, input modalities, and token pricing floors. |
| **OMP Built-in Catalog** | `reference/oh-my-pi/packages/catalog/src/models.json` | Authoritative coding-agent catalog grounding tested specifications across 75+ active providers. |
| **Live Upstream Probing** | Active gateway endpoints (`/inference/v1`, `/gateway/chat/completions`) | Protocol/tool-support and runtime-cap verification. A lower measured cap does not lower a published spec; it is surfaced as the authentic upstream error. |

### Highest-Published-Spec Twin Configuration Policy

When a model is available under multiple twin names (e.g. `deepseek-v4.1-flash-free` vs `deepseek-ai/DeepSeek-V4.1-Flash`), pi-freeflow configures the entry using the **highest published capability across twin models**:
- **Context Windows**: Set to the highest published spec shared by the free and paid twins. Where a lane publishes its own hard cap (OVH's advertised windows, the 1,000,000-token Nemotron 3 Ultra cap, Dots3-Note's 393,216 served window), that cap is authoritative. Where a lane merely throttles above a runtime limit (MiMo, GLM 5.3 Flash, Laguna S), the published spec stays and the authentic upstream error is surfaced above it.
- **Input and Output**: Input and output share one window. MiMo V2.6 Flash's origin publishes 1M context and 128K output, and the catalog follows that built-in spec; at full 128K output the input budget is 917,504, while a small output budget leaves nearly the whole 1M to input. The free lane's runtime cap is ~348K, so a caller sees the upstream error above it.
- **Output Limits**: Set to the highest published output ceiling below the context window; a lazy `max == context` echo is discarded. A live boundary probe may confirm a served ceiling, but it does not rewrite a published spec unless the lane hard-caps there (DeepSeek V4.1 Flash's 393,216 is both the published and the probed boundary).
- **Modalities**: The host catalog carries `text` and `image` only. Upstream video/audio/PDF support (MiMo, GLM 5.3 Flash, Nemotron Super VL and Nano Omni) is documented but not declared, because the picker has no input type for it.
- **Thinking Ladders**: Only the depths published by the free or paid twin's datasheet are selectable; unlisted rungs stay explicitly locked off. A wire probe may accept an unlisted value, but the picker does not offer it.

## Upstream Routing Matrix

| Upstream | Models | Host | Wire Protocol | Auth |
| :--- | :---: | :--- | :--- | :--- |
| **OpenCode Zen** | 12 | `opencode.ai/inference` | `/inference/v1` (Chat; the Responses lane is wired for future ids) | `Bearer public` |
| **KiloCode Gateway** | 16 | `api.kilo.ai` | `/api/gateway/chat/completions` | Keyless |
| **Cline** | 1 | `api.cline.bot` | `/api/v1/chat/completions` | Per-user login (`/freeflow cline login`) |
| **OVHcloud AI Endpoints** | 8 | `oai.endpoints.kepler.ai.cloud.ovh.net` | `/v1/chat/completions` (responses path translated) | Keyless, anonymous |
## Stealth previews

Masked IDs such as Omen Alpha are tracked on the [Stealth Models Watchlist](/pages/stealth-models). Nothing there enters this table until it is live on a free list and answers a live probe.
