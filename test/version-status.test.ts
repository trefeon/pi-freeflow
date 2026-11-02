/**
 * Offline tests for issue #126: /freeflow status shows the plugin version
 * and /freeflow version|ver reports it with a cached-latest check.
 *
 * All hermetic: version/latest come from package.json + the sandboxed
 * update-cache file only. globalThis.fetch throws so any live-registry
 * attempt fails the test instead of hitting the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCommandSpec } from "../src/commands.ts";
import { RELAY_STATE_FILE, UPDATE_CACHE_FILE, ZEN_TRANSPORT_ENV } from "../src/config.ts";
import { _resetZenTransportForTest } from "../src/zen-transport.ts";
import {
	getActiveRelayState,
	setActiveRelayState,
} from "../src/relay-state.ts";
import { getCachedUpdate, setCachedUpdate } from "../src/update-checker.ts";
import {
	compareVersions,
	formatVersionDetail,
	formatVersionLine,
	getLocalVersion,
} from "../src/update-core.ts";
import type { ExtensionAPI, ExtensionContext, RelayState } from "../src/types.ts";

const mockPi = {
	registerProvider: () => {},
	registerCommand: () => {},
	on: () => {},
} as unknown as ExtensionAPI;

function makeCtx(notifications: Array<{ msg: string; type?: string }>): ExtensionContext {
	return {
		ui: {
			notify(msg: string, type?: "info" | "warning" | "error") {
				notifications.push({ msg, type });
			},
			select: async () => undefined,
			confirm: async () => true,
			input: async () => "",
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;
}

const KNOWN_STATE: RelayState = {
	mode: "auto",
	enabled: true,
	url: "",
	relays: [],
};

/** Snapshot relay disk files + in-memory state + update cache; restore after. */
async function isolated(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const relayBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(`${RELAY_STATE_FILE}.bak`);
	const cacheBefore = read(UPDATE_CACHE_FILE);
	const memBefore = getActiveRelayState();
	try {
		await fn();
	} finally {
		const restore = (p: string, content: string | null): void => {
			try {
				if (content !== null) fs.writeFileSync(p, content, "utf8");
				else fs.rmSync(p, { force: true });
			} catch {}
		};
		restore(RELAY_STATE_FILE, relayBefore);
		restore(`${RELAY_STATE_FILE}.bak`, bakBefore);
		restore(UPDATE_CACHE_FILE, cacheBefore);
		setActiveRelayState(memBefore, false);
	}
}

function withDeadFetch(): () => void {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error("network must stay untouched (offline test)");
	}) as typeof fetch;
	return () => {
		globalThis.fetch = realFetch;
	};
}

test("status banner first line shows pi-freeflow v<local> (offline)", async () => {
	await isolated(async () => {
		const restoreFetch = withDeadFetch();
		try {
			setActiveRelayState(KNOWN_STATE, false);
			fs.rmSync(UPDATE_CACHE_FILE, { force: true });
			const cmd = createCommandSpec(mockPi, () => {});
			const notifications: Array<{ msg: string; type?: string }> = [];
			await cmd.handler("status", makeCtx(notifications));
			const local = getLocalVersion();
			assert.ok(local, "test assumes a readable package.json version");
			const banner = notifications.find((n) => n.msg.startsWith(`pi-freeflow v${local}`));
			assert.ok(banner, `status banner must start with the local version, got: ${JSON.stringify(notifications)}`);
		} finally {
			restoreFetch();
		}
	});
});

test("status keeps the update-available hint when cache is newer (offline)", async () => {
	await isolated(async () => {
		const restoreFetch = withDeadFetch();
		try {
			setActiveRelayState(KNOWN_STATE, false);
			setCachedUpdate("9.9.9");
			assert.equal(getCachedUpdate()?.latest, "9.9.9");
			const cmd = createCommandSpec(mockPi, () => {});
			const notifications: Array<{ msg: string; type?: string }> = [];
			await cmd.handler("status", makeCtx(notifications));
			const local = getLocalVersion();
			assert.ok(
				notifications.some((n) => n.msg.includes("Update available") && n.msg.includes("9.9.9")),
				`status must keep the update hint, got: ${JSON.stringify(notifications)}`,
			);
			assert.ok(
				notifications.some((n) => n.msg.startsWith(`pi-freeflow v${local}`)),
				"version line must be present alongside the update hint",
			);
		} finally {
			restoreFetch();
		}
	});
});

test("status reports up-to-date when cache matches local (offline)", async () => {
	await isolated(async () => {
		const restoreFetch = withDeadFetch();
		try {
			setActiveRelayState(KNOWN_STATE, false);
			const local = getLocalVersion();
			assert.ok(local, "test assumes a readable package.json version");
			setCachedUpdate(local);
			const cmd = createCommandSpec(mockPi, () => {});
			const notifications: Array<{ msg: string; type?: string }> = [];
			await cmd.handler("status", makeCtx(notifications));
			assert.ok(
				notifications.some((n) => n.msg.includes("Up to date") && n.msg.includes(local)),
				`status must report up-to-date, got: ${JSON.stringify(notifications)}`,
			);
		} finally {
			restoreFetch();
		}
	});
});

