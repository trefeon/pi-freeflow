---
"pi-freeflow": patch
---

Long sessions no longer stall on a tool call whose arguments arrived spliced

Some models open their next tool call by echoing the tail of the one they had just seen, and occasionally stop before the closing brace. The result is a single argument string carrying both faults at once: the previous call's leftover text in front, and the last brace missing. The whole call was then rejected, the turn failed, and the host retried — which resent the same broken payload, so a long session could get stuck repeating it.

Both faults are now repaired together, so the caller's own arguments arrive intact.

The repair stays deliberately narrow. It only fires when a leftover fragment is actually present in front of the object, which is the evidence that the model was mid-call rather than that the request itself was malformed, and only when what follows is a complete object merely missing its closing brace. Arguments cut off part-way through a value are still refused untouched, because completing those would silently shorten them — and these arguments carry shell commands.

Tool calls that were already well-formed are unaffected and pass through byte-identically.
