---
"pi-freeflow": patch
---

A relay that the upstream free-tier gate rejects can no longer wedge the pool: when a relay forwards back a 403 the relay itself is marked failed and the request rolls to the next candidate (or the direct route), instead of that 403 being recorded as a healthy verdict and pinning the relay as the pool's primary. The machine-wide upstream gate now only trips when the direct route is refused too, so one incompatible relay cannot fail everyone over.

Deploying a relay now proves inference through it, not just that its models list answers: the completion message verifies a real free-tier request and, when that fails, says so plainly — including the known Deno Deploy case (its platform rewrites the outbound User-Agent, so OpenCode Zen rejects traffic from it while Kilo still works). Deno Deploy deployments also resolve their public URL from the current API response again, so the deploy flow ends with a usable relay address instead of a "could not determine the public URL" error.
