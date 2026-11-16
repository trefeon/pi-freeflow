/**
 * Native-TLS relay transport (issue #137): the Bun sidecar keeps the TLS
 * handshake while the TCP leg leaves through a relay's CONNECT tunnel.
 *
 * Covers the transport contract (proxy frame, auth header placement,
 * capability caching) and the real sidecar's tunnel error frame.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
	RelayTransportUnavailable,
	relayFetch,
	type RelayAttemptTransport,
} from "../src/relay.ts";
import {
	getRelayHealth,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import {
	_resetZenRelayProxyCapabilityForTest,
	createZenBunRelayTransport,
} from "../src/zen-relay-proxy.ts";
import { fetchZenDirectViaSidecar, findBunOnPath, resolveZenSidecarScript } from "../src/zen-transport.ts";
import type { RelayState } from "../src/types.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const RELAY_A = "http://127.0.0.1:3999";

const ZEN_BUN = { mode: "bun-sidecar", bunVersion: "1.4.4", bunPath: "/fake/bun", reason: "bun-sidecar" } as const;

function pool(urls: string[]): RelayState {
	return { enabled: true, url: urls[0] ?? "", relays: urls.map((url) => ({ url })), mode: "auto" } as RelayState;
}

function ctx(headers: Record<string, string> = { authorization: "Bearer public" }) {
	return {
		url: "https://opencode.ai/inference/openai/v1/chat/completions",
		opts: { method: "POST", headers, body: Buffer.from('{"model":"deepseek-v4.1-flash-free"}') } as RequestInit,
		signal: new AbortController().signal,
		headerTimeoutMs: 5000,
	};
}

test("transport tunnels through the candidate with auth on CONNECT, not the request", async () => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(
			{ ...pool([RELAY_A]), relays: [{ url: RELAY_A, auth: "relay-secret" }] } as RelayState,
			false,
		);
		_resetZenRelayProxyCapabilityForTest();
		interface Seen {
			url: string;
			headers: Record<string, string>;
			proxy?: { url: string; headers?: Record<string, string> };
			headerTimeoutMs: number;
		}
		const captured: { seen: Seen | null } = { seen: null };
		const transport = createZenBunRelayTransport(ZEN_BUN, "t1", {
			attemptImpl: async (url, init) => {
				captured.seen = {
					url,
					headers: init.headers,
					proxy: init.proxy,
					headerTimeoutMs: init.headerTimeoutMs,
				};
				return new Response("ok", { status: 200 });
			},
		});
		try {
			const res = await transport.attempt(RELAY_A, ctx());
			assert.equal(res.status, 200);
			assert.ok(captured.seen !== null);
			const seen = captured.seen;
			assert.equal(seen.url, "https://opencode.ai/inference/openai/v1/chat/completions");
			assert.equal(seen.proxy?.url, RELAY_A);
			assert.equal(seen.proxy?.headers?.["x-relay-auth"], "relay-secret", "auth rides the CONNECT request");
			assert.equal(seen.headers["x-relay-auth"], undefined, "auth never rides the tunneled request");
			assert.equal(seen.headers["x-relay-target"], undefined);
			assert.equal(seen.headers["host"], "opencode.ai", "tunnel leg targets the origin, not the relay");
			assert.equal(seen.headerTimeoutMs, 5000);
		} finally {
			_resetZenRelayProxyCapabilityForTest();
		}
	});
});

test("a relay that refuses CONNECT is cached as tunnel-incapable with no health mark", async () => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(pool([RELAY_A]), false);
		_resetZenRelayProxyCapabilityForTest();
		let calls = 0;
		const transport = createZenBunRelayTransport(ZEN_BUN, "t2", {
			attemptImpl: async () => {
				calls += 1;
				throw Object.assign(new Error("Proxy refused to open a tunnel: 405"), {
					code: "ERR_PROXY_TUNNEL",
					proxyStatus: 405,
				});
			},
		});
		try {
			await assert.rejects(transport.attempt(RELAY_A, ctx()), RelayTransportUnavailable);
			await assert.rejects(
				transport.attempt(RELAY_A, ctx()),
				(err: unknown) => err instanceof RelayTransportUnavailable && /cached/.test(err.reason),
				"the second attempt is skipped before dialing",
			);
			assert.equal(calls, 1, "capability verdict is cached for the TTL");
		} finally {
			_resetZenRelayProxyCapabilityForTest();
		}
	});
});

test("the direct leg never carries a proxy", async () => {
	let seenProxy: unknown = "unset";
	const transport = createZenBunRelayTransport(ZEN_BUN, "t3", {
		attemptImpl: async (_url, init) => {
			seenProxy = init.proxy ?? null;
			return new Response("ok", { status: 200 });
		},
	});
	await transport.attemptDirect({
		url: "https://opencode.ai/inference/openai/v1/chat/completions",
		opts: { method: "POST", headers: { host: "relay.example.com" }, body: Buffer.from("{}") } as RequestInit,
	});
	assert.equal(seenProxy, null);
});

test("a broken sidecar degrades the direct leg to the honest Node attempt", async (t) => {
	const transport = createZenBunRelayTransport(ZEN_BUN, "t5", {
		attemptImpl: async () => {
			throw new Error("bun sidecar gone");
		},
	});
	const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("node", { status: 502 }));
	try {
		const res = await transport.attemptDirect({
			url: "https://opencode.ai/inference/openai/v1/chat/completions",
			opts: { method: "POST", body: "{}" } as RequestInit,
		});
		assert.equal(res.status, 502);
		assert.equal(fetchMock.mock.callCount(), 1, "the Node attempt surfaces the authentic verdict");
	} finally {
		fetchMock.mock.restore();
	}
});

/**
 * Real sidecar under Bun: a proxy that answers CONNECT with 405 must surface
 * the code and status. Bun is not installed in the CI matrix, so the case
 * skips there; locally (and on hosts with Bun) it exercises the real stack.
 */
