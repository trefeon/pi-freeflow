/**
 * Edge-case unit tests for CLI slash commands and TUI status bar
 *
 * Complements test/commands.test.ts with boundary/error-path coverage:
 * widget hide/show status semantics, invalid indices, unknown targets,
 * and invalid log level defaulting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCommandSpec } from "../src/commands.ts";
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

const WIDGET_KEY = "freeflow";

test("edge: /freeflow hide clears the status widget", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			mode: "on",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "r1" }],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);
		const { ctx, statuses } = createMockContext();

		await spec.handler("hide", ctx);

		assert.ok(statuses.length > 0, "hide should update the status widget");
		const last = statuses[statuses.length - 1];
		assert.equal(last.key, WIDGET_KEY);
		assert.equal(last.status, undefined);
	});
});

test("edge: /freeflow show restores relay text in the status widget", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			mode: "on",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "r1" }],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);
		const { ctx, statuses } = createMockContext();

		await spec.handler("show", ctx);

		assert.ok(statuses.length > 0, "show should update the status widget");
		const last = statuses[statuses.length - 1];
		assert.equal(last.key, WIDGET_KEY);
		assert.equal(last.status, "relay: ON | r1 1/1");
	});
});

test("edge: /freeflow use with invalid index (0, 999) notifies instead of crashing", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "r1" }],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);

		for (const idx of ["0", "999"]) {
			const { ctx, notifications } = createMockContext();
			await spec.handler(`use ${idx}`, ctx); // must not throw
			assert.ok(
				notifications.some((n) => n.message.includes("not found")),
				`use ${idx} should notify not-found`,
			);
			assert.equal(
				getActiveRelayState().url,
				"https://relay1.example.com",
				`use ${idx} must not switch active relay`,
			);
		}
	});
});

test("edge: /freeflow use with unknown name is graceful", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "r1" }],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("use no-such-relay", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("not found")),
			"unknown name should notify not-found",
		);
		assert.equal(getActiveRelayState().url, "https://relay1.example.com");
	});
});

test("edge: /freeflow label unknown target notifies and leaves labels unchanged", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com", label: "r1" }],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("label ghost relay-x", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("not found")),
			"label unknown target should notify not-found",
		);
		assert.equal(getActiveRelayState().relays[0].label, "r1");
	});
});

test("edge: /freeflow remove unknown target notifies and keeps relay list", async () => {
	await withSavedDiskState(async () => {
		const state: RelayState = {
			enabled: true,
			url: "https://relay1.example.com",
			relays: [
				{ url: "https://relay1.example.com", label: "r1" },
				{ url: "https://relay2.example.com", label: "r2" },
			],
		};
		setActiveRelayState(state, true);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("remove ghost", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("not in saved list")),
			"remove unknown should notify",
		);
		assert.equal(getActiveRelayState().relays.length, 2);
	});
});

test("edge: /freeflow logs with invalid level defaults to info filtering", async () => {
	const hadLog = fs.existsSync(LOG_FILE);
	const backup = hadLog ? fs.readFileSync(LOG_FILE, "utf8") : "";
	try {
		fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
		fs.writeFileSync(
			LOG_FILE,
			"[DEBUG] debug noise line\n[INFO] important info line\n[ERROR] error line\n",
		);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("logs boguslevel", ctx);

		// An invalid level token must not be swallowed as a request-id filter:
		// it should default to info-level filtering and surface the info line.
		const header = notifications.find((n) => n.message.includes("logs ("));
		assert.ok(header, "logs should emit a header notification");
		assert.ok(
			header.message.includes("level=info"),
			`expected level=info default, got: ${header.message}`,
		);
		assert.ok(
			header.message.includes("[INFO] important info line"),
			"info-level line should be shown",
		);
	} finally {
		if (hadLog) {
			fs.writeFileSync(LOG_FILE, backup);
		} else {
			try { fs.unlinkSync(LOG_FILE); } catch {}
		}
	}
});
