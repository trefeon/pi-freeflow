/**
 * Keep-alive and relay tests (0 deps, global fetch)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { relayFetch, _resetRollNotifyForTest } from "../src/relay.ts";
import {
	getRelayHealth,
	isRelayHealthy,
	markRelayFailure,
	saveRelayState,
	setActiveRelayState,
	setStatusUi,
	resetAllRelayHealth,
} from "../src/relay-state.ts";
import { LOG_FILE, RELAY_STATE_FILE } from "../src/config.ts";
import { startProxy } from "../src/proxy.ts";
import { authHeaders } from "./_auth.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

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
		const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: authHeaders() });
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

test("keep-alive reuses the client connection for successive relayFetch calls", async () => {
	// Deterministic reuse proof: the server records the client's remote port per
	// request, so socket reuse is observable directly instead of via a wall-clock
	// threshold (the old TTFB<50ms assertion flaked on loaded CI).
	const ports: (number | undefined)[] = [];
	const server = http.createServer((req, res) => {
		ports.push(req.socket.remotePort);
		res.writeHead(200, { "content-type": "application/json", "connection": "keep-alive" });
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address() as { port: number };
	const url = `http://127.0.0.1:${addr.port}/ping`;

	try {
		setActiveRelayState({ enabled: false, url: "", relays: [], mode: "off" } as unknown as Parameters<typeof setActiveRelayState>[0], false);
		const first = await relayFetch(url, { method: "GET" });
		assert.equal(first.status, 200);
		// Drain the body: undici only returns the socket to the pool once the
		// response stream has ended, on a later macrotask.
		await first.text();
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));
		const second = await relayFetch(url, { method: "GET" });
		assert.equal(second.status, 200);
		await second.text();
		assert.equal(ports.length, 2, "expected exactly one server-side request per relayFetch call");
		assert.equal(ports[0], ports[1], `keep-alive must reuse the client socket (ports ${ports.join(" vs ")})`);
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

test("relayFetch rolls on a relay 403 (rejected egress fingerprint) and cools the relay", async (t) => {
	_resetRollNotifyForTest();
	resetAllRelayHealth();
	const messages: string[] = [];
	setStatusUi({
		notify: (message: string) => {
			messages.push(message);
		},
		setStatus() {},
	} as unknown as Parameters<typeof setStatusUi>[0]);

	const RELAY_403 = "https://gated-egress-relay.example.com";
	const RELAY_OK = "https://healthy-relay.example.com";
	const seen: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL) => {
		const target = String(input);
		seen.push(target);
		if (target === RELAY_403) {
			// Exactly what OpenCode Zen answers when the relay's egress
			// fingerprint is not the client's (stripped User-Agent etc.).
			return new Response(
				JSON.stringify({
					error: { code: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" },
				}),
				{ status: 403, headers: { "content-type": "application/json" } },
			);
		}
		return new Response("ok", { status: 200 });
	});

	try {
		setActiveRelayState(
			{
				enabled: true,
				url: RELAY_403,
				relays: [{ url: RELAY_403 }, { url: RELAY_OK }],
				mode: "auto",
			} as unknown as Parameters<typeof setActiveRelayState>[0],
			false,
		);

		const res = await relayFetch(
			"https://opencode.ai/zen/v1/chat/completions",
			{ method: "POST", body: "{}" },
			"gate403roll",
		);

		assert.equal(res.status, 200, "the next candidate must serve after a relay 403");
		assert.deepEqual(
			seen,
			[RELAY_403, RELAY_OK],
			"the 403-ing relay must roll to the next candidate (never straight to direct)",
		);

		// A relay-forwarded 403 is a relay-host fault: failed and cooled,
		// never recorded as a success.
		const health = getRelayHealth(RELAY_403);
		assert.ok(health, "the 403-ing relay must carry a health record");
		assert.equal(health.consecutiveFailures, 1, "403 must count as a relay failure");
		assert.equal(health.lastStatus, 403, "the failure must record the 403 status");
		assert.equal(health.successCount ?? 0, 0, "403 must never be marked a success");
		assert.equal(isRelayHealthy(RELAY_403), false, "403 must put the relay in cooldown");
		assert.equal(isRelayHealthy(RELAY_OK), true, "the healthy relay must stay healthy");

		assert.equal(messages.length, 1, "the roll must notify once");
		assert.match(messages[0], /403/, "the toast must name the relay's 403");
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

test("relayFetch falls back to direct when every relay answers 403", async (t) => {
	resetAllRelayHealth();
	const RELAY = "https://gated-egress-relay.example.com";
	const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
	const seen: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL) => {
		const target = String(input);
		seen.push(target);
		if (target === RELAY) {
			return new Response(
				JSON.stringify({
					error: { code: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" },
				}),
				{ status: 403, headers: { "content-type": "application/json" } },
			);
		}
		return new Response("ok", { status: 200 });
	});

	try {
		setActiveRelayState(
			{ enabled: true, url: RELAY, relays: [{ url: RELAY }], mode: "auto" } as unknown as Parameters<
				typeof setActiveRelayState
			>[0],
			false,
		);

		const res = await relayFetch(UPSTREAM, { method: "POST", body: "{}" }, "gate403direct");

		assert.equal(res.status, 200, "the direct fallback must serve after a relay 403");
		assert.deepEqual(seen, [RELAY, UPSTREAM], "the 403-ing relay must roll, then fall back to direct");
		const health = getRelayHealth(RELAY);
		assert.ok(health, "the 403-ing relay must carry a health record");
		assert.equal(health.consecutiveFailures, 1, "403 must mark the relay failed");
		assert.equal(health.lastStatus, 403, "the failure must record the 403 status");
	} finally {
		resetAllRelayHealth();
		setActiveRelayState(
			{ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0],
			false,
		);
	}
});

test("relayFetch surfaces the direct 403 when relay and direct both answer 403", async (t) => {
	resetAllRelayHealth();
	const RELAY = "https://gated-egress-relay.example.com";
	const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
	const relayBody = JSON.stringify({
		error: { code: "FreeTierError", message: "relay-shaped rejection" },
	});
	const directBody = JSON.stringify({
		error: { code: "FreeTierError", message: "direct-shaped rejection" },
	});
	const seen: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL) => {
		const target = String(input);
		seen.push(target);
		const body = target === RELAY ? relayBody : directBody;
		return new Response(body, { status: 403, headers: { "content-type": "application/json" } });
	});

	try {
		setActiveRelayState(
			{ enabled: true, url: RELAY, relays: [{ url: RELAY }], mode: "auto" } as unknown as Parameters<
				typeof setActiveRelayState
			>[0],
			false,
		);

		const res = await relayFetch(UPSTREAM, { method: "POST", body: "{}" }, "gate403both");

		assert.equal(res.status, 403, "the direct 403 must surface unchanged");
		assert.equal(await res.text(), directBody, "the surfaced body must be the direct leg's, not the relay's");
		assert.equal(seen[seen.length - 1], UPSTREAM, "the direct URL must be the last one fetched");
		assert.deepEqual(seen, [RELAY, UPSTREAM], "the relay must be tried first, then direct");
	} finally {
		resetAllRelayHealth();
		setActiveRelayState(
			{ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0],
			false,
		);
	}
});

test("relayFetch salvages last relay 429 when direct fallback answers 403", async (t) => {
	resetAllRelayHealth();
	const RELAY = "https://gated-egress-relay.example.com";
	const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
	const relayBody = JSON.stringify({
		error: { code: "rate_limit_exceeded", message: "Too Many Requests" },
	});
	const directBody = JSON.stringify({
		error: { code: "FreeTierError", message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address." },
	});
	const seen: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL) => {
		const target = String(input);
		seen.push(target);
		const body = target === RELAY ? relayBody : directBody;
		const status = target === RELAY ? 429 : 403;
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	});

	try {
		setActiveRelayState(
			{ enabled: true, url: RELAY, relays: [{ url: RELAY }], mode: "auto" } as unknown as Parameters<
				typeof setActiveRelayState
			>[0],
			false,
		);

		const res = await relayFetch(UPSTREAM, { method: "POST", body: "{}" }, "salvage429");

		assert.equal(res.status, 429, "the salvaged 429 must surface instead of the direct 403");
		assert.equal(await res.text(), relayBody, "the surfaced body must be the relay's 429, not the direct 403");
		assert.equal(seen[seen.length - 1], UPSTREAM, "the direct URL must be the last one fetched");
		assert.deepEqual(seen, [RELAY, UPSTREAM], "the relay must be tried first, then direct");
	} finally {
		resetAllRelayHealth();
		setActiveRelayState(
			{ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0],
			false,
		);
	}
});

/** Count the "burst >5/min" relay warnings appended to the sandbox log. */
function count429BurstWarnings(): number {
	try {
		return fs.readFileSync(LOG_FILE, "utf8").split("429 burst").length - 1;
	} catch {
		return 0;
	}
}

