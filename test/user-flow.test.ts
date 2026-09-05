/**
 * User-flow End-to-End suite (deterministic, network-mocked).
 *
 * Drives the whole fresh-user journey against mocks, no real network, no real
 * ports 28180/18080:
 *   1. Fresh install — activation registers 26 models, binds a proxy, onboards
 *      exactly once (flag-gated), no re-notify on a second session.
 *   2. Direct-mode chat — POST /v1/chat/completions streams SSE chunks + a
 *      terminal event through the running proxy; request hits the sandbox log.
 *   3. Relay pool — a 429 rolls to the next relay (never leaks to the client)
 *      and marks the failed relay cooling; all relays down -> direct fallback.
 *   4. Deploy — /freeflow deploy vercel against mocked api.vercel.com adds a
 *      relay, activates it, and probes it OK.
 *   5. Update — mocked registry writes a newer version to the sandbox cache and
 *      /freeflow status reports it; identical version -> "already on latest".
 *   6. Command surface — status/list/use/label/remove/on/off/debug on|off
 *      against seeded state; asserts notify output + sandbox file effects.
 */
import { TEST_PROXY_PORT } from "./user-flow-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import defaultExtension from "../src/index.ts";
import {
	RELAY_STATE_FILE,
	ONBOARDED_FLAG_FILE,
	LOG_FILE,
	UPDATE_CACHE_FILE,
	DEBUG_STATE_FILE,
	CATALOG_CACHE_FILE,
} from "../src/config.ts";
import { startProxy, isProxyAlive } from "../src/proxy.ts";
import {
	resetAllRelayHealth,
	setActiveRelayState,
	getRelayHealth,
	resolveRelayState,
	loadRelayState,
} from "../src/relay-state.ts";
import { createCommandSpec } from "../src/commands.ts";
import {
	checkForUpdateInBackground,
	getCachedUpdate,
	fetchLatestVersion,
	getLocalVersion,
} from "../src/update-checker.ts";
import { ALL_MODELS } from "../src/models.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	KnownRelay,
	ProviderConfig,
	RelayState,
} from "../src/types.ts";

// ── Sandbox isolation (shared with user-lifecycle.test.ts) ──────────────────

import { clearSandboxFiles, withIsolatedSandboxFiles } from "./_sandbox-helpers.ts";

// ── Response / body stubs ───────────────────────────────────────────────────

/** Response with a single-buffer body (the proxy pipes upstream.body). */
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

/** SSE response that streams several chunks then closes (terminal marker kept). */
function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return {
		status: 200,
		ok: true,
		headers: new Headers({ "content-type": "text/event-stream" }),
		text: async () => chunks.join(""),
		body: new ReadableStream({
			start(controller) {
				for (const c of chunks) controller.enqueue(encoder.encode(c));
				controller.close();
			},
		}),
	} as unknown as Response;
}

const OPENCODE_MODEL = "muse-spark-1.2-contributor-free";

function chatBody(model: string, stream = false): string {
	return JSON.stringify({
		model,
		stream,
		messages: [{ role: "user", content: "hi" }],
	});
}

function makeState(relays: Array<{ url: string; label?: string }>): RelayState {
	return {
		mode: "auto",
		enabled: relays.length > 0,
		url: relays[0]?.url ?? "",
		relays: relays as KnownRelay[],
	};
}

// ── UI / command context builders ───────────────────────────────────────────

type NotifyRecord = { msg: string; type?: "info" | "warning" | "error" };

function makeCommandUi(
	notifications: NotifyRecord[],
	setStatus: (k: string, v: string | undefined) => void = () => {},
): ExtensionUIContext {
	return {
		notify(msg: string, type?: "info" | "warning" | "error") {
			notifications.push({ msg, type });
		},
		setStatus,
		input: async (prompt: string, placeholder = "") => {
			if (prompt.includes("API token")) return "vercel-token-abcd1234";
			if (prompt.includes("Project name")) return "relay-test";
			return placeholder;
		},
		select: async () => undefined,
		confirm: async () => true,
	};
}

function makeCommandCtx(notifications: NotifyRecord[]): ExtensionContext {
	return { ui: makeCommandUi(notifications) } as ExtensionContext;
}

function makeSessionCtx(notifyMessages: string[]): ExtensionContext {
	return {
		ui: {
			notify(msg: string) {
				notifyMessages.push(msg);
			},
			setStatus: () => {},
			input: async () => undefined,
			select: async () => undefined,
		},
	} as ExtensionContext;
}

const mockPi: ExtensionAPI = {
	registerProvider: () => {},
	registerCommand: () => {},
	on: () => {},
};

// ── 1. Fresh install ────────────────────────────────────────────────────────

