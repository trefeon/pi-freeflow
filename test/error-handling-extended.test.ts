/**
 * Error-handling breadth coverage for pi-freeflow:
 *  - relayFetch network-error roll (candidate throws -> next candidate -> cooldown)
 *  - relayFetch timeout roll + direct fallback when all candidates timeout
 *  - direct-upstream invalid JSON passthrough (no JSON.parse crash)
 *  - deploy HTTP 429/500 actionable errors (nothing created on failure)
 *  - startProxy EADDRINUSE -> port+1 fallback
 *  - proxy direct-path socket error -> 502
 *  - command-layer /freeflow add rejection of a bare http loopback URL
 *  - command-layer /freeflow list cooldown countdown badge
 *
 * Sandboxed: setup.mjs re-roots all data files into a temp dir before any src
 * import; relay/upstream fetches are stubbed; only loopback proxies are bound.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { relayFetch } from "../src/relay.ts";
import {
	deployCloudflareWorker,
	deployVercelRelay,
} from "../src/deploy.ts";
import { createCommandSpec } from "../src/commands.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";
import {
	getActiveRelayState,
	getRelayHealth,
	markRelayFailure,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RelayState,
} from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

/** Isolate both main and .bak disk files (relay auto-switch writes state). */
function withIsolatedRelayFiles(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(BAK_FILE);
	return (async () => {
		try {
			await fn();
		} finally {
			const restore = (p: string, before: string | null): void => {
				if (before !== null) {
					fs.writeFileSync(p, before, "utf8");
				} else {
					try {
						fs.rmSync(p, { force: true });
					} catch {}
				}
			};
			restore(RELAY_STATE_FILE, mainBefore);
			restore(BAK_FILE, bakBefore);
		}
	})();
}

/** Response stub with a proper ReadableStream body (the proxy pipes body). */
function stubResponse(status: number, body = "{}"): Response {
	const encoder = new TextEncoder();
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers({ "content-type": "application/json" }),
		text: async () => body,
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			},
		}),
	} as unknown as Response;
}

const OPENCODE_MODEL = "muse-spark-1.2-contributor-free";

function chatBody(model: string): string {
	return JSON.stringify({
		model,
		stream: false,
		messages: [{ role: "user", content: "hi" }],
	});
}

function makeState(relays: Array<{ url: string }>, enabled = true): RelayState {
	return {
		mode: "auto",
		enabled,
		url: relays[0]?.url ?? "",
		relays: relays as RelayState["relays"],
	};
}

/** Realistic "not our abort" timeout rejection (name is not AbortError). */
function timeoutError(): Error {
	const err = new Error("The operation was aborted due to timeout");
	Object.defineProperty(err, "name", { value: "TimeoutError" });
	return err;
}

// ── relayFetch network-error roll ───────────────────────────────────────────

test("relayFetch rolls on a thrown network error, succeeds via the next candidate, and cooldowns the failed one", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		setActiveRelayState(
			makeState([
				{ url: "https://relay1.example.com" },
				{ url: "https://relay2.example.com" },
			]),
			false,
		);
		const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown) => {
			const u = String(url);
			if (u.startsWith("https://relay1.example.com")) {
				throw Object.assign(
					new Error("connect ECONNREFUSED 10.0.0.1:443"),
					{ code: "ECONNREFUSED" },
				);
			}
			if (u.startsWith("https://relay2.example.com")) {
				return new Response("data: ok\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			throw new Error(`unexpected URL: ${u}`);
		});
		try {
			const res = await relayFetch("https://opencode.ai/zen/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			assert.equal(res.status, 200, "must succeed via the second candidate");
			assert.equal(await res.text(), "data: ok\n\n");

			const health = getRelayHealth("https://relay1.example.com");
			assert.ok(health, "failed candidate must have a health record");
			assert.ok(
				health.cooldownUntil > Date.now(),
				"failed candidate must be placed in cooldown",
			);
			assert.equal(health.consecutiveFailures, 1);
			assert.match(health.lastError ?? "", /ECONNREFUSED/);
		} finally {
			fetchMock.mock.restore();
		}
	});
});

// ── relayFetch timeout roll + direct fallback ───────────────────────────────

