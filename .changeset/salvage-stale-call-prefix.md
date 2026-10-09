---
"pi-freeflow": patch
---

Recover tool calls that arrive with the tail of the previous call stuck to the
front. Some models open a new call by echoing the end of the one they have just
seen, so a single call is delivered as `<tail of previous>{"…this call…"}` and
the host refuses it as invalid JSON. When such a payload does not parse, the
proxy now locates the complete call behind the stray text and hands that back.

Only payloads that already fail to parse are rescanned, and only a position that
yields a complete object is accepted — a well-formed call is never rewritten,
and a truncated one is still refused rather than completed.

Also adds a whole-inventory fidelity test covering every tool either host can
declare, across all three API shapes.