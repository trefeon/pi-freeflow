---
"pi-freeflow": patch
---

Cline logins are used more sensibly, and the message you get when they are all out matches what actually happened.

A saved login that has used up its daily free allowance for a model is now skipped instead of being retried on every request, so a turn goes straight to a login that still has allowance for that model. A login that starts working again is picked back up on its own.

When every saved login is out for that model, the answer now says so: it names how many logins were tried, when the nearest reset is, and that switching models or adding another login (`/freeflow cline login`) is what helps — instead of implying that a single login was at fault.