test("version + ver report the local version without network", async () => {
	await isolated(async () => {
		const restoreFetch = withDeadFetch();
		try {
			setActiveRelayState(KNOWN_STATE, false);
			fs.rmSync(UPDATE_CACHE_FILE, { force: true });
			const cmd = createCommandSpec(mockPi, () => {});
			const local = getLocalVersion();
			assert.ok(local, "test assumes a readable package.json version");
			for (const sub of ["version", "ver"]) {
				const notifications: Array<{ msg: string; type?: string }> = [];
				await cmd.handler(sub, makeCtx(notifications));
				assert.ok(
					notifications.some((n) => n.msg.includes(`pi-freeflow v${local}`)),
					`/${sub} must report the local version, got: ${JSON.stringify(notifications)}`,
				);
			}
		} finally {
			restoreFetch();
		}
	});
});

test("version surfaces the cached-latest verdict (update + up-to-date)", async () => {
	await isolated(async () => {
		const restoreFetch = withDeadFetch();
		try {
			setActiveRelayState(KNOWN_STATE, false);
			const cmd = createCommandSpec(mockPi, () => {});
			const local = getLocalVersion();
			assert.ok(local, "test assumes a readable package.json version");

			setCachedUpdate("9.9.9");
			let notifications: Array<{ msg: string; type?: string }> = [];
			await cmd.handler("version", makeCtx(notifications));
			assert.ok(
				notifications.some((n) => n.msg.includes("Update available") && n.msg.includes("9.9.9")),
				`version must flag the cached newer release, got: ${JSON.stringify(notifications)}`,
			);

			setCachedUpdate(local);
			notifications = [];
			await cmd.handler("version", makeCtx(notifications));
			assert.ok(
				notifications.some((n) => n.msg.includes("Up to date")),
				`version must confirm up-to-date, got: ${JSON.stringify(notifications)}`,
			);
		} finally {
			restoreFetch();
		}
	});
});

test("null-local fallback prints version unknown without comparing", () => {
	assert.equal(formatVersionLine(null), "pi-freeflow vunknown");
	assert.equal(formatVersionDetail(null, "9.9.9"), "pi-freeflow vunknown");
	assert.equal(formatVersionDetail(null, null), "pi-freeflow vunknown");
	const local = getLocalVersion();
	assert.ok(local, "test assumes a readable package.json version");
	assert.equal(formatVersionLine(local), `pi-freeflow v${local}`);
	assert.ok(
		formatVersionDetail(local, "9.9.9").includes("Update available"),
		"newer cached latest must flag an update",
	);
	assert.ok(
		compareVersions("9.9.9", local) > 0,
		"fixture assumes 9.9.9 is newer than the repo version",
	);
	assert.ok(
		formatVersionDetail(local, local).includes("Up to date"),
		"matching cached latest must confirm up-to-date",
	);
});

test("status surfaces Zen transport when PI_FREEFLOW_ZEN_TRANSPORT is configured and omits it when unset", async () => {
	await isolated(async () => {
		const restoreFetch = withDeadFetch();
		const origEnv = process.env[ZEN_TRANSPORT_ENV];
		try {
			setActiveRelayState(KNOWN_STATE, false);
			const cmd = createCommandSpec(mockPi, () => {});

			// 1. Unset env -> Zen transport line omitted
			delete process.env[ZEN_TRANSPORT_ENV];
			_resetZenTransportForTest();
			let notifications: Array<{ msg: string; type?: string }> = [];
			await cmd.handler("status", makeCtx(notifications));
			assert.ok(notifications.length > 0, "status should emit notifications");
			const unsetMsg = notifications.map((n) => n.msg).join("\n");
			assert.ok(
				!unsetMsg.includes("Zen transport:"),
				`status must omit 'Zen transport:' when unset, got: ${unsetMsg}`,
			);

			// 2. Set env -> Zen transport line included
			process.env[ZEN_TRANSPORT_ENV] = "bun-sidecar";
			_resetZenTransportForTest();
			notifications = [];
			await cmd.handler("status", makeCtx(notifications));
			assert.ok(notifications.length > 0, "status should emit notifications");
			const setMsg = notifications.map((n) => n.msg).join("\n");
			assert.ok(
				setMsg.includes("Zen transport:"),
				`status must include 'Zen transport:' when set, got: ${setMsg}`,
			);
		} finally {
			if (typeof origEnv === "string") {
				process.env[ZEN_TRANSPORT_ENV] = origEnv;
			} else {
				delete process.env[ZEN_TRANSPORT_ENV];
			}
			_resetZenTransportForTest();
			restoreFetch();
		}
	});
});
