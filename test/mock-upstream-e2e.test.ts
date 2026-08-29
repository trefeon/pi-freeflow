/**
 * Mock-upstream end-to-end: exercises the real proxy + relayFetch pipeline
 * against a stubbed upstream (no real network), simulating real-world user
 * flows deterministically.
 *
 * Scenarios mirror actual usage:
 *  - new user, direct mode, upstream 200
 *  - relay pool active, upstream 200 through the relay
 *  - relay 429 -> roll to the next candidate -> 200
 *  - all relays fail -> direct fallback -> 200
 *  - all relays fail AND direct fails -> last response returned
 *  - kilo model routing to api.kilo.ai
 *  - /v1/models catalog + /health
 *
 * Relay/upstream fetches are stubbed; requests to the local proxy pass
 * through to the real fetch so the full HTTP path is exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startProxy } from "../src/proxy.ts";
import {
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";
import type { RelayState } from "../src/types.ts";

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

/** Response stub with a proper ReadableStream body (the proxy pipes upstream.body). */
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
const KILO_MODEL = "nemotron-3-nano-omni";

function chatBody(model: string): string {
	return JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] });
}

function makeState(relays: Array<{ url: string }>, enabled = true): RelayState {
	return {
		mode: "auto",
		enabled,
		url: relays[0]?.url ?? "",
		relays: relays as RelayState["relays"],
	};
}

/**
 * Run a scenario: start the proxy, stub fetch, drive the flow, assert.
 */
async function withProxyScenario(
	opts: { state: RelayState },
	upstreamStub: (url: string, init?: RequestInit) => Response | Promise<Response>,
	fn: (port: number, testPort: string) => Promise<void>,
): Promise<void> {
	const { server, port } = await startProxy(19285);
	const effectivePort = port ?? 19285;
	const localPrefix = `http://127.0.0.1:${effectivePort}`;
	const realFetch = globalThis.fetch.bind(globalThis);
	try {
		setActiveRelayState(opts.state, false);
		resetAllRelayHealth();
		const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
			const u = String(url);
			if (u.startsWith(localPrefix)) {
				return realFetch(u, init);
			}
			return upstreamStub(u, init);
		});
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

// ── 1. New user, direct mode, upstream 200 ──────────────────────────────────

test("mock upstream: new user direct mode succeeds (upstream 200)", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([]) },
			async (url) => {
				assert.ok(url.includes("opencode.ai"), `direct upstream URL: ${url}`);
				return stubResponse(200, JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "ok" } }] }));
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				assert.equal(res.status, 200);
				const json = (await res.json()) as { id?: string; choices?: Array<{ message?: { content?: string } }> };
				assert.equal(json.id, "chatcmpl-1");
				assert.equal(json.choices?.[0]?.message?.content, "ok");
			},
		);
	});
});

// ── 2. Relay mode, upstream 200 through the relay ───────────────────────────

test("mock upstream: relay active forwards through relay candidate", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([{ url: "https://relay1.example.com" }]) },
			async (url, init) => {
				assert.ok(url.startsWith("https://relay1.example.com"), `relay URL used: ${url}`);
				const h = new Headers(init?.headers);
				assert.equal(h.get("x-relay-target"), "https://opencode.ai");
				assert.ok((h.get("x-relay-path") ?? "").includes("/v1/chat/completions"));
				return stubResponse(200, JSON.stringify({ id: "via-relay", choices: [] }));
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				assert.equal(res.status, 200);
				const json = (await res.json()) as { id?: string };
				assert.equal(json.id, "via-relay", "response must come through the relay");
			},
		);
	});
});

// ── 3. Relay 429 -> roll to next -> 200 ─────────────────────────────────────

test("mock upstream: relay 429 rolls to the next healthy relay", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([{ url: "https://relay1.example.com" }, { url: "https://relay2.example.com" }]) },
			async (url) => {
				if (url.startsWith("https://relay1.example.com")) {
					return stubResponse(429, JSON.stringify({ error: "upstream rate limited" }));
				}
				assert.ok(url.startsWith("https://relay2.example.com"), `rolled to: ${url}`);
				return stubResponse(200, JSON.stringify({ id: "after-roll", choices: [] }));
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				assert.equal(res.status, 200);
				const json = (await res.json()) as { id?: string };
				assert.equal(json.id, "after-roll", "must roll 429 to the next relay");
			},
		);
	});
});

// ── 4. All relays fail -> direct fallback -> 200 ────────────────────────────

test("mock upstream: all relays fail falls back to direct upstream", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([{ url: "https://relay1.example.com" }]) },
			async (url) => {
				if (url.startsWith("https://relay1.example.com")) {
					return stubResponse(503, JSON.stringify({ error: "relay down" }));
				}
				assert.ok(url.includes("opencode.ai"), `direct fallback URL: ${url}`);
				return stubResponse(200, JSON.stringify({ id: "direct-fallback", choices: [] }));
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				assert.equal(res.status, 200);
				const json = (await res.json()) as { id?: string };
				assert.equal(json.id, "direct-fallback", "must fall back to direct when relays exhaust");
			},
		);
	});
});

// ── 5. All relays fail AND direct fails -> last response returned ───────────

test("mock upstream: relays and direct all fail — last status surfaces to client", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([{ url: "https://relay1.example.com" }]) },
			async (url) => {
				if (url.startsWith("https://relay1.example.com")) {
					return stubResponse(503, JSON.stringify({ error: "relay down" }));
				}
				return stubResponse(503, JSON.stringify({ error: "upstream down" }));
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				// The direct fallback's 503 surfaces to the client.
				assert.equal(res.status, 503);
			},
		);
	});
});

// ── 6. Kilo model routing ───────────────────────────────────────────────────

test("mock upstream: kilo model routes to api.kilo.ai with kilo-free auth", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([]) },
			async (url, init) => {
				assert.ok(url.startsWith("https://api.kilo.ai"), `kilo upstream URL: ${url}`);
				const h = new Headers(init?.headers);
				assert.equal(h.get("authorization"), "Bearer kilo-free");
				return stubResponse(200, JSON.stringify({ id: "kilo-ok", choices: [] }));
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(KILO_MODEL),
				});
				assert.equal(res.status, 200);
				const json = (await res.json()) as { id?: string };
				assert.equal(json.id, "kilo-ok");
			},
		);
	});
});

// ── 7. /v1/models catalog ───────────────────────────────────────────────────

test("mock upstream: /v1/models serves the 25-model catalog", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([]) },
			async () => stubResponse(200, "{}"),
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
				assert.equal(res.status, 200);
				const json = (await res.json()) as { data?: Array<{ id: string }> };
				assert.equal(json.data?.length, 25);
			},
		);
	});
});

// ── 8. /health endpoint ─────────────────────────────────────────────────────

test("mock upstream: /health reports active pool", async () => {
	await withIsolatedRelayFiles(async () => {
		await withProxyScenario(
			{ state: makeState([{ url: "https://relay1.example.com" }]) },
			async () => stubResponse(200, "{}"),
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/health`);
				assert.equal(res.status, 200);
				const json = (await res.json()) as { relay?: string; relays?: number; enabled?: boolean };
				assert.equal(json.enabled, true);
			},
		);
	});
});