test("user flow [1/6] fresh install registers 26 models, binds a proxy, and onboards exactly once", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();

		let registeredName = "";
		let registeredConfig: ProviderConfig | undefined;
		const events: Record<
		string,
		(...args: unknown[]) => Promise<void> | void
	> = {};
		const mockPiFull: ExtensionAPI = {
			registerProvider(name: string, config: ProviderConfig) {
				registeredName = name;
				registeredConfig = config;
			},
			registerCommand() {},
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			// Harness stores listeners variadically so tests may invoke them
			// with zero args (e.g. session_shutdown has no payload).
			events[event] = handler as (...args: unknown[]) => Promise<void> | void;
		},
		};

		const realFetch = globalThis.fetch.bind(globalThis);
		const localPrefix = `http://127.0.0.1:${TEST_PROXY_PORT}`;
		const fetchMock = test.mock.method(
			globalThis,
			"fetch",
			async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) return realFetch(u, init);
				// Force the legacy/default port probes to see "no daemon" so a
				// possibly-running real daemon is never reused by the extension.
				if (u.includes("127.0.0.1:18080") || u.includes("127.0.0.1:28180")) {
					throw new Error("no daemon (test override)");
				}
				// Everything else external (registry/catalog): benign response.
				return new Response(JSON.stringify({ version: "1.4.12" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);

		try {
			await defaultExtension(mockPiFull);

			// Provider registered with the full static catalog.
			assert.equal(registeredName, "freeflow");
			assert.ok(registeredConfig, "ProviderConfig must be populated");
			assert.equal(
				registeredConfig.models.length,
				ALL_MODELS.length,
				"all 26 static models must be registered",
			);
			assert.match(registeredConfig.baseUrl, /127\.0\.0\.1/, "baseUrl must point to loopback");

			// Proxy genuinely started on the test port (not the real 28180/18080).
			assert.ok(await isProxyAlive(TEST_PROXY_PORT), "proxy must be bound on the test port");

			// First-run onboarding.
			const handler = events.session_start;
			assert.ok(handler, "session_start handler must be registered");
			const msgs: string[] = [];
			const ctx = makeSessionCtx(msgs);
			await handler({}, ctx);
			assert.equal(msgs.length, 1, "first run must notify exactly once");
			assert.ok(fs.existsSync(ONBOARDED_FLAG_FILE), "onboarded flag must be created");
			assert.equal(fs.readFileSync(ONBOARDED_FLAG_FILE, "utf8"), "1");
			assert.match(
				msgs[0],
				/^freeflow ready: 26 free models via local proxy 127\.0\.0\.1:28180\. /,
				"welcome must announce the local proxy",
			);

			// Second session — flag already set, no re-notify.
			msgs.length = 0;
			await handler({}, ctx);
			assert.equal(msgs.length, 0, "second session must not re-notify");
		} finally {
			events.session_shutdown?.();
			fetchMock.mock.restore();
		}
	});
});

// ── 2. Direct-mode chat SSE ─────────────────────────────────────────────────

test("user flow [2/6] direct-mode chat streams SSE chunks and a terminal event through the proxy", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		await withProxyScenario(
			{ state: makeState([]) },
			async (url) => {
				assert.ok(url.includes("opencode.ai"), `direct upstream URL: ${url}`);
				return sseResponse([
					'data: {"id":"chatcmpl-sse","choices":[{"delta":{"content":"Hel"}}]}\n\n',
					'data: {"id":"chatcmpl-sse","choices":[{"delta":{"content":"lo"}}]}\n\n',
					"data: [DONE]\n\n",
				]);
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL, true),
				});
				assert.equal(res.status, 200);
				assert.match(
					res.headers.get("content-type") ?? "",
					/event-stream|json/,
					"content-type must reflect the upstream SSE stream",
				);
				const text = await res.text();
				assert.match(text, /Hel/, "first chunk must arrive");
				assert.match(text, /lo/, "second chunk must arrive");
				assert.match(text, /\[DONE\]/, "terminal event must be forwarded");
				// The request landed in the sandbox log.
				assert.ok(fs.existsSync(LOG_FILE), "log file must be written");
				assert.match(
					fs.readFileSync(LOG_FILE, "utf8"),
					/request starting|succeeded|chat\/completions/,
					"request must be logged in the sandbox",
				);
			},
		);
	});
});

// ── 3a. Relay 429 -> roll ───────────────────────────────────────────────────

