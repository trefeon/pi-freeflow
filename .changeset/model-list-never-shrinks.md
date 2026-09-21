---
"pi-freeflow": patch
---

Model selection can no longer lose models the extension ships with. When the saved copy of the live catalog was newer than the built-in list and the live refresh could not run, the provider used to be re-registered from that saved copy alone, so a model added in a later update could drop out of model selection until the app was restarted. The saved copy is now always overlaid on the built-in list, so no update can lose models that way.
