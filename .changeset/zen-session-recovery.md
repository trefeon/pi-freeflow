---
"pi-freeflow": patch
---

A Zen conversation whose session was rejected now recovers on the next request instead of replaying the same refused session until restart. A confirmed free-tier gate refusal retires the affected session; caller-supplied session ids are left untouched.
