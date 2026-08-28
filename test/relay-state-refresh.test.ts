/**
 * Regression tests for relay-state refresh semantics:
 * - runtime (unpersisted) overrides survive getOrderedRelayUrls
 * - external disk writes from another process are still picked up (mtime gate)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RELAY_STATE_FILE } from "../src/config.ts";
import {
	getActiveRelayState,
	setActiveRelayState,
	getOrderedRelayUrls,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

/** Backup real state file so user data is untouched by these tests. */
function withSavedDiskState(fn: () => void): void {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(`${RELAY_STATE_FILE}.bak`);
	try {
		fn();
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

test("runtime disable survives getOrderedRelayUrls when disk unchanged", () => {
	withSavedDiskState(() => {
		const override: RelayState = { enabled: false, url: "", relays: [] };
		setActiveRelayState(override, false);

		const ordered = getOrderedRelayUrls();

		assert.equal(getActiveRelayState().enabled, false, "unpersisted disable must not be clobbered by a reload");
		assert.deepEqual(ordered, [], "empty pool must yield zero candidates, never a blank ''");
	});
});

test("external disk change is picked up by getOrderedRelayUrls", () => {
	withSavedDiskState(() => {
		setActiveRelayState({ enabled: true, url: "", relays: [] }, false);

		const external: RelayState = {
			enabled: true,
			url: "https://pool-from-other-session.example.com",
			relays: [{ url: "https://pool-from-other-session.example.com", label: "other-session" }],
		};
		fs.writeFileSync(RELAY_STATE_FILE, JSON.stringify(external));
		// Guarantee a distinct mtime even on coarse-clock filesystems so the
		// staleness gate always observes the external write.
		const bumped = new Date(Date.now() + 5);
		fs.utimesSync(RELAY_STATE_FILE, bumped, bumped);

		const ordered = getOrderedRelayUrls();

		assert.deepEqual(ordered, ["https://pool-from-other-session.example.com"], "cross-process persisted change must propagate");
		assert.equal(getActiveRelayState().url, "https://pool-from-other-session.example.com");
	});
});
