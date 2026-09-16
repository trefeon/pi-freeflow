---
"pi-freeflow": patch
---

Local proxy recovers on its own: if the background proxy stops unexpectedly, the extension now notices the refused local connection and starts a fresh proxy within seconds instead of leaving every model failing until the next session; shutdowns and crashes are also recorded in the log so the cause is visible.
