# Commands & Troubleshooting

## Interactive CLI Commands

All commands are available inside the OMP or Pi TUI via `/pi-freeflow`:

| Command | Action |
| :--- | :--- |
| `/pi-freeflow status` | View active relay URL, pool status (ON/OFF), and candidates |
| `/pi-freeflow list` | List all relays with health badges (✓ / ⚠️ cooling) |
| `/pi-freeflow use <url|index|label>` | Switch active relay |
| `/pi-freeflow add <url> [label]` | Add a new relay to the pool |
| `/pi-freeflow label <index|url> <name>` | Assign a friendly label to a relay |
| `/pi-freeflow remove <index|url|label>` | Remove a relay from the pool |
| `/pi-freeflow on | off | auto` | Toggle relay mode (auto = enabled for pi-freeflow) |
| `/pi-freeflow deploy <platform>` | Guided relay deploy (vercel, cloudflare, deno) |
| `/pi-freeflow logs [lines]` | Inspect recent proxy logs |
| `/pi-freeflow debug on | off` | Toggle full HTTP lifecycle debug logging |
| `/pi-freeflow refresh` | Force reload models from live upstream APIs |

## Logging

Logs are written to `~/.pi/agent/pi-freeflow.log` with auto-rotation at 5MB (3 backups). Each entry includes a request correlation ID for end-to-end tracing.

## Troubleshooting

| Problem | Root Cause | Solution |
| :--- | :--- | :--- |
| **Port conflict on 28180** | Another app bound to the port | Set `FREEFLOW_PORT=29000` or terminate the conflicting process |
| **Subagents fail to connect** | Local proxy daemon terminated prematurely | Restart OMP session — subagents re-probe and reuse the daemon |
| **Vercel relay 504 timeout** | Prompt evaluation exceeded 25s limit | Auto-fallback to direct upstream triggered |
| **Model list not updating** | 1-hour disk cache TTL active | Run `/pi-freeflow refresh` or delete the cache file |
| **Relay 404 / broken URL** | Old or deleted edge deployment | Run `/pi-freeflow remove <url>` to clean up |
| **OpenCode 429 FreeUsageLimitError** | Daily OpenCode quota exhausted | Wait for UTC reset or route through an egress relay |
