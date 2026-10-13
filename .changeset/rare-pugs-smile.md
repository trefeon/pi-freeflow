---
"pi-freeflow": minor
---

A new free model on the OpenCode Zen lane: Cat Jam

`cat-jam-free` joins the picker, bringing the catalog to 37 models (11 OpenCode, 15 Kilo, 2 Cline, 9 OVHcloud). No account, no key, no setup — it is keyless like every other Zen free model.

It thinks, and it has a 262,144-token window. That number was measured the hard way: the gateway happily accepts prompts four times that size and answers normally, but the model can no longer read them. A marker planted at the end of a 248,232-token prompt comes back; at 250,272 tokens it does not. So the advertised window is what the model can actually use, not merely what the service tolerates.

Two honest limits worth knowing before you pick it:

- **It is not available on the Responses API.** Requests sent that way are refused with a protocol error. It works on chat completions, which is what hosts use by default, but a host pinned specifically to Responses will not see it.
- **Thinking depth starts at "low".** The lowest setting is refused, so "minimal" is not offered; low, medium, high and extra-high all work.

The output budget is 131,072, the published figure for this model.
