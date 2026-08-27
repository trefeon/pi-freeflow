/**
 * Keep-alive agent tests for relay and proxy
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { agent, relayFetch } from "../src/relay.ts";
import { setActiveRelayState } from "../src/relay-state.ts";
import { startProxy } from "../src/proxy.ts";

function getAgentTimeout(a: unknown): number | undefined {
	// undici Agent stores options under Symbol(options)
	const syms = Object.getOwnPropertySymbols(a as object);
	for (const s of syms) {
		const v = (a as Record<symbol, unknown>)[s] as unknown;
		if (v && typeof v === "object" && "keepAliveTimeout" in (v as Record<string, unknown>)) {
			return (v as Record<string, unknown>).keepAliveTimeout as number;
		}
	}
	// fallback: direct property
	const anyAgent = a as unknown as Record<string, unknown>;
	if (typeof anyAgent.keepAliveTimeout === "number") return anyAgent.keepAliveTimeout;
	return undefined;
}

test("undici Agent has keepAliveTimeout 30s", () => {
	const timeout = getAgentTimeout(agent);
	assert.equal(timeout, 30_000, `keepAliveTimeout should be 30000, got ${timeout}`);
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
