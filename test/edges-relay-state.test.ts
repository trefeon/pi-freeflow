/**
 * Edge-case tests for src/relay-state.ts — TDD sweep
 *
 * Covers: getOrderedRelayUrls edge cases, findRelay edge cases,
 * setRelayLabel unknown target, ensureRelay empty label edge,
 * removeRelay last remaining, saveRelayState non-EPERM fast fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RELAY_STATE_FILE } from "../src/config.ts";
import {
	ensureRelay,
	findRelay,
	getOrderedRelayUrls,
	isRelayHealthy,
	markRelayFailure,
	removeRelay,
	resetAllRelayHealth,
	saveRelayState,
	setActiveRelayState,
	setRelayLabel,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

/** Backup real state file so user data is untouched by these tests. */
function withSavedDiskState(fn: () => void): void {
	const existed = fs.existsSync(RELAY_STATE_FILE);
	const backup = existed ? fs.readFileSync(RELAY_STATE_FILE, "utf8") : "";
	try {
		fn();
	} finally {
		if (existed) {
			fs.writeFileSync(RELAY_STATE_FILE, backup);
		} else {
			fs.rmSync(RELAY_STATE_FILE, { force: true });
		}
	}
}

// ── getOrderedRelayUrls edge cases ────────────────────────────────────

test("getOrderedRelayUrls: 0 relays → []", () => {
	withSavedDiskState(() => {
		const state: RelayState = { enabled: true, url: "", relays: [] };
		setActiveRelayState(state, false);
		assert.deepEqual(getOrderedRelayUrls(), []);
	});
});

test("getOrderedRelayUrls: 1 relay healthy → [it]", () => {
	withSavedDiskState(() => {
		const url = "https://sole-relay.example.com";
		const state: RelayState = {
			enabled: true,
			url,
			relays: [{ url }],
		};
		setActiveRelayState(state, false);
		assert.deepEqual(getOrderedRelayUrls(), [url]);
	});
});

test("getOrderedRelayUrls: active relay cooling + others healthy → healthy first", () => {
	withSavedDiskState(() => {
		resetAllRelayHealth();
		const r1 = "https://cooling.example.com";
		const r2 = "https://healthy-a.example.com";
		const r3 = "https://healthy-b.example.com";
		const state: RelayState = {
			enabled: true,
			url: r1,
			relays: [{ url: r1 }, { url: r2 }, { url: r3 }],
		};
		setActiveRelayState(state, false);

		// Mark active relay (r1) as cooling
		markRelayFailure(r1, 503);
		assert.equal(isRelayHealthy(r1), false);

		const ordered = getOrderedRelayUrls();
		// Healthy r2 and r3 come first, then cooling r1 at tail
		assert.equal(ordered[0], r2, "healthy relay first");
		assert.equal(ordered[1], r3, "healthy relay second");
		assert.equal(ordered[2], r1, "cooling active at tail");

		resetAllRelayHealth();
	});
});

test("getOrderedRelayUrls: ALL relays cooling → still returns all (cooling tail)", () => {
	withSavedDiskState(() => {
		resetAllRelayHealth();
		const r1 = "https://down-a.example.com";
		const r2 = "https://down-b.example.com";
		const state: RelayState = {
			enabled: true,
			url: r1,
			relays: [{ url: r1 }, { url: r2 }],
		};
		setActiveRelayState(state, false);

		markRelayFailure(r1, 502);
		markRelayFailure(r2, 504);

		const ordered = getOrderedRelayUrls();
		// All cooling → cooling list returned (no healthy to partition in front)
		assert.equal(ordered.length, 2, "all cooling relays still returned");
		assert.ok(ordered.includes(r1), "r1 present");
		assert.ok(ordered.includes(r2), "r2 present");

		resetAllRelayHealth();
	});
});

// ── findRelay edge cases ──────────────────────────────────────────────

