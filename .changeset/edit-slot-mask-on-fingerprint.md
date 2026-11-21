---
"pi-freeflow": patch
---

Keep DeepSeek's OpenCode Zen free lane usable from hosts that declare their own `edit` tool. The fingerprint lane now sends a caller-declared `edit` as `edit_file` with its original schema and refills the gate slot with the verbatim CLI `edit` declaration as a non-executable compat placeholder. Tool calls are restored to the host's `edit` name on the way back, so OMP's hashline default and its replace, patch, and sloppy `edit` shapes keep working with no host configuration change.