test("user flow [3a/6] relay 429 rolls to the next healthy relay and marks the failed relay cooling", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const relay1 = "http://127.0.0.1:19331";
		const relay2 = "http://127.0.0.1:19332";

		await withProxyScenario(
			{ state: makeState([{ url: relay1 }, { url: relay2 }]) },
			async (url) => {
				if (url.startsWith(relay1)) {
					return stubResponse(429, JSON.stringify({ error: "upstream rate limited" }));
				}
				if (url.startsWith(relay2)) {
					return stubResponse(200, JSON.stringify({ id: "after-roll", choices: [] }));
				}
				assert.ok(url.includes("opencode.ai"), `unexpected direct URL: ${url}`);
				return stubResponse(200, JSON.stringify({ id: "unexpected", choices: [] }));
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: chatBody(OPENCODE_MODEL),
				});
				assert.equal(res.status, 200, "429 must never leak to the client");
				const json = (await res.json()) as { id?: string };
				assert.equal(json.id, "after-roll", "must roll 429 to the next relay");

				// relay1 entered cooldown; relay2 healthy; active sticky-switched.
				const h1 = getRelayHealth(relay1);
				assert.ok(h1, "relay1 must have a health record");
				assert.ok(h1.cooldownUntil > Date.now(), "relay1 must be in cooldown");
				assert.equal(h1.lastStatus, 429);
				const h2 = getRelayHealth(relay2);
				assert.ok(h2 && h2.lastLatencyMs != null, "relay2 must be marked healthy");
				assert.equal(resolveRelayState().url, relay2, "active relay must switch to relay2");

				// /freeflow list shows the cooling badge for relay1.
				const notifications: NotifyRecord[] = [];
				const ctx = makeCommandCtx(notifications);
				const cmd = createCommandSpec(mockPi, () => {});
				await cmd.handler("list", ctx);
				const joined = notifications.map((n) => n.msg).join("\n");
				assert.match(joined, /cooling/, "list must show the cooling badge");
				assert.ok(joined.includes(relay1), "list must include the cooling relay URL");
			},
		);
	});
});

// ── 3b. All relays down -> direct fallback ──────────────────────────────────

test("user flow [3b/6] all relays exhausted falls back to direct upstream without leaking failures", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const relay1 = "http://127.0.0.1:19341";
		const relay2 = "http://127.0.0.1:19342";

		await withProxyScenario(
			{ state: makeState([{ url: relay1 }, { url: relay2 }]) },
			async (url) => {
				if (url.startsWith(relay1)) {
					return stubResponse(503, JSON.stringify({ error: "relay down" }));
				}
				if (url.startsWith(relay2)) {
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
				assert.equal(res.status, 200, "client must not see relay failures");
				const json = (await res.json()) as { id?: string };
				assert.equal(json.id, "direct-fallback", "must fall back to direct when relays exhaust");
			},
		);
	});
});

// ── 4. Deploy ───────────────────────────────────────────────────────────────

