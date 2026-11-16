/**
 * One client per process, however many copies of the extension a host loads.
 *
 * A long-lived host (a web server running many sessions) loads the extension
 * once per session with a fresh module cache. Each copy used to run its own
 * lease, heartbeat, watchdog and recovery, so a single daemon blip turned
 * into dozens of racing respawns. These tests load two copies of the client
 * module side by side and check they behave as one client.
 */
// MUST be literal first import: disables detached-daemon spawn and pins the
// sandbox proxy port before src/config.ts is evaluated.
import { TEST_PROXY_PORT, harnessFetchHandler } from "./user-flow-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { PKG_VERSION } from "../src/config.ts";
import { triggerRecovery, _resetRecoveryForTest, type RecoveryDeps } from "../src/client-recovery.ts";
import type { DaemonHealthSnapshot } from "../src/health.ts";
import defaultExtension from "../src/index.ts";
import { _resetClientForTest } from "../src/client.ts";
import type { ExtensionAPI } from "../src/types.ts";

type ClientModule = typeof import("../src/client.ts");

const clientUrl = new URL("../src/client.ts", import.meta.url).href;

/** A separate module instance of src/client.ts, as a fresh-cache host loads it. */
async function loadClientCopy(tag: string): Promise<ClientModule> {
	return (await import(`${clientUrl}?copy=${tag}`)) as ClientModule;
}

type ControlCall = { endpoint: string; id: string };

/** Fetch stub for a healthy daemon on the sandbox port that records lease calls. */
function daemonFetch(calls: ControlCall[]): typeof fetch {
	const base = `http://127.0.0.1:${TEST_PROXY_PORT}`;
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const json = (body: unknown): Response =>
			new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		if (!url.startsWith(base)) throw new Error("mocked offline");
		const endpoint = url.slice(base.length);
		if (endpoint === "/health") return json({ ok: true, service: "pi-freeflow", port: TEST_PROXY_PORT });
		if (endpoint === "/_health") return json({ port: TEST_PROXY_PORT, version: PKG_VERSION, activeRequests: 0 });
		if (endpoint.startsWith("/_client/")) {
			const body: unknown = JSON.parse(String(init?.body ?? "{}"));
			const id = typeof body === "object" && body !== null ? (body as Record<string, unknown>).id : undefined;
			calls.push({ endpoint, id: typeof id === "string" ? id : "" });
			return json({ ok: true });
		}
		throw new Error("mocked offline");
	}) as typeof fetch;
}

/** Let fire-and-forget control calls settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

test("two loaded copies of the client register one lease with the daemon", async (t) => {
	const calls: ControlCall[] = [];
	t.mock.method(globalThis, "fetch", daemonFetch(calls));
	const a = await loadClientCopy("lease-a");
	const b = await loadClientCopy("lease-b");
	a._resetClientForTest();
	t.after(() => a._resetClientForTest());

	const portA = await a.ensureDaemon();
	const portB = await b.ensureDaemon();

	assert.equal(portA, TEST_PROXY_PORT);
	assert.equal(portB, TEST_PROXY_PORT);
	assert.equal(b.getClientPort(), TEST_PROXY_PORT);
	const attachIds = new Set(calls.filter((c) => c.endpoint === "/_client/attach").map((c) => c.id));
	assert.equal(attachIds.size, 1, "both copies must attach under the same lease id");
});

test("a closing session keeps the shared lease while another copy still serves one", async (t) => {
	const calls: ControlCall[] = [];
	t.mock.method(globalThis, "fetch", daemonFetch(calls));
	const a = await loadClientCopy("hold-a");
	const b = await loadClientCopy("hold-b");
	a._resetClientForTest();
	t.after(() => a._resetClientForTest());

	const holderA = {};
	const holderB = {};
	a.retainClient(holderA);
	b.retainClient(holderB);
	await a.ensureDaemon();

	assert.equal(await a.releaseClient(holderA), false, "another session still holds the client");
	await settle();
	assert.equal(calls.filter((c) => c.endpoint === "/_client/detach").length, 0);

	assert.equal(await b.releaseClient(holderB), true, "the last session stops the shared client");
	await settle();
	assert.equal(calls.filter((c) => c.endpoint === "/_client/detach").length, 1);
});

test("loading the extension for many sessions installs one pair of exit hooks per process", async (t) => {
	const base = harnessFetchHandler();
	t.mock.method(globalThis, "fetch", (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/_client/")) {
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return base(input, init);
	}) as typeof fetch);
	_resetClientForTest();
	t.after(() => _resetClientForTest());
	const mockPi: ExtensionAPI = {
		registerProvider() { },
		registerCommand() { },
		on() { },
	};
	const before = { beforeExit: process.listenerCount("beforeExit"), exit: process.listenerCount("exit") };

	for (let i = 0; i < 4; i++) await defaultExtension(mockPi);

	assert.ok(process.listenerCount("beforeExit") - before.beforeExit <= 1, "one beforeExit hook per process, not per loaded copy");
	assert.ok(process.listenerCount("exit") - before.exit <= 1, "one exit hook per process, not per loaded copy");
});

type RecoverySpy = { kills: string[]; attaches: number[]; ensures: number };

function recoveryDeps(health: () => Promise<DaemonHealthSnapshot>, spy: RecoverySpy): RecoveryDeps {
	let ensuring = false;
	return {
		isEnsuring: () => ensuring,
		setEnsuring: (v) => {
			ensuring = v;
		},
		ensureInProcessFallback: async () => TEST_PROXY_PORT,
		stopHeartbeatInternal: () => { },
		resetHeartbeatPort: () => { },
		attachTo: async (port) => {
			spy.attaches.push(port);
		},
		killStaleDaemon: async (_port, ver) => {
			spy.kills.push(ver);
			return true;
		},
		ensureDaemon: async () => {
			spy.ensures += 1;
			return TEST_PROXY_PORT;
		},
		getDaemonHealth: () => health(),
	};
}

test("watchdog recovery attaches to a daemon that came back healthy during the backoff", async (t) => {
	_resetRecoveryForTest();
	t.after(() => _resetRecoveryForTest());
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const spy: RecoverySpy = { kills: [], attaches: [], ensures: 0 };
	const deps = recoveryDeps(async () => ({ version: PKG_VERSION, activeRequests: 0, sseDegraded: false }), spy);

	const run = triggerRecovery(TEST_PROXY_PORT, "daemon gone", deps);
	t.mock.timers.tick(120_000);
	await run;

	assert.deepEqual(spy.kills, [], "a healthy same-version daemon must not be shut down");
	assert.equal(spy.ensures, 0);
	assert.deepEqual(spy.attaches, [TEST_PROXY_PORT]);
});

test("watchdog recovery still replaces a daemon that is older after the backoff", async (t) => {
	_resetRecoveryForTest();
	t.after(() => _resetRecoveryForTest());
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const spy: RecoverySpy = { kills: [], attaches: [], ensures: 0 };
	const deps = recoveryDeps(async () => ({ version: "0.0.1", activeRequests: 0, sseDegraded: false }), spy);

	const run = triggerRecovery(TEST_PROXY_PORT, "stale v0.0.1", deps);
	t.mock.timers.tick(120_000);
	await run;

	assert.deepEqual(spy.kills, ["0.0.1"]);
	assert.equal(spy.ensures, 1);
});