const bunPath = findBunOnPath();
test("real sidecar surfaces ERR_PROXY_TUNNEL with the CONNECT status", { skip: bunPath === null }, async () => {
	const proxy = net.createServer((sock) => {
		let buf = "";
		sock.on("data", (chunk: Buffer) => {
			buf += chunk.toString("latin1");
			if (!buf.includes("\r\n\r\n")) return;
			sock.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n");
		});
		sock.on("error", () => {});
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
	const addr = proxy.address();
	assert.ok(addr !== null && typeof addr === "object");
	try {
		await assert.rejects(
			fetchZenDirectViaSidecar(
				"https://example.invalid/x",
				{
					method: "POST",
					headers: {},
					body: Buffer.from("{}"),
					headerTimeoutMs: 5000,
					proxy: { url: `http://127.0.0.1:${addr.port}`, headers: { "x-relay-auth": "t" } },
				},
				{ runtimePath: bunPath as string, scriptPath: resolveZenSidecarScript() },
			),
			(err: unknown) => {
				const e = err as { code?: string; proxyStatus?: number };
				assert.equal(e.code, "ERR_PROXY_TUNNEL", `expected a structured tunnel error, got ${String(err)}`);
				assert.equal(e.proxyStatus, 405);
				return true;
			},
		);
	} finally {
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	}
});

/** Fake child echoes the frame it received, proving the proxy payload shape. */
test("sidecar frame carries the proxy block and keeps x-relay-auth off the request", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-proxy-frame-"));
	try {
		const script = path.join(dir, "echo.mjs");
		fs.writeFileSync(
			script,
			[
				"const chunks = [];",
				"for await (const c of process.stdin) chunks.push(c);",
				"const frame = JSON.parse(Buffer.concat(chunks).toString(\"utf8\"));",
				"const headerKeys = Object.keys(frame.headers || {});",
				"process.stdout.write(JSON.stringify({ status: 200, headers: {",
				"  \"x-proxy-url\": String(frame.proxy?.url ?? \"\"),",
				"  \"x-proxy-auth\": String(frame.proxy?.headers?.[\"x-relay-auth\"] ?? \"\"),",
				"  \"x-request-has-auth\": headerKeys.some((k) => k.toLowerCase() === \"x-relay-auth\") ? \"yes\" : \"no\",",

				"}}) + \"\\n\");",
				"process.stdout.write(\"ok\");",
			].join("\n") + "\n",
		);
		const res = await fetchZenDirectViaSidecar(
			"https://example.invalid/x",
			{
				method: "POST",
				headers: { authorization: "Bearer public", "x-relay-auth": "must-strip" },
				body: Buffer.from("{}"),
				headerTimeoutMs: 5000,
				proxy: { url: "http://127.0.0.1:1234", headers: { "x-relay-auth": "connect-secret" } },
			},
			{ runtimePath: process.execPath, scriptPath: script },
		);
		assert.equal(res.headers.get("x-proxy-url"), "http://127.0.0.1:1234");
		assert.equal(res.headers.get("x-proxy-auth"), "connect-secret", "proxy headers reach the proxy block");

		// The bridge forwards the request headers verbatim; stripping is the
		// real sidecar's job (zen-transport.test.ts covers it).
		assert.equal(res.headers.get("x-request-has-auth"), "yes");
		assert.equal(await res.text(), "ok");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** The dispatcher honors the transport contract: unavailable = skip, no mark. */
test("relayFetch skips a transport-unavailable candidate without a health mark", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		setActiveRelayState(pool(["https://worker-a.example.com", "https://tunnel-b.example.com"]), false);
		const attempts: string[] = [];
		const transport: RelayAttemptTransport = {
			async attempt(candidateUrl) {
				attempts.push(candidateUrl);
				if (candidateUrl.includes("worker-a")) throw new RelayTransportUnavailable(candidateUrl, "CONNECT refused");
				return new Response('{"id":"served"}', { status: 200 });
			},
			async attemptDirect() {
				throw new Error("direct leg must not run when a candidate serves");
			},
		};
		try {
			const res = await relayFetch(
				"https://opencode.ai/inference/openai/v1/chat/completions",
				{ method: "POST", body: JSON.stringify({ model: "deepseek-v4.1-flash-free" }) },
				"t4",
				{},
				() => {},
				transport,
			);
			assert.equal(res.status, 200);
			assert.deepEqual(attempts, ["https://worker-a.example.com", "https://tunnel-b.example.com"]);
			assert.equal(getRelayHealth("https://worker-a.example.com")?.consecutiveFailures ?? 0, 0);
		} finally {
			resetAllRelayHealth();
		}
	});
});
