---
"pi-freeflow": patch
---

The status widget stays hidden after `/freeflow hide`. The preference was already saved in the relay state file; two paths could still bring the widget back and no longer do: deploy progress now respects the hidden state instead of writing a `deploying …` label, and importing a relay pool with `--replace` keeps this machine's widget choice instead of adopting the file's.
