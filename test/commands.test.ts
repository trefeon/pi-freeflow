/**
 * Unit tests for CLI slash commands and TUI status bar
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCommandSpec, updateStatusBar } from "../src/commands.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";
import {
	getActiveRelayState,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RelayState,
} from "../src/types.ts";

async function withSavedDiskState(fn: () => Promise<void> | void): Promise<void> {
	const existed = fs.existsSync(RELAY_STATE_FILE);
	const backup = existed ? fs.readFileSync(RELAY_STATE_FILE, "utf8") : "";
	try {
		await fn();
	} finally {
		if (existed) {
			fs.writeFileSync(RELAY_STATE_FILE, backup);
		} else {
			fs.rmSync(RELAY_STATE_FILE, { force: true });
		}
	}
}

function createMockContext(): {
	ctx: ExtensionContext;
	notifications: Array<{ message: string; type?: string }>;
	statuses: Array<{ key: string; status?: string }>;
} {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; status?: string }> = [];

	const ui: ExtensionUIContext = {
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		setStatus(key: string, status: string | undefined) {
			statuses.push({ key, status });
		},
		input(_prompt: string, defaultValue?: string) {
			return Promise.resolve(defaultValue || "");
		},
		select(_prompt: string, options: string[]) {
			return Promise.resolve(options[0]);
		},
	};

	return {
		ctx: { ui },
		notifications,
		statuses,
	};
}

const mockApi: ExtensionAPI = {
	registerProvider() {},
	registerCommand() {},
};

test("command spec: /freeflow add adds relay with custom short name", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			enabled: true,
			url: "https://old.example.com",
			relays: [{ url: "https://old.example.com", label: "old-main" }],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("add https://my-worker.workers.dev cf-sg", ctx);

		const curState = getActiveRelayState();
		assert.equal(curState.url, "https://my-worker.workers.dev");
		assert.equal(curState.relays.length, 2);
		assert.equal(curState.relays[1].label, "cf-sg");
		assert.ok(notifications.some((n) => n.message.includes("cf-sg")));
	});
});

test("command spec: /freeflow use switches by index and short name", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			enabled: true,
			url: "https://relay1.example.com",
			relays: [
				{ url: "https://relay1.example.com", label: "r1" },
				{ url: "https://relay2.example.com", label: "cf-backup" },
			],
		};
		setActiveRelayState(state, true);

		const spec = createCommandSpec(mockApi);
		const { ctx } = createMockContext();

		// Use by alias
		await spec.handler("use cf-backup", ctx);
		assert.equal(getActiveRelayState().url, "https://relay2.example.com");

		// Use by 1-based index
		await spec.handler("use 1", ctx);
		assert.equal(getActiveRelayState().url, "https://relay1.example.com");
	});
});

test("command spec: /freeflow label renames saved relay", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "old-name" }],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);
		const { ctx } = createMockContext();
		await spec.handler("label 1 super-relay", ctx);
		assert.equal(getActiveRelayState().relays[0].label, "super-relay");
	});
});

test("updateStatusBar displays short name in TUI format", () => {
	withSavedDiskState(() => {
		const state: RelayState = {
			mode: "on",
			enabled: true,
			url: "https://my-worker.workers.dev",
			relays: [
				{ url: "https://my-worker.workers.dev", label: "cf-edge" },
				{ url: "https://backup.vercel.app", label: "vercel-east" },
			],
		};
		setActiveRelayState(state, true);
		const { ctx, statuses } = createMockContext();
		updateStatusBar(ctx.ui);

		assert.ok(statuses.length > 0);
		const lastStatus = statuses[statuses.length - 1];
		assert.equal(lastStatus.key, "freeflow");
		assert.equal(lastStatus.status, "relay: ON | cf-edge 1/2");
	});
});
