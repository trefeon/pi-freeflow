# Model Catalog & Upstream Routing

pi-freeflow provides unified access to **36 curated free models** across four upstream providers: **OpenCode Zen**, **KiloCode Gateway**, **Cline**, and **OVHcloud AI Endpoints**.

## Upstream Protocol Distinction

### OpenCode Zen — Responses API (`/v1/responses`)
- **Endpoint**: `https://opencode.ai/zen/v1/responses`
- **Models**: `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free` (1M context, 131K output, vision)
- **Config**: `api: "openai-responses"`, session affinity via OpenAI-nosession

### OpenCode Zen — Chat Completions (`/v1/chat/completions`)
- **Endpoint**: `https://opencode.ai/zen/v1/chat/completions`
- **Models**: 8 models (Space Bunny, LongCat, MiMo, Nemotron, Big Pickle, Ling, etc.)
- **Config**: `api: "openai-completions"`, supports reasoning effort

### OpenCode Zen — Messages API (`/v1/messages`)
- **Endpoint**: `https://opencode.ai/zen/v1/messages`
- **Models**: none right now — the flavor is wired and supported, but no current free model serves it
- **Config**: `api: "anthropic-messages"`, no effort levels — the host sends a plain Anthropic body when a model declares this flavor

### KiloCode Gateway (`/v1/chat/completions`)
- **Endpoint**: `https://api.kilo.ai/api/gateway/chat/completions`
- **Auth**: keyless — no `Authorization` header at all (the gateway rejects a placeholder credential with `401 INVALID_TOKEN`; 200 req/hr per IP)
- **Models**: 16 models with OpenRouter-style thinking format

### Cline (`/api/v1/chat/completions`)
- **Endpoint**: `https://api.cline.bot/api/v1/chat/completions`
- **Auth**: per-user login via `/freeflow cline login` (browser approval, saved to a per-user pool on your machine)
- **Models**: 5 models from Cline's rotating free promo; requests roll across saved logins on the daily free limit
- **Routing**: direct only, never through the relay pool

### OVHcloud AI Endpoints (`/v1/chat/completions`)
- **Endpoint**: `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`
- **Auth**: keyless — no account and no `Authorization` header at all
- **Models**: 9 open-weight models (GPT-OSS, Qwen 3.5/3.6/3.8, Mistral, Llama)
- **Routing**: direct only, never through the relay pool
- **Config**: `api: "openai-completions"`. Chat is the only upstream shape: OVH's responses endpoint rejects every array `input` with `422 input: data did not match any variant of untagged enum ResponseInput` and accepts only a bare string, so a responses-path request is translated to chat upstream and the answer mapped back — the same shape mapping the Cline lane uses.

## 36 Model Specifications

### OpenCode Zen (10 models)

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `muse-spark-1.2-contributor-free` | 1,048,576 | 131,072 | minimal..xhigh | ✅ |
| `muse-spark-1.3-contributor-free` | 1,048,576 | 131,072 | minimal..xhigh | ✅ |
| `mimo-v2.6-flash-free` | 1,048,576 | 131,072 | minimal..xhigh (3 values)* | ✅ |
| `nemotron-3.5-lightning-free` | 1,000,000 | 262,144 | minimal..xhigh | ❌ |
| `nemotron-3-ultra-free` | 1,000,000 | 128,000 | minimal..xhigh | ❌ |
| `big-pickle` | 200,000 | 32,000 | high, max | ❌ |
| `space-bunny-free` | 1,048,576 | 524,288 | low..max | ✅ |
| `longcat-2.5-preview-free` | 1,000,000 | 131,072 | minimal..max | ✅ |
| `step-5-preview-free` | 1,000,000 | 65,536 | low..high | ✅ |
| `ling-3.1-flash-free` | 262,144 | 32,768 | minimal..max | ❌ |
### KiloCode Gateway (15 models)

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `dots-3-note-preview` | 512,000 | 512,000 | OpenRouter | ✅ |
| `nemotron-3-nano-omni` | 256,000 | 131,072 | OpenRouter | ✅ |
| `nemotron-3-ultra-550b` | 1,000,000 | 128,000 | OpenRouter | ❌ |
| `nemotron-3.5-lightning (Kilo)` | 1,000,000 | 262,144 | OpenRouter | ❌ |
| `nemotron-3-super` | 262,144 | 262,144 | OpenRouter | ❌ |
| `north-mini-code` | 256,000 | 64,000 | OpenRouter | ❌ |
| `laguna-s-2.1 (Kilo)` | 262,144 | 32,768 | OpenRouter | ❌ |
| `laguna-xs-2.1` | 262,144 | 32,768 | OpenRouter | ❌ |
| `lfm-2.5` | 65,536 | 32,768 | OpenRouter | ❌ |
| `kilo-auto` | 256,000 | 10,000 | OpenRouter (reasoning) | ❌ |
| `openrouter` | 200,000 | 65,536 | OpenRouter (reasoning) | ✅ |
| `inkling-small` | 1,048,576 | 262,144 | OpenRouter | ✅ |
| `glyph-cluster` | 256,000 | 256,000 | OpenRouter | ❌ |
| `step-5-preview:kilo` | 1,000,000 | 64,000 | OpenRouter | ✅ |
| `ling-3.1-flash-kilo` | 262,144 | 32,768 | OpenRouter | ❌ |

