---
"pi-freeflow": patch
---

Requests now roll over to the next relay when the current one answers with a disabled-deployment verdict, instead of failing on the first relay and requiring a manual switch. Other payment and quota refusals still surface immediately.
