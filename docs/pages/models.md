# Model Catalog & Upstream Routing

pi-freeflow provides unified access to **21 curated free models** across two upstream providers: **OpenCode Zen** and **KiloCode Gateway**.

## Upstream Protocol Distinction

### OpenCode Zen — Responses API (`/v1/responses`)
- **Endpoint**: `https://opencode.ai/zen/v1/responses`
- **Model**: `muse-spark-1.2-contributor-free` (1M context, 131K output, vision)
- **Config**: `api: "openai-responses"`, session affinity via OpenAI-nosession

### OpenCode Zen — Chat Completions (`/v1/chat/completions`)
- **Endpoint**: `https://opencode.ai/zen/v1/chat/completions`
- **Models**: 6 models (MiMo, Nemotron, Hy3, etc.)
- **Config**: `api: "openai-completions"`, supports reasoning effort

### KiloCode Gateway (`/v1/chat/completions`)
- **Endpoint**: `https://api.kilo.ai/api/gateway/chat/completions`
- **Auth**: `Authorization: Bearer kilo-free` (keyless, 200 req/hr per IP)
- **Models**: 14 models with OpenRouter-style thinking format

## 21 Model Specifications

### OpenCode Zen (7 models)

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `muse-spark-1.2-contributor-free` | 1,048,576 | 131,072 | minimal..xhigh | ✅ |
| `mimo-v2.5-free` | 1,048,576 | 131,072 | minimal..xhigh (3 values)* | ✅ |
| `laguna-s-2.1-free` | 1,048,576 | 131,072 | minimal..xhigh | ❌ |
| `nemotron-3.5-lightning-free` | 1,000,000 | 262,144 | minimal..xhigh | ❌ |
| `nemotron-3-ultra-free` | 1,000,000 | 128,000 | minimal..xhigh | ❌ |
| `hy3-free` | 262,144 | 262,144 | minimal..xhigh | ❌ |
| `big-pickle` | 200,000 | 32,000 | high, max | ❌ |

### KiloCode Gateway (14 models)

| Model ID | Context | Max Output | Thinking | Vision |
| :--- | ---: | ---: | :--- | :--- |
| `dots-3-note-preview` | 512,000 | 512,000 | OpenRouter | ✅ |
| `step-3.7-flash` | 262,144 | 262,144 | OpenRouter | ✅ |
| `nemotron-3-nano-omni` | 256,000 | 65,536 | OpenRouter | ✅ |
| `nemotron-3-ultra-550b` | 1,000,000 | 65,536 | OpenRouter | ❌ |
| `nemotron-3.5-lightning (Kilo)` | 1,000,000 | 262,144 | OpenRouter | ❌ |
| `nemotron-3-super` | 262,144 | 262,144 | OpenRouter | ❌ |
| `hy3 (Kilo)` | 262,144 | 262,144 | OpenRouter | ❌ |
| `north-mini-code` | 256,000 | 64,000 | OpenRouter | ❌ |
| `laguna-s-2.1 (Kilo)` | 1,048,576 | 131,072 | OpenRouter | ❌ |
| `laguna-xs-2.1` | 262,144 | 32,768 | OpenRouter | ❌ |
| `lfm-2.5` | 128,000 | 32,768 | OpenRouter | ❌ |
| `kilo-auto` | 256,000 | 10,000 | Standard | ❌ |
| `openrouter` | 200,000 | 65,536 | Standard | ❌ |
| `content-safety` | 128,000 | 8,192 | Standard | ❌ |

## Dual-Upstream Routing Matrix

| Upstream | Models | Host | Wire Protocol | Auth |
| :--- | :--- | :--- | :--- | :--- |
| **OpenCode Zen** | 7 | `opencode.ai` | `/zen/v1/responses` (1) + `/zen/v1/chat/completions` (6) | Browser fingerprinting |
| **KiloCode Gateway** | 14 | `api.kilo.ai` | `/api/gateway/chat/completions` | `Bearer kilo-free` |
