/* Live validation harness for pi-freeflow v1.6 work — read-only, no state mutation. */
import { startProxy } from "../src/proxy.ts";
import { probeRelay } from "../src/probe.ts";
import { loadRelayState } from "../src/relay-state.ts";
import { ONBOARDED_FLAG_FILE } from "../src/config.ts";
import { agent } from "../src/relay.ts";
import fs from "node:fs";

const results: string[] = [];
const ok = (m: string) => results.push(`  ✓ ${m}`);
const bad = (m: string) => results.push(`  ✗ ${m}`);

// 1. Onboarding flag state
if (fs.existsSync(ONBOARDED_FLAG_FILE)) {
	ok(`onboarding flag exists (${ONBOARDED_FLAG_FILE}) — no re-fire`);
} else {
	ok("onboarding flag absent — will fire once on next session start (expected on this long-running install)");
}

// 2. Live proxy: /v1/models + /health
const { server, port } = await startProxy(29201);
try {
	const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
	const modelsJson = await models.json() as { data?: unknown[] };
	ok(`proxy /v1/models → HTTP ${models.status}, ${modelsJson.data?.length ?? "?"} models`);

	const health = await fetch(`http://127.0.0.1:${port}/health`);
	const healthJson = await health.json() as { status?: string };
	ok(`proxy /health → HTTP ${health.status}, status=${healthJson.status ?? "?"}`);
} catch (e) {
	bad(`proxy live check failed: ${(e as Error).message}`);
} finally {
	await new Promise<void>((r) => server.close(() => r()));
}

// 3. probeRelay against the user's real relay pool (one GET per relay, read-only)
const state = loadRelayState();
ok(`relay pool: ${state.relays.length} relay(s), mode=${state.mode}, enabled=${state.enabled}`);
for (const relay of state.relays) {
	const probe = await probeRelay(relay.url);
	if (probe.ok) {
		ok(`probe ${relay.label || "?"} → HTTP ${probe.status} in ${probe.latencyMs}ms`);
	} else {
		bad(`probe ${relay.label || "?"} → failed: ${probe.error || `HTTP ${probe.status}`}`);
	}
}

	console.log(results.join("\n"));
	const failures = results.filter((r) => r.startsWith("  ✗")).length;
	console.log(failures === 0 ? `\nALL LIVE CHECKS PASS (${results.length})` : `\n${failures} FAILURES`);
	// Close the keep-alive agent so libuv has no live handles at exit (Windows).
	await agent.close();
	process.exit(failures === 0 ? 0 : 1);
