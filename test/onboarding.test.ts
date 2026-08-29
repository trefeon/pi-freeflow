/**
 * First-run onboarding: flag-gated welcome notify that fires exactly once.
 *
 * Drives the real `session_start` handler captured from the default export,
 * isolating the real disk state (flag + relay state + backup) for the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import defaultExtension from "../src/index.ts";
import { ONBOARDED_FLAG_FILE, RELAY_STATE_FILE } from "../src/config.ts";
import {
	ensureRelay,
	resolveRelayState,
	saveRelayState,
} from "../src/relay-state.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;
const TOUCHED = [ONBOARDED_FLAG_FILE, RELAY_STATE_FILE, BAK_FILE];

/** Remove all touched files so a test starts from a clean slate. */
function clearFiles(): void {
	for (const p of TOUCHED) {
		try {
			fs.rmSync(p, { force: true });
		} catch {}
	}
}

/** Back up and restore every touched file for the duration of a test. */
async function withIsolatedFiles(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const before = TOUCHED.map((p) => [p, read(p)] as const);
	try {
		await fn();
	} finally {
		for (const [p, content] of before) {
			if (content !== null) {
				fs.writeFileSync(p, content, "utf8");
			} else {
				try {
					fs.rmSync(p, { force: true });
				} catch {}
			}
		}
	}
}

/** Capture the real session_start handler without heavy per-invocation setup. */
async function captureSessionStart(): Promise<
	(event: unknown, ctx: ExtensionContext) => Promise<void> | void
> {
	const registeredEvents: Record<
		string,
		(event: unknown, ctx: ExtensionContext) => Promise<void> | void
	> = {};
	const mockPi: ExtensionAPI = {
		registerProvider() {},
		registerCommand() {},
		on(event, handler) {
			registeredEvents[event] = handler;
		},
	} as ExtensionAPI;
	await defaultExtension(mockPi);
	const handler = registeredEvents.session_start;
	assert.ok(handler, "session_start handler must be registered");
	return handler;
}

function makeCtx(notifyMessages: string[]): ExtensionContext {
	return {
		ui: {
			notify(msg: string) {
				notifyMessages.push(msg);
			},
			setStatus() {},
			input: async () => undefined,
			select: async () => undefined,
		},
	} as ExtensionContext;
}

test("first run notifies once and persists the flag; later sessions stay silent", async () => {
	await withIsolatedFiles(async () => {
		clearFiles();
		const handler = await captureSessionStart();
		const notifyMessages: string[] = [];
		const ctx = makeCtx(notifyMessages);

		// First session: no flag yet — notify exactly once and create the flag.
		await handler({}, ctx);
		assert.equal(notifyMessages.length, 1, "first run must notify exactly once");
		assert.ok(
			fs.existsSync(ONBOARDED_FLAG_FILE),
			"flag file must be created on first run",
		);
		assert.equal(
			fs.readFileSync(ONBOARDED_FLAG_FILE, "utf8"),
			"1",
			"flag file must contain '1'",
		);
		assert.match(
			notifyMessages[0],
			/^freeflow ready: 25 free models via local proxy 127\.0\.0\.1:28180\. /,
			"welcome must announce the local proxy",
		);
		assert.match(
			notifyMessages[0],
			/Relay pool empty — direct mode\. Run \/freeflow deploy to add your own egress\./,
			"empty pool must hint at deploying a relay",
		);

		// Second session: flag exists — no further notify.
		notifyMessages.length = 0;
		await handler({}, ctx);
		assert.equal(
			notifyMessages.length,
			0,
			"second run must not notify again (flag already set)",
		);
	});
});

test("first run with a pre-configured relay pool reports the pool size", async () => {
	await withIsolatedFiles(async () => {
		clearFiles();
		const seed = resolveRelayState();
		ensureRelay(seed, "https://relay-a.example.com", "relay-a");
		ensureRelay(seed, "https://relay-b.example.com", "relay-b");
		seed.url = "https://relay-a.example.com";
		seed.enabled = true;
		seed.mode = "on";
		saveRelayState(seed);

		const handler = await captureSessionStart();
		const notifyMessages: string[] = [];
		await handler({}, makeCtx(notifyMessages));
		assert.equal(notifyMessages.length, 1, "first run must notify exactly once");
		assert.match(
			notifyMessages[0],
			/Relay pool ready: 2 relay\(s\)\. Run \/freeflow for pool management\./,
			"pool-ready hint must mention the configured relay count",
		);
	});
});
