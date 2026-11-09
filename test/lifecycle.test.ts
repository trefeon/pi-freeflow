/**
 * Integration test for complete extension lifecycle
 */
// MUST be literal first import: it disables detached-daemon spawn before
// src/config.ts is evaluated, and supplies the fetch stub whose daemon answer
// keeps activation attached instead of binding an in-process fallback.
import { harnessFetchHandler } from "./user-flow-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import defaultExtension, { buildProviderConfig } from "../src/index.ts";
import type { ExtensionAPI, ProviderConfig, RegisteredCommand } from "../src/types.ts";
import { _resetClientForTest, hasFallbackServer } from "../src/client.ts";
import type { RegisteredModel } from "../src/types.ts";

function lifecycleFetchHandler(onControlCall?: (endpoint: string, body: unknown) => void): typeof fetch {
	const baseHandler = harnessFetchHandler();
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url.includes("/_client/")) {
			const endpoint = url.split("/_client/")[1] ?? "";
			let body: unknown = null;
			if (init?.body && typeof init.body === "string") {
				try { body = JSON.parse(init.body); } catch {}
			}
			onControlCall?.(endpoint, body);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return baseHandler(input, init);
	}) as typeof fetch;
}

test("extension registers provider, commands, and lifecycle hooks", async (t) => {
	_resetClientForTest();
	// Phantom daemon + offline registry: activation spawns no detached daemon,
	// binds no real port, and never reaches registry.npmjs.org.
	t.mock.method(globalThis, "fetch", lifecycleFetchHandler());
	let registeredProviderName = "";
	let registeredProviderConfig: ProviderConfig | undefined;
	const registeredCommands = new Map<string, Omit<RegisteredCommand, "name">>();
	const registeredEvents = new Map<string, Function>();

	const mockPi: ExtensionAPI = {
		registerProvider(name: string, config: ProviderConfig) {
			registeredProviderName = name;
			registeredProviderConfig = config;
		},
		registerCommand(name: string, spec: Omit<RegisteredCommand, "name">) {
			registeredCommands.set(name, spec);
		},
		on(event: string, handler: Function) {
			registeredEvents.set(event, handler);
		},
	};

	try {
		await defaultExtension(mockPi);

		// Verify provider registration
		assert.equal(registeredProviderName, "freeflow");
		assert.ok(registeredProviderConfig);
		assert.ok(registeredProviderConfig!.models.length >= 26);
		assert.ok(registeredCommands.has("freeflow"));

		// Verify lifecycle hooks
		assert.ok(registeredEvents.has("session_start"));
		assert.ok(registeredEvents.has("model_select"));
		assert.ok(registeredEvents.has("session_shutdown"));

		// Trigger shutdown cleanup
		const shutdownHandler = registeredEvents.get("session_shutdown");
		if (shutdownHandler) {
			await shutdownHandler();
		}
	} finally {
		_resetClientForTest();
	}
});

test("session_shutdown stops heartbeat and detaches from daemon (fallbackServer is null)", async (t) => {
	_resetClientForTest();
	let detached = false;
	t.mock.method(globalThis, "fetch", lifecycleFetchHandler((endpoint) => {
		if (endpoint === "detach") detached = true;
	}));
	const registeredEvents = new Map<string, Function>();
	const mockPi: ExtensionAPI = {
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: Function) {
			registeredEvents.set(event, handler);
		},
	};

	try {
		await defaultExtension(mockPi);
		const shutdownHandler = registeredEvents.get("session_shutdown");
		assert.ok(shutdownHandler, "session_shutdown handler must be registered");

		assert.equal(hasFallbackServer(), false);
		await shutdownHandler();
		assert.equal(hasFallbackServer(), false);
		assert.equal(detached, true, "session_shutdown must detach client from daemon");
	} finally {
		_resetClientForTest();
	}
});

test("buildProviderConfig includes reasoningEffortMap in compat when thinkingLevelMap is defined", () => {
	const modelWithThinkingMap = {
		id: "mimo-v2.6-flash-free",
		name: "Mimo Flash",
		api: "openai-completions",
		source: "opencode",
		reasoning: true,
		thinkingLevelMap: {
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
		},
	} as unknown as RegisteredModel;

	const config = buildProviderConfig([modelWithThinkingMap], 28180);
	const target = config.models.find((m) => m.id === "mimo-v2.6-flash-free");
	assert.ok(target, "model must be in config");
	assert.deepEqual(target.compat?.reasoningEffortMap, {
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
	});
});