test("relay health: 429 burst warns once per window episode, never per event", () => {
	resetAllRelayHealth();
	const before = count429BurstWarnings();

	// Five 429s inside the 60-second window sit at the >5/min threshold.
	for (let i = 0; i < 5; i++) markRelayFailure(`https://burst-a${i}.example.com`, 429);
	assert.equal(count429BurstWarnings() - before, 0, "5 events in the window must not warn");

	// The sixth crosses it: exactly one warning for the episode.
	markRelayFailure("https://burst-a5.example.com", 429);
	assert.equal(count429BurstWarnings() - before, 1, "crossing the threshold must warn once");

	// Further 429s belong to the same episode, so nothing re-warns.
	for (let i = 6; i < 12; i++) markRelayFailure(`https://burst-a${i}.example.com`, 429);
	assert.equal(count429BurstWarnings() - before, 1, "the same burst episode must not re-warn");

	// Clearing the window (the health reset seam) opens a fresh episode.
	resetAllRelayHealth();
	for (let i = 0; i < 6; i++) markRelayFailure(`https://burst-b${i}.example.com`, 429);
	assert.equal(count429BurstWarnings() - before, 2, "a fresh window must warn on its own transition");

	resetAllRelayHealth();
});

test("relay state file carries per-relay secrets and is written 0600", () => {
	withIsolatedRelayFiles(() => {
		const pool = {
			mode: "auto",
			enabled: true,
			url: "https://secret-relay.example.com",
			relays: [{ url: "https://secret-relay.example.com", auth: "shared-secret" }],
		} as unknown as Parameters<typeof saveRelayState>[0];
		saveRelayState(pool);
		assert.ok(
			fs.readFileSync(RELAY_STATE_FILE, "utf8").includes("shared-secret"),
			"the state file genuinely holds the relay secret",
		);
		// A second save backs the first one up: the backup holds the same secret.
		saveRelayState(pool);

		if (process.platform === "win32") return; // Windows: POSIX mode bits are best-effort only
		assert.equal(
			fs.statSync(RELAY_STATE_FILE).mode & 0o777,
			0o600,
			"relay-state.json must not be group/world readable",
		);
		assert.equal(
			fs.statSync(`${RELAY_STATE_FILE}.bak`).mode & 0o777,
			0o600,
			"the relay-state backup must not be group/world readable",
		);
	});
});