### Cline (2 models)

Cline free models come from a rotating per-account promo and need a browser login (`/freeflow cline login`; manage with `/freeflow cline accounts` and `/freeflow cline logout`). They run direct only, never through the relay pool.

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `cline-free/muse-spark-1.3-contributor` | 1,048,576 | 131,072 | `minimal`..`xhigh` | ✅ |
| `z-ai/glm-5.3-flash` | 1,000,000 | 131,072 | `low`, `high`, `max` | ✅ |

### OVHcloud AI Endpoints (9 models)

Anonymous access: no account, no key, no login step. Direct only, never through the relay pool — there is no per-IP gate for a relay to route around. OVH does rate-limit anonymous callers, so parallel subagents can hit `429 API rate limit exceeded` per IP. The `ovh-free/` prefix namespaces the lane in the picker; upstream only ever sees the part after the slash, which is case-sensitive.

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `ovh-free/gpt-oss-120b` | 131,072 | 32,768 | `low`, `high` | ❌ |
| `ovh-free/gpt-oss-20b` | 131,072 | 32,768 | `low`, `high` | ❌ |
| `ovh-free/Qwen3.5-397B-A17B` | 262,144 | 65,536 | `low`, `high` | ✅ |
| `ovh-free/Qwen3.5-9B` | 262,144 | 65,536 | `low`, `high` | ✅ |
| `ovh-free/Qwen3.6-27B` | 262,144 | 65,536 | `low`, `high` | ✅ |
| `ovh-free/Qwen3.8-27B` | 262,144 | 32,768 | `low`, `high` | ✅ |
| `ovh-free/Mistral-Small-3.2-24B-Instruct-2506` | 131,072 | 16,384 | ❌ | ✅ |
| `ovh-free/Mistral-7B-Instruct-v0.3` | 65,536 | 65,536 | ❌ | ❌ |
| `ovh-free/Meta-Llama-3_3-70B-Instruct` | 131,072 | 16,384 | ❌ | ❌ |

\* Max output is the conservative floor across every provider serving the same underlying model, not the ceiling: a request budget that is too small never breaks a turn, while one that is too large lets the host ask for an output the provider refuses. OVH itself only enforces `context − prompt`.

\* MiMo collapses `minimal→low` and `xhigh→high` upstream — 5 labels, 3 effective effort values (low/medium/high).

## Upstream Routing Matrix

| Upstream | Models | Host | Wire Protocol | Auth |
| **OpenCode Zen** | 10 | `opencode.ai/zen` | `/zen/v1` (Responses + Chat) | Keyless |
| **KiloCode Gateway** | 16 | `api.kilo.ai` | `/api/gateway/chat/completions` | Keyless |
| **Cline** | 2 | `api.cline.bot` | `/api/v1/chat/completions` | Per-user login (`/freeflow cline login`) |
| **OVHcloud AI Endpoints** | 9 | `oai.endpoints.kepler.ai.cloud.ovh.net` | `/v1/chat/completions` (responses path translated) | Keyless, anonymous |

## Stealth previews

Masked IDs such as Omen Alpha are tracked on the [Stealth Models Watchlist](/pages/stealth-models). Nothing there enters this table until it is live on a free list and answers a live probe.
