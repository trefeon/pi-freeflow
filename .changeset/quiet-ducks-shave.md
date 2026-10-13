---
"pi-freeflow": minor
---

Nine more free models, from OVHcloud's AI Endpoints — and no account needed

The picker now offers nine open-weight models served by OVHcloud AI Endpoints, bringing the catalog to 36: GPT-OSS 120B and 20B, four Qwen models (3.5 397B, 3.5 9B, 3.6 27B, 3.8 27B), Mistral Small 3.2 and Mistral 7B, and Meta Llama 3.3 70B. The four Qwens and Mistral Small 3.2 also read images.

Access is anonymous and keyless. There is nothing to sign up for and no key to paste — no login step, no saved credential, no setup of any kind. Pick a model and it works.

The honest caveat: OVH rate-limits anonymous callers per IP address. A burst of parallel subagents can run into `API rate limit exceeded`, the same way a shared OpenCode or Kilo quota does. Wait it out or spread the work across models. Requests to these models always go straight to OVH from your machine, never through your relay pool — there is no per-IP gate for a relay to route around.

Thinking depth is limited to the two levels OVH confirms, `low` and `high`, on the six models that reason. The output budgets are deliberately conservative: they are the smallest cap any provider offers for the same underlying model, so a turn never asks for more than OVH will give.