test("relayFetch rolls on a timeout rejection and falls back to direct when all candidates timeout", async () => {
	await withIsolatedRelayFiles(async () => {
		// Candidate 1 times out -> roll to candidate 2 -> success.
		resetAllRelayHealth();
		setActiveRelayState(
			makeState([
				{ url: "https://relay1.example.com" },
				{ url: "https://relay2.example.com" },
			]),
			false,
		);
		const timeoutMock = test.mock.method(globalThis, "fetch", async (url: unknown) => {
			const u = String(url);
			if (u.startsWith("https://relay1.example.com")) {
				throw timeoutError();
			}
			if (u.startsWith("https://relay2.example.com")) {
				return new Response("data: ok\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			throw new Error(`unexpected URL: ${u}`);
		});
		try {
			const res = await relayFetch("https://opencode.ai/zen/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			assert.equal(res.status, 200);
			assert.equal(await res.text(), "data: ok\n\n");
			const health = getRelayHealth("https://relay1.example.com");
			assert.ok(health && health.cooldownUntil > Date.now());
			assert.match(health.lastError ?? "", /aborted due to timeout/i);
		} finally {
			timeoutMock.mock.restore();
		}

		// Every candidate times out -> the direct upstream is attempted.
		resetAllRelayHealth();
		setActiveRelayState(
			makeState([{ url: "https://relay1.example.com" }]),
			false,
		);
		let directAttempted = false;
		const allTimeoutMock = test.mock.method(globalThis, "fetch", async (url: unknown) => {
			const u = String(url);
			if (u.startsWith("https://relay1.example.com")) {
				throw timeoutError();
			}
			if (u.startsWith("https://opencode.ai/zen")) {
				directAttempted = true;
				return new Response("direct-ok", { status: 200 });
			}
			throw new Error(`unexpected URL: ${u}`);
		});
		try {
			const res = await relayFetch("https://opencode.ai/zen/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			assert.equal(res.status, 200);
			assert.equal(await res.text(), "direct-ok");
			assert.equal(
				directAttempted,
				true,
				"direct fallback must be attempted after all candidates timeout",
			);
		} finally {
			allTimeoutMock.mock.restore();
		}
	});
});

// ── Direct upstream invalid JSON passthrough ────────────────────────────────

/** Run a proxy scenario: start the proxy, stub only upstream fetches, drive the flow. */
async function withProxyScenario(
	opts: { state: RelayState },
	upstreamStub: (url: string, init?: RequestInit) => Response | Promise<Response>,
	fn: (port: number, localPrefix: string) => Promise<void>,
): Promise<void> {
	const { server, port } = await startProxy(29741);
	const effectivePort = port ?? 29741;
	const localPrefix = `http://127.0.0.1:${effectivePort}`;
	const realFetch = globalThis.fetch.bind(globalThis);
	try {
		setActiveRelayState(opts.state, false);
		resetAllRelayHealth();
		const fetchMock = test.mock.method(
			globalThis,
			"fetch",
			async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) {
					return realFetch(u, init);
				}
				return upstreamStub(u, init);
			},
		);
		try {
			await fn(effectivePort, localPrefix);
		} finally {
			fetchMock.mock.restore();
		}
	} finally {
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
}

test("proxy passes an invalid-JSON upstream body through unchanged (no JSON parse crash)", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([]) },
			async (url) => {
				assert.ok(url.includes("opencode.ai"), `upstream URL: ${url}`);
				return stubResponse(200, "not-json{broken");
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				assert.equal(res.status, 200);
				assert.equal(
					await res.text(),
					"not-json{broken",
					"raw upstream body must reach the client verbatim",
				);
			},
		);
	});
});

// ── Proxy direct-path socket error -> 502 ───────────────────────────────────

test("proxy direct-path upstream socket error surfaces as HTTP 502", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([]) },
			async (url) => {
				assert.ok(url.includes("opencode.ai"), `upstream URL: ${url}`);
				throw Object.assign(
					new Error("connect ECONNREFUSED 127.0.0.1:443"),
					{ code: "ECONNREFUSED" },
				);
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				assert.equal(res.status, 502);
				const json = (await res.json()) as { error?: string };
				assert.equal(json.error, "upstream error");
			},
		);
	});
});

// ── startProxy EADDRINUSE -> port+1 fallback ────────────────────────────────

