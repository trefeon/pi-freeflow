---
"pi-freeflow": patch
---

Fix tool calls breaking down on free models.

When a request carries a full set of agent tools, free models often return
tool arguments that do not match the tool's declared shape. A planning tool
asked for phased tasks could come back with the phases buried inside a
JSON-encoded list under the wrong field, wrapped in an extra object, or under
names the tool never declared — so the host rendered each phase as one long raw
JSON string instead of real task lines.

The proxy now checks returned arguments against the tool schema the caller
declared and repairs them when the intended shape is unambiguous, across all
three API shapes, streamed and non-streamed, and for every supported model
provider. Well-formed calls, calls for tools without structured parameters, and
arguments that were cut off mid-stream all pass through untouched.