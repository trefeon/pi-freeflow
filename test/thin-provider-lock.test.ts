/**
 * Lock test for thin-provider refactor — follows parent proxy pattern (no upstream network).
 * Uses local startProxy cache only, so sub-agents never hit opencode.ai directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "../src/proxy.ts";
import { getAliveCatalog } from "../src/catalog.ts";
import { isRetriableStatus, relayFetch } from "../src/relay.ts";
import { resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { ALL_MODELS } from "../src/models.ts";

test("thin-provider lock: 28 models catalog intact", () => {
	const alive = getAliveCatalog();
	assert.equal(alive.length, 28, "catalog must be 28 (8 opencode + 20 kilo)");
	assert.equal(new Set(alive.map((m) => m.id)).size, 28);
	assert.equal(ALL_MODELS.length, 28);
});

test("thin-provider lock: isRetriableStatus regression lock (429 rolls, 400/500 do not)", () => {
	// Canonical boundary coverage lives in error-matrix [1/10]; this is a
	// minimal regression lock for the pool-retry contract.
	assert.equal(isRetriableStatus(429), true, "429 must roll");
	assert.equal(isRetriableStatus(500), false, "500 deterministic upstream fault must not roll (pool-retry + cooldown poison)");
	assert.equal(isRetriableStatus(400), false, "400 bad request must not roll (was P0)");
});

test("thin-provider lock: proxy /v1/models pathname guard (no ?query leak)", async () => {
	const testPort = 19181;
	const { server, port } = await startProxy(testPort);
	const effectivePort = port ?? testPort;
	try {
		const res = await fetch(`http://127.0.0.1:${effectivePort}/v1/models`);
		assert.equal(res.status, 200);
		const json = (await res.json()) as { data: Array<{ id: string }> };
		assert.equal(json.data.length, 28);

		const qRes = await fetch(`http://127.0.0.1:${effectivePort}/v1/models?foo=bar`);
		assert.equal(qRes.status, 200, "query variant must be guarded to 200 with 28");
		const qJson = (await qRes.json()) as { data: Array<{ id: string }> };
		assert.equal(qJson.data.length, 28, "query variant must not leak paid models");
	} finally {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

/** Response-like stub with an inspectable cancel() on body. */
function stubResponse(status: number, cancelled: number[]): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers(),
		body: {
			cancel: async () => {
				cancelled.push(status);
			},
		},
	} as unknown as Response;
}

test("thin-provider lock: relayFetch cancels discarded body when overwriting lastResponse on roll", async (t) => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay1.example.com",
		relays: [{ url: "https://relay1.example.com" }, { url: "https://relay2.example.com" }],
	};
	setActiveRelayState(state, false);
	resetAllRelayHealth();

	const cancelled: number[] = [];
	let call = 0;
	const fetchMock = t.mock.method(globalThis, "fetch", async () => {
		call++;
		if (call <= 2) return stubResponse(503, cancelled); // both relays roll
		throw new Error("direct fallback down"); // force lastResponse return
	});

	const out = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "rollcancel");

	assert.equal(fetchMock.mock.callCount(), 3, "two relay attempts + one direct fallback");
	assert.deepEqual(cancelled, [503], "first rolled response body must be freed; final held response stays live");
	assert.equal(out.status, 503);
});

test("thin-provider lock: relayFetch cancels body dropped by the 504 fast-fallback break", async (t) => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay1.example.com",
		relays: [{ url: "https://relay1.example.com" }, { url: "https://relay2.example.com" }],
	};
	setActiveRelayState(state, false);
	resetAllRelayHealth();

	const cancelled: number[] = [];
	let call = 0;
	const fetchMock = t.mock.method(globalThis, "fetch", async () => {
		call++;
		if (call === 1) return stubResponse(504, cancelled); // relay hits Vercel gateway timeout
		return stubResponse(200, cancelled); // direct upstream succeeds
	});

	const out = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "breakcancel");

	assert.equal(fetchMock.mock.callCount(), 2, "one relay attempt + direct fallback");
	assert.deepEqual(cancelled, [504], "dropped 504 response body must be freed before break");
	assert.equal(out.status, 200);
});
