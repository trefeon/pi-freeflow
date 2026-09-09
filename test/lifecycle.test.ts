/**
 * Integration test for complete extension lifecycle
 */
import test from "node:test";
import assert from "node:assert/strict";
import defaultExtension from "../src/index.ts";
import type { ExtensionAPI, ProviderConfig, RegisteredCommand } from "../src/types.ts";
import { hasFallbackServer } from "../src/client.ts";
test("extension registers provider, commands, and lifecycle hooks", async () => {
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

	await defaultExtension(mockPi);

	// Verify provider registration
	assert.equal(registeredProviderName, "freeflow");
	assert.ok(registeredProviderConfig);
	assert.ok(registeredProviderConfig!.models.length >= 24);
	assert.ok(registeredCommands.has("freeflow"));

	// Verify lifecycle hooks
	assert.ok(registeredEvents.has("session_start"));
	assert.ok(registeredEvents.has("model_select"));
	assert.ok(registeredEvents.has("session_shutdown"));

	// Trigger shutdown cleanup
	const shutdownHandler = registeredEvents.get("session_shutdown");
	if (shutdownHandler) {
		shutdownHandler();
	}
});

test("session_shutdown does not stop heartbeat when connected to a daemon (fallbackServer is null)", async () => {
	const registeredEvents = new Map<string, Function>();
	const mockPi: ExtensionAPI = {
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: Function) {
			registeredEvents.set(event, handler);
		},
	};

	await defaultExtension(mockPi);
	const shutdownHandler = registeredEvents.get("session_shutdown");
	assert.ok(shutdownHandler, "session_shutdown handler must be registered");

	assert.equal(hasFallbackServer(), false);
	shutdownHandler();
	assert.equal(hasFallbackServer(), false);
});