test("findRelay: empty relays → undefined", () => {
	const state: RelayState = { enabled: true, url: "", relays: [] };
	assert.equal(findRelay(state, 1), undefined);
	assert.equal(findRelay(state, "1"), undefined);
	assert.equal(findRelay(state, "anything"), undefined);
});

test("findRelay: index 0 → first relay", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://first.example.com",
		relays: [
			{ url: "https://first.example.com", label: "First" },
			{ url: "https://second.example.com" },
		],
	};
	assert.equal(findRelay(state, 0)?.url, "https://first.example.com");
	// 1-based still works
	assert.equal(findRelay(state, 1)?.url, "https://first.example.com");
});

test("findRelay: index out of range → undefined", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay.example.com",
		relays: [{ url: "https://relay.example.com" }],
	};
	assert.equal(findRelay(state, 2), undefined);
	assert.equal(findRelay(state, 99), undefined);
	assert.equal(findRelay(state, -1), undefined);
});

// ── setRelayLabel edge cases ──────────────────────────────────────────

test("setRelayLabel: unknown target → unchanged state", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay.example.com",
		relays: [{ url: "https://relay.example.com", label: "Original" }],
	};
	const result = setRelayLabel(state, "unknown-relay.example.com", "NewLabel");
	assert.equal(result, null);
	assert.equal(state.relays[0].label, "Original");
	assert.equal(state.relays.length, 1);
});

// ── ensureRelay edge cases ────────────────────────────────────────────

test("ensureRelay: duplicate URL → no duplicate added", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay.example.com",
		relays: [{ url: "https://relay.example.com" }],
	};
	ensureRelay(state, "https://relay.example.com", "another-label");
	assert.equal(state.relays.length, 1, "must not duplicate");
});

test("ensureRelay: empty label does not overwrite existing label", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay.example.com",
		relays: [{ url: "https://relay.example.com", label: "ExistingLabel" }],
	};
	// Empty string label
	ensureRelay(state, "https://relay.example.com", "");
	assert.equal(state.relays[0].label, "ExistingLabel", "empty label must not clear existing");

	// Whitespace-only label
	ensureRelay(state, "https://relay.example.com", "   ");
	assert.equal(state.relays[0].label, "ExistingLabel", "whitespace label must not clear existing");
});

test("ensureRelay: new relay with empty label → no label on relay", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://existing.example.com",
		relays: [{ url: "https://existing.example.com" }],
	};
	const r = ensureRelay(state, "https://new.example.com", "");
	assert.equal(r.label, undefined, "new relay with empty label must have no label");
	assert.equal(state.relays.length, 2);
});

test("ensureRelay: empty URL throws", () => {
	const state: RelayState = { enabled: true, url: "", relays: [] };
	assert.throws(() => ensureRelay(state, ""), /Relay URL cannot be empty/);
	assert.throws(() => ensureRelay(state, "   "), /Relay URL cannot be empty/);
});

// ── removeRelay edge cases ────────────────────────────────────────────

test("removeRelay: last remaining → empty list", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://only.example.com",
		relays: [{ url: "https://only.example.com" }],
	};
	removeRelay(state, "https://only.example.com");
	assert.deepEqual(state.relays, []);
});

// ── saveRelayState edge cases ─────────────────────────────────────────

test("saveRelayState: non-EPERM error → fails fast (1 attempt)", () => {
	withSavedDiskState(() => {
		const realRenameSync = fs.renameSync.bind(fs);
		const fsp = fs as unknown as { renameSync: (from: string, to: string) => void };
		let attempts = 0;
		fsp.renameSync = () => {
			attempts++;
			// Throw a non-Errno error (no errno code) — not retryable
			throw new Error("custom error without code");
		};
		try {
			assert.doesNotThrow(() =>
				saveRelayState({ enabled: true, url: "https://fast-fail.example.com", relays: [] }),
			);
			assert.equal(attempts, 1, "non-retryable error must not be retried");
		} finally {
			fsp.renameSync = realRenameSync;
		}
	});
});