test("user flow [4/6] /freeflow deploy vercel adds a relay, activates it, and probes it OK", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const notifications: NotifyRecord[] = [];
		const ctx = makeCommandCtx(notifications);
		const cmd = createCommandSpec(mockPi, () => {});

		const realFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("/v13/deployments") && init?.method === "POST") {
					return new Response(
						JSON.stringify({ id: "dep1", projectId: "proj1" }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (url.includes("/v9/projects/") && init?.method === "PATCH") {
					return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
				}
				if (url.includes("/v13/deployments/")) {
					return new Response(
						JSON.stringify({ readyState: "READY", url: "relay-test.vercel.app" }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (url.startsWith("https://relay-test.vercel.app")) {
					// probeRelay round-trip (x-relay-path=/zen/v1/models)
					return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
				}
				throw new Error(`unexpected fetch in deploy flow: ${url}`);
			}) as typeof fetch;

			await cmd.handler("deploy vercel", ctx);

			// State file: relay added + activated, auth persisted.
			const st = loadRelayState();
			const deployed = st.relays.find((r) => r.url === "https://relay-test.vercel.app");
			assert.ok(deployed, "deployed relay must be added to state");
			assert.equal(deployed.auth, undefined, "relay is public by default for seamless migration");
			assert.equal(st.url, "https://relay-test.vercel.app", "deployed relay must be active");
			assert.equal(st.enabled, true, "relay pool must be enabled");

			assert.ok(
				notifications.some((n) => n.msg.includes("Deployed & active: https://relay-test.vercel.app")),
				"deploy must notify the active relay URL",
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

// ── 5. Update ───────────────────────────────────────────────────────────────

test("user flow [5/6] newer registry version writes the cache and reports the update; identical stays silent", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const notifications: NotifyRecord[] = [];
		const ctx = makeCommandCtx(notifications);
		const cmd = createCommandSpec(mockPi, () => {});

		const realFetch = globalThis.fetch;
		try {
			// 1. Mocked registry returns a newer version.
			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ version: "9.9.9" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch;

			assert.equal(await fetchLatestVersion(), "9.9.9", "registry must report the newer version");

			// Background notifier writes the version into the sandbox cache.
			checkForUpdateInBackground(makeCommandUi([]));
			await new Promise<void>((r) => setImmediate(r));
			const cached = getCachedUpdate();
			assert.ok(cached, "update cache must be written");
			assert.equal(cached.latest, "9.9.9", "cache must hold the newer version");

			// /freeflow status then reports it.
			await cmd.handler("status", ctx);
			assert.ok(
				notifications.some((n) => n.msg.includes("Update available") && n.msg.includes("9.9.9")),
				"status must report the cached update",
			);

			// 2. Registry returns the identical version -> "already on latest".
			notifications.length = 0;
			const local = getLocalVersion();
			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ version: local }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch;
			await cmd.handler("update", ctx);
			assert.ok(
				notifications.some((n) => n.msg.includes("Already on latest")),
				"identical registry must report already on latest",
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

// ── 6. Command surface ──────────────────────────────────────────────────────

test("user flow [6/6] status/list/use/label/remove/on/off/debug mutate state and notify", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const r1 = "https://alpha.example.com";
		const r2 = "https://beta.example.com";
		setActiveRelayState(
			{
				mode: "auto",
				enabled: true,
				url: r1,
				relays: [
					{ url: r1, label: "alpha" },
					{ url: r2, label: "beta" },
				],
			},
			true,
		);

		const notifications: NotifyRecord[] = [];
		const ctx = makeCommandCtx(notifications);
		const cmd = createCommandSpec(mockPi, () => {});

		// status
		await cmd.handler("status", ctx);
		assert.ok(notifications.some((n) => n.msg.includes("Mode: auto")), "status must report mode");
		assert.ok(notifications.some((n) => n.msg.includes("2 relay(s)")), "status must report pool size");

		// list
		await cmd.handler("list", ctx);
		assert.ok(
			notifications.some((n) => n.msg.includes("alpha") && n.msg.includes("beta")),
			"list must enumerate both relays",
		);

		// use 2 -> switch active to beta
		await cmd.handler("use 2", ctx);
		let st = loadRelayState();
		assert.equal(st.url, r2, "use must switch the active relay");
		assert.ok(st.enabled, "use must keep the pool enabled");

		// label 1 gamma -> relabel alpha
		await cmd.handler("label 1 gamma", ctx);
		st = loadRelayState();
		assert.equal(st.relays.find((r) => r.url === r1)?.label, "gamma", "label must rename the relay");

		// remove active beta -> blocked
		await cmd.handler("remove 2", ctx);
		st = loadRelayState();
		assert.ok(st.relays.some((r) => r.url === r2), "active relay must not be removable");
		assert.ok(
			notifications.some((n) => n.msg.includes("Cannot remove the active relay")),
			"remove must reject the active relay",
		);

		// switch active to alpha, then remove beta succeeds.
		await cmd.handler("use alpha", ctx);
		await cmd.handler("remove 2", ctx);
		st = loadRelayState();
		assert.equal(st.relays.some((r) => r.url === r2), false, "remove must delete the inactive relay");
		assert.equal(st.url, r1, "active relay must be preserved");

		// on / off
		await cmd.handler("on", ctx);
		st = loadRelayState();
		assert.equal(st.mode, "on", "on must set mode=on");
		assert.equal(st.enabled, true, "on must enable the pool");
		await cmd.handler("off", ctx);
		st = loadRelayState();
		assert.equal(st.mode, "off", "off must set mode=off");
		assert.equal(st.enabled, false, "off must disable the pool");

		// debug on / off persist the debug state file
		await cmd.handler("debug on", ctx);
		let dbg = JSON.parse(fs.readFileSync(DEBUG_STATE_FILE, "utf8")) as { debug?: boolean };
		assert.equal(dbg.debug, true, "debug on must persist debug=true");
		await cmd.handler("debug off", ctx);
		dbg = JSON.parse(fs.readFileSync(DEBUG_STATE_FILE, "utf8")) as { debug?: boolean };
		assert.equal(dbg.debug, false, "debug off must persist debug=false");
	});
});

// ── Proxy scenario harness (reused by chat + relay tests) ───────────────────

async function withProxyScenario(
	opts: { state: RelayState; port?: number },
	upstreamStub: (url: string, init?: RequestInit) => Response | Promise<Response>,
	fn: (port: number, localPrefix: string) => Promise<void>,
): Promise<void> {
	const testPort = opts.port ?? 19321;
	const { server, port } = await startProxy(testPort);
	const effectivePort = port ?? testPort;
	const localPrefix = `http://127.0.0.1:${effectivePort}`;
	const realFetch = globalThis.fetch.bind(globalThis);
	try {
		setActiveRelayState(opts.state, true);
		resetAllRelayHealth();
		const fetchMock = test.mock.method(
			globalThis,
			"fetch",
			async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) return realFetch(u, init);
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
