/**
 * Unit tests for CLI slash commands and TUI status bar
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCommandSpec, updateStatusBar } from "../src/commands.ts";
import { LOG_FILE, RELAY_STATE_FILE } from "../src/config.ts";
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
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(`${RELAY_STATE_FILE}.bak`);
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
		restore(`${RELAY_STATE_FILE}.bak`, bakBefore);
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
test("command spec: /freeflow logs --follow tails via setInterval 1s", async () => {
	const origSetInterval = globalThis.setInterval;
	const origClearInterval = globalThis.clearInterval;
	let capturedMs: number | null = null;
	let capturedFn: (() => void) | null = null;
	// @ts-ignore mock setInterval to capture 1s tail interval
	globalThis.setInterval = (fn: () => void, ms?: number) => {
		capturedFn = fn;
		capturedMs = ms ?? null;
		return 999 as unknown as NodeJS.Timeout;
	};
	// @ts-ignore mock clearInterval noop
	globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;
	const hadLog = fs.existsSync(LOG_FILE);
	const backup = hadLog ? fs.readFileSync(LOG_FILE, "utf8") : null;
	try {
		fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
		fs.writeFileSync(LOG_FILE, "[INFO] test log line 1\n[INFO] test log line 2\n");
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();
		await spec.handler("logs --follow", ctx);
		assert.equal(capturedMs, 1000);
		assert.ok(capturedFn, "setInterval not called for --follow");
		assert.ok(notifications.length >= 1, "initial logs notify missing");
		// simulate new log arriving and interval tick notifies tail
		fs.writeFileSync(LOG_FILE, "[INFO] test log line 1\n[INFO] test log line 2\n[INFO] live tail line\n");
		const before = notifications.length;
		(capturedFn as unknown as () => void)!();
		assert.ok(notifications.length > before, "interval tick did not notify");
		assert.ok(notifications.some((n) => n.message.includes("live tail line")), "tail content not notified");
		// also verify -f alias triggers interval
		capturedMs = null;
		capturedFn = null;
		const { ctx: ctx2, notifications: n2 } = createMockContext();
		await spec.handler("logs -f", ctx2);
		assert.equal(capturedMs, 1000);
		assert.ok(capturedFn);
		assert.ok(n2.length >= 1);
	} finally {
		globalThis.setInterval = origSetInterval;
		globalThis.clearInterval = origClearInterval;
		if (hadLog && backup !== null) {
			fs.writeFileSync(LOG_FILE, backup);
		} else if (!hadLog) {
			try { fs.unlinkSync(LOG_FILE); } catch {}
		}
	}
});