test("startProxy falls back to port+1 when the base port is already bound (EADDRINUSE)", async () => {
	await withIsolatedRelayFiles(async () => {
		const basePort = 29761;
		// A foreign holder on the base port. It must NOT satisfy isProxyAlive
		// (which requires a 200 + application/json /v1/models response), so the
		// proxy treats it as an unrelated occupant and tries basePort+1.
		const dummy = http.createServer((_req, res) => {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not a proxy");
		});
		await new Promise<void>((resolve) =>
			dummy.listen(basePort, "127.0.0.1", () => resolve()),
		);
		try {
			const { server, port } = await startProxy(basePort);
			assert.ok(server, "a real proxy server must be created, not attached");
			assert.equal(
				port,
				basePort + 1,
				"proxy must fall back to basePort+1 inside the 20-attempt loop",
			);
			try {
				const health = await fetch(`http://127.0.0.1:${port}/_health`);
				assert.equal(health.status, 200);
				const json = (await health.json()) as { port?: number };
				assert.equal(json.port, port, "health must report the real fallback port");
			} finally {
				if (server) {
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
			}
		} finally {
			await new Promise<void>((resolve) => dummy.close(() => resolve()));
		}
	});
});

// ── Deploy HTTP 429/500 actionable errors ───────────────────────────────────

type StubResponse = { status?: number; body?: unknown };
type RecordedCall = { url: string; init?: RequestInit };

/** Replace globalThis.fetch with a scripted responder; auto-restores after the test. */
function stubFetch(
	t: test.TestContext,
	responder: (url: string, init: RequestInit | undefined, call: number) => StubResponse,
): RecordedCall[] {
	const calls: RecordedCall[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, init });
		const r = responder(url, init, calls.length - 1);
		const status = r.status ?? 200;
		const payload =
			typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
		return new Response(payload, {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	return calls;
}

test("deployVercelRelay surfaces HTTP 429 as an actionable error and creates nothing", async (t) => {
	const calls = stubFetch(t, (url, init) => {
		if (url.includes("/v13/deployments") && init?.method === "POST") {
			return { status: 429, body: {} };
		}
		return { status: 500, body: {} };
	});
	await assert.rejects(
		deployVercelRelay("vercel-tok", "relay-429"),
		(e: unknown) => {
			const msg = (e as Error).message;
			return msg.includes("HTTP 429") && !msg.includes("vercel-tok");
		},
	);
	assert.equal(
		calls.length,
		1,
		"only the create POST may run — failure must abort before any poll/project PATCH",
	);
});

test("deployVercelRelay surfaces HTTP 500 as an actionable error and creates nothing", async (t) => {
	const calls = stubFetch(t, (url, init) => {
		if (url.includes("/v13/deployments") && init?.method === "POST") {
			return { status: 500, body: {} };
		}
		return { status: 500, body: {} };
	});
	await assert.rejects(
		deployVercelRelay("vercel-tok", "relay-500"),
		(e: unknown) => {
			const msg = (e as Error).message;
			return msg.includes("HTTP 500") && !msg.includes("vercel-tok");
		},
	);
	assert.equal(calls.length, 1);
});

test("deployCloudflareWorker surfaces HTTP 429 as an actionable error and creates nothing", async (t) => {
	const calls = stubFetch(t, (url) => {
		if (url.endsWith("/client/v4/accounts")) {
			return { status: 429, body: {} };
		}
		return { status: 500, body: {} };
	});
	await assert.rejects(
		deployCloudflareWorker("cf-tok", "relay-cf-429"),
		(e: unknown) => {
			const msg = (e as Error).message;
			return msg.includes("HTTP 429") && !msg.includes("cf-tok");
		},
	);
	assert.equal(
		calls.length,
		1,
		"failure must abort before any script upload/creation call",
	);
});

// ── Command-layer: /freeflow add rejection of a bare http URL ───────────────

function createMockContext(): {
	ctx: ExtensionContext;
	notifications: Array<{ message: string; type?: string }>;
} {
	const notifications: Array<{ message: string; type?: string }> = [];
	const ui: ExtensionUIContext = {
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		setStatus(_key: string, _status: string | undefined) {},
		input(_prompt: string, defaultValue?: string) {
			return Promise.resolve(defaultValue || "");
		},
		select(_prompt: string, options: string[]) {
			return Promise.resolve(options[0]);
		},
	};
	return { ctx: { ui }, notifications };
}

const mockApi: ExtensionAPI = {
	registerProvider() {},
	registerCommand() {},
};

test("command layer: /freeflow add rejects a bare http loopback URL and adds no relay", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		const state: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "relay1" }],
		};
		setActiveRelayState(state, false);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("add http://127.0.0.1:9999", ctx);

		const warn = notifications.find((n) => n.type === "warning");
		assert.ok(warn, "a rejection must notify a warning");
		assert.match(warn.message, /only https relay URLs are allowed/);
		assert.equal(warn.message.includes("rejected"), true);

		const after = getActiveRelayState();
		assert.equal(after.url, "https://relay1.example.com", "active relay must not change");
		assert.equal(after.relays.length, 1, "no relay must be added");
	});
});

// ── Command-layer: /freeflow list cooldown countdown badge ──────────────────

test("command layer: /freeflow list shows the active cooldown countdown badge", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		const state: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "relay1" }],
		};
		setActiveRelayState(state, false);
		markRelayFailure("https://relay1.example.com", 503, "boom");

		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("list", ctx);

		const msg = notifications.find((n) => n.message.includes("Saved Relays"));
		assert.ok(msg, "expected a list header notify");
		assert.match(
			msg.message,
			/⚠️ \[cooling \d+s: HTTP 503\]/,
			`expected cooldown countdown badge, got: ${msg.message}`,
		);
	});
});
