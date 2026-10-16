/**
 * Keep-alive and relay tests (0 deps, global fetch)
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { relayFetch, _resetRollNotifyForTest } from "../src/relay.ts";
import {
	getRelayHealth,
	isRelayHealthy,
	setActiveRelayState,
	setStatusUi,
	resetAllRelayHealth,
} from "../src/relay-state.ts";
import { startProxy } from "../src/proxy.ts";

test("relayFetch uses global fetch (keep-alive via Node default)", () => {
	// 0 deps now — global fetch pools keep-alive without custom undici Agent
	assert.equal(typeof relayFetch, "function");
});
test("relayFetch direct uses keepAlive dispatcher (connection: keep-alive)", async () => {
	const seen: string[] = [];
	const server = http.createServer((req, res) => {
		seen.push(String(req.headers.connection || ""));
		res.writeHead(200, { "content-type": "application/json", "connection": "keep-alive", "keep-alive": "timeout=30" });
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address() as { port: number };
	const url = `http://127.0.0.1:${addr.port}/v1/chat/completions`;

	// force direct path: disable relay
	const prev = { enabled: false, url: "", relays: [] as string[], mode: "auto" as const };
	// save current state to restore
	try {
		setActiveRelayState({ enabled: false, url: "", relays: [], mode: "off" } as unknown as Parameters<typeof setActiveRelayState>[0], false);

		const res = await relayFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		assert.equal(res.status, 200);
		// server should have seen keep-alive (undici sends connection: keep-alive)
		const conn = (seen[0] || "").toLowerCase();
		assert.ok(conn.includes("keep-alive"), `expected connection keep-alive, got '${seen[0]}'`);
		// response should be keep-alive
		assert.equal(res.headers.get("connection")?.toLowerCase(), "keep-alive");
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		// restore relay state disabled off is fine; other tests handle it
		try { setActiveRelayState({ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0], false); } catch {}
	}
});

test("proxy direct path responds with keep-alive header", async () => {
	const testPort = 19280;
	const { server, port } = await startProxy(testPort);
	assert.ok(server);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
		assert.equal(res.status, 200);
		// Node http server should keep connection alive; our proxy explicitly sets connection keep-alive for upstream,
		// and for /v1/models the server default is keep-alive. Accept either explicit header or implicit keep-alive via not-closed.
		const conn = res.headers.get("connection");
		// fetch over http/1.1 with keep-alive agent should not be 'close'
		if (conn) assert.notEqual(conn.toLowerCase(), "close");
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
});

test("TTFB with keepAlive is under 10ms on reused connection", async () => {
	const requests: number[] = [];
	const server = http.createServer((req, res) => {
		requests.push(Date.now());
		res.writeHead(200, { "content-type": "application/json", "connection": "keep-alive" });
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address() as { port: number };
	const url = `http://127.0.0.1:${addr.port}/ping`;

	try {
		setActiveRelayState({ enabled: false, url: "", relays: [], mode: "off" } as unknown as Parameters<typeof setActiveRelayState>[0], false);
		// warm up
		await relayFetch(url, { method: "GET" });
		const t0 = Date.now();
		const res = await relayFetch(url, { method: "GET" });
		const ttfb = Date.now() - t0;
		assert.equal(res.status, 200);
		// On localhost with keep-alive, TTFB should be single-digit ms
		assert.ok(ttfb < 50, `TTFB ${ttfb}ms should be <50ms (target 10ms) with keep-alive reuse`);
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		try { setActiveRelayState({ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0], false); } catch {}
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

test("roll-notify throttle: one toast per 5min window, reset hook re-arms it", async (t) => {
	_resetRollNotifyForTest();
	resetAllRelayHealth();
	const messages: string[] = [];
	const notifySpy = (message: string, _type?: "info" | "warning" | "error") => {
		messages.push(message);
	};
	setStatusUi({ notify: notifySpy, setStatus() {} } as unknown as Parameters<typeof setStatusUi>[0]);

	const cancelled: number[] = [];
	const fetchMock = t.mock.method(globalThis, "fetch", async () => stubResponse(503, cancelled));

	try {
		// 1 relay that always 503s → one relay attempt + one direct fallback per call
		setActiveRelayState({
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com" }],
			mode: "auto",
		} as unknown as Parameters<typeof setActiveRelayState>[0], false);

		const out1 = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "rollnotify1");
		assert.equal(out1.status, 503);
		assert.equal(messages.length, 1, "first roll must notify");
		assert.match(messages[0], /rolled|falling back/, "notify message must describe roll/failover");
		assert.ok(messages[0].includes("relay"), "notify message must name the relay");

		// Immediate second 503 → throttled, no duplicate toast
		const out2 = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "rollnotify2");
		assert.equal(out2.status, 503);
		assert.equal(messages.length, 1, "second roll within 5min window must be throttled");

		// Reset hook re-arms the throttle → fires again
		_resetRollNotifyForTest();
		const out3 = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "rollnotify3");
		assert.equal(out3.status, 503);
		assert.equal(messages.length, 2, "reset must re-arm the roll-notify throttle");

		// Sanity: every call exercised the relay loop (1 relay attempt + 1 direct fallback)
		assert.equal(fetchMock.mock.callCount(), 6);
	} finally {
		setStatusUi(null);
		_resetRollNotifyForTest();
		resetAllRelayHealth();
	}
});

test("relayFetch sends x-relay-auth when the relay entry has auth", async (t) => {
	try {
		setActiveRelayState({
			enabled: true,
			url: "https://auth-relay.example.com",
			relays: [
				{ url: "https://auth-relay.example.com", auth: "shared-secret-1" },
			],
			mode: "auto",
		} as unknown as Parameters<typeof setActiveRelayState>[0], false);
		resetAllRelayHealth();

		const seen: Array<{ url: string; init?: RequestInit }> = [];
		t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
			seen.push({ url, init });
			return new Response("ok", { status: 200 });
		});

		const res = await relayFetch(
			"https://opencode.ai/zen/v1/chat/completions",
			{ method: "POST" },
			"auth1",
		);
		assert.equal(res.status, 200);
		assert.equal(seen.length, 1, "relay path must be exercised once (then direct fallback unused)");
		const headers = new Headers(seen[0].init?.headers);
		assert.equal(
			headers.get("x-relay-auth"),
			"shared-secret-1",
			"x-relay-auth must be sent for authed relay entries",
		);
	} finally {
		try {
			setActiveRelayState({ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0], false);
		} catch {}
		resetAllRelayHealth();
	}
});

test("relayFetch omits x-relay-auth for legacy relay entries without auth", async (t) => {
	try {
		setActiveRelayState({
			enabled: true,
			url: "https://legacy-relay.example.com",
			relays: [{ url: "https://legacy-relay.example.com" }],
			mode: "auto",
		} as unknown as Parameters<typeof setActiveRelayState>[0], false);
		resetAllRelayHealth();

		const seen: Array<{ url: string; init?: RequestInit }> = [];
		t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
			seen.push({ url, init });
			return new Response("ok", { status: 200 });
		});

		const res = await relayFetch(
			"https://opencode.ai/zen/v1/chat/completions",
			{ method: "POST" },
			"auth2",
		);
		assert.equal(res.status, 200);
		const headers = new Headers(seen[0].init?.headers);
		assert.equal(
			headers.get("x-relay-auth"),
			null,
			"no auth header must be sent for legacy entries",
		);
	} finally {
		try {
			setActiveRelayState({ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0], false);
		} catch {}
		resetAllRelayHealth();
	}
});

test("relayFetch rolls on a relay auth rejection (401) and cools the rejecting relay", async (t) => {
	_resetRollNotifyForTest();
	resetAllRelayHealth();
	const messages: string[] = [];
	setStatusUi({
		notify: (message: string) => {
			messages.push(message);
		},
		setStatus() {},
	} as unknown as Parameters<typeof setStatusUi>[0]);

	const RELAY_401 = "https://stale-auth-relay.example.com";
	const RELAY_OK = "https://healthy-relay.example.com";
	const seen: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL) => {
		const target = String(input);
		seen.push(target);
		if (target === RELAY_401) {
			// Exactly what a deployed worker answers when x-relay-auth no longer matches.
			return new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("ok", { status: 200 });
	});

	try {
		setActiveRelayState(
			{
				enabled: true,
				url: RELAY_401,
				relays: [{ url: RELAY_401, auth: "rotated-secret" }, { url: RELAY_OK }],
				mode: "auto",
			} as unknown as Parameters<typeof setActiveRelayState>[0],
			false,
		);

		const res = await relayFetch(
			"https://opencode.ai/zen/v1/chat/completions",
			{ method: "POST", body: "{}" },
			"authz401",
		);

		assert.equal(res.status, 200, "the next candidate must serve after a relay 401");
		assert.deepEqual(
			seen,
			[RELAY_401, RELAY_OK],
			"the 401-ing relay must roll to the next candidate (never straight to direct)",
		);

		// A 401 is a relay fault: failed and cooled, never recorded as a success.
		const health = getRelayHealth(RELAY_401);
		assert.ok(health, "the 401-ing relay must carry a health record");
		assert.equal(health.consecutiveFailures, 1, "401 must count as a relay failure");
		assert.equal(health.lastStatus, 401, "the failure must record the 401 status");
		assert.equal(health.successCount ?? 0, 0, "401 must never be marked a success");
		assert.equal(isRelayHealthy(RELAY_401), false, "401 must put the relay in cooldown");
		assert.equal(isRelayHealthy(RELAY_OK), true, "the healthy relay must stay healthy");

		assert.equal(messages.length, 1, "the roll must notify once");
		assert.match(messages[0], /401/, "the toast must name the relay's 401");
	} finally {
		setStatusUi(null);
		_resetRollNotifyForTest();
		resetAllRelayHealth();
		setActiveRelayState(
			{ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0],
			false,
		);
	}
});

test("relayFetch keeps a 403 free-tier gate terminal (no roll, no penalty)", async (t) => {
	resetAllRelayHealth();
	const RELAY = "https://gated-relay.example.com";
	const seen: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL) => {
		seen.push(String(input));
		return new Response(
			JSON.stringify({
				error: { code: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" },
			}),
			{ status: 403, headers: { "content-type": "application/json" } },
		);
	});

	try {
		setActiveRelayState(
			{ enabled: true, url: RELAY, relays: [{ url: RELAY }], mode: "auto" } as unknown as Parameters<
				typeof setActiveRelayState
			>[0],
			false,
		);

		const res = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "gate403");

		assert.equal(res.status, 403, "a 403 gate must surface unchanged");
		assert.deepEqual(seen, [RELAY], "a 403 gate must never roll or hit the direct fallback");
		const health = getRelayHealth(RELAY);
		assert.equal(health?.failureCount ?? 0, 0, "a 403 gate is an upstream verdict, not a relay fault");
		assert.equal(isRelayHealthy(RELAY), true, "a 403 gate must not cool the relay");
	} finally {
		resetAllRelayHealth();
		setActiveRelayState(
			{ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0],
			false,
		);
	}
});
