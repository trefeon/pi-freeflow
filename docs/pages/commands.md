# Commands & Troubleshooting

## Interactive CLI Commands

All commands are available inside the OMP or Pi TUI via `/freeflow`:

| Command | Action |
| :--- | :--- |
| `/freeflow status` | View active relay URL, pool status (ON/OFF), and candidates |
| `/freeflow list` | List all relays with health badges (✓ / ⚠️ cooling) |
| `/freeflow use <url|index|label>` | Switch active relay |
| `/freeflow url <url>` | Set the active relay URL directly |
| `/freeflow add <url> [label]` | Add a new relay to the pool |
| `/freeflow label <index|url> <name>` | Assign a friendly label to a relay |
| `/freeflow remove <index|url|label>` | Remove a relay from the pool |
| `/freeflow test <index|url|label>` | Probe a relay for reachability (HTTP 200 + latency) |
| `/freeflow on | off | auto` | Toggle relay mode (auto = enabled for freeflow) |
| `/freeflow deploy <platform>` | Guided relay deploy (vercel, cloudflare, deno) |
| `/freeflow logs [lines]` | Inspect recent proxy logs |
| `/freeflow trace [req-id]` | Tail logs filtered by request correlation ID |
| `/freeflow refresh` | Force reload models from live upstream APIs |
| `/freeflow update` | Check for and install a package update |
| `/freeflow debug on | off` | Toggle full HTTP lifecycle debug logging |

## Logging

Logs are written to `~/.pi/agent/pi-freeflow.log` with auto-rotation at 10MB (10 files). Each entry includes a request correlation ID for end-to-end tracing.

## Troubleshooting

| Problem | Root Cause | Solution |
| :--- | :--- | :--- |
| **Port conflict on 28180** | Another app bound to the port | Set `FREEFLOW_PORT=29000` or terminate the conflicting process |
| **Subagents fail to connect** | Local proxy daemon terminated prematurely | Restart OMP session — subagents re-probe and reuse the daemon |
| **Vercel relay 504 timeout** | Prompt evaluation exceeded 25s limit | Auto-fallback to direct upstream triggered |
| **Model list not updating** | 24-hour disk cache TTL active | Run `/freeflow refresh` or delete the cache file |
| **Relay 404 / broken URL** | Old or deleted edge deployment | Run `/freeflow remove <url>` to clean up |
| **OpenCode 429 FreeUsageLimitError** | Daily OpenCode quota exhausted | Wait for UTC reset or route through an egress relay |
