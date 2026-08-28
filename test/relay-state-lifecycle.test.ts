/**
 * Relay state lifecycle validation: new user (fresh install) vs old user
 * (has saved relays), covering the .bak wipe-protection contract.
 *
 * Each test starts from a fully cleared disk (both main and .bak removed)
 * and sets up exactly the state it needs, so results never depend on the
 * user's real state file or on test execution order.
 *
 * New user:
 *  - no state file, no backup -> clean default state (empty pool = direct mode)
 *  - first save creates the file without touching a backup
 *  - resolveRelayState returns a stable empty state without throwing
 *
 * Old user:
 *  - saved relays survive a normal load
 *  - saveRelayState keeps a .bak snapshot before overwriting
 *  - corrupt main file -> recovered from .bak
 *  - valid-but-empty main (wipe aftermath) -> recovered from .bak
 *  - an empty save lands on disk (no silent abort), and with a .bak present
 *    the relays are recovered on the next load
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_RELAY_URL, RELAY_STATE_FILE } from "../src/config.ts";
import {
	loadRelayState,
	resolveRelayState,
	saveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

/** Remove both main and .bak so a test starts from a clean slate. */
function clearRelayFiles(): void {
	for (const p of [RELAY_STATE_FILE, BAK_FILE]) {
		try {
			fs.rmSync(p, { force: true });
		} catch {}
	}
}

/** Isolate both main and .bak disk files for the duration of a test. */
function withIsolatedRelayFiles(fn: () => void): void {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(BAK_FILE);
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
		restore(BAK_FILE, bakBefore);
	}
}

/** Write a valid state with the given relays and active url to the main file. */
function writeState(url: string, relays: Array<{ url: string; label?: string }>): void {
	fs.writeFileSync(
		RELAY_STATE_FILE,
		JSON.stringify({ mode: "auto", enabled: true, url, relays }),
		"utf8",
	);
}

const BAK_STATE = {
	mode: "on",
	enabled: true,
	url: "https://bak.example.com",
	relays: [{ url: "https://bak.example.com" }],
};

// ── New user ──────────────────────────────────────────────────────────────

test("new user: no state file and no backup yields the clean default state", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		const s = loadRelayState();
		assert.equal(s.mode, "auto");
		assert.equal(s.enabled, true);
		assert.equal(s.url, DEFAULT_RELAY_URL);
		assert.deepEqual(s.relays, []);
	});
});

test("new user: first save creates the state file without creating a backup", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		saveRelayState({
			mode: "auto",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com" }],
		});
		assert.ok(fs.existsSync(RELAY_STATE_FILE), "first save must create the state file");
		assert.equal(fs.existsSync(BAK_FILE), false, "first save has nothing to back up");
		const onDisk = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		assert.equal(onDisk.relays.length, 1);
		assert.equal(onDisk.relays[0].url, "https://relay1.example.com");
	});
});

test("new user: resolveRelayState returns a stable empty state (direct mode)", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		const s = resolveRelayState();
		assert.deepEqual(s.relays, [], "empty pool means direct mode — no relay deployed yet");
		assert.equal(s.url, DEFAULT_RELAY_URL);
		assert.equal(s.enabled, true);
	});
});

// ── Old user ──────────────────────────────────────────────────────────────

test("old user: saved relays survive a normal load", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		writeState("https://relay1.example.com", [
			{ url: "https://relay1.example.com", label: "primary" },
			{ url: "https://relay2.example.com" },
		]);
		const loaded = loadRelayState();
		assert.equal(loaded.relays.length, 2);
		assert.equal(loaded.relays[0].url, "https://relay1.example.com");
		assert.equal(loaded.url, "https://relay1.example.com");
	});
});

test("old user: saveRelayState keeps a .bak snapshot before overwriting", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		const first: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com" }],
		};
		saveRelayState(first);
		assert.equal(fs.existsSync(BAK_FILE), false, "no backup after the very first save");

		const second: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay2.example.com",
			relays: [
				{ url: "https://relay1.example.com" },
				{ url: "https://relay2.example.com" },
			],
		};
		saveRelayState(second);
		assert.ok(fs.existsSync(BAK_FILE), "backup must exist after the second save");
		const bak = JSON.parse(fs.readFileSync(BAK_FILE, "utf8"));
		assert.equal(bak.relays.length, 1, "backup holds the pre-overwrite snapshot");
		assert.equal(bak.url, "https://relay1.example.com");
	});
});

test("old user: corrupt main file is recovered from .bak", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		fs.writeFileSync(BAK_FILE, JSON.stringify(BAK_STATE), "utf8");
		fs.writeFileSync(RELAY_STATE_FILE, "!!! not valid json !!!", "utf8");
		const recovered = loadRelayState();
		assert.equal(recovered.relays.length, 1, "corrupt main must not wipe saved relays");
		assert.equal(recovered.url, "https://bak.example.com");
		assert.equal(recovered.mode, "on");
	});
});

test("old user: valid-but-empty main (wipe aftermath) is recovered from .bak", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		fs.writeFileSync(BAK_FILE, JSON.stringify(BAK_STATE), "utf8");
		writeState("", []);
		const recovered = loadRelayState();
		assert.equal(
			recovered.relays.length,
			1,
			"a valid-but-empty main must not hide relays that .bak still holds",
		);
		assert.equal(recovered.url, "https://bak.example.com");
	});
});

test("wipe protection: an empty save lands on disk but relays survive the next load via .bak", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		const real: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://r1.example.com",
			relays: [
				{ url: "https://r1.example.com" },
				{ url: "https://r2.example.com" },
			],
		};
		saveRelayState(real);
		saveRelayState(real); // second save snapshots .bak
		assert.ok(fs.existsSync(BAK_FILE));

		// Simulate the wipe: an empty pool persisted over real relays.
		saveRelayState({ mode: "auto", enabled: true, url: "", relays: [] });
		const onDisk = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		assert.deepEqual(onDisk.relays, [], "empty save must persist, never be silently refused");

		// Next load must recover the relays from .bak — data loss is permanent only
		// when there was no .bak to begin with.
		const recovered = loadRelayState();
		assert.equal(recovered.relays.length, 2, "relays must be recovered after the wipe");
		assert.equal(recovered.relays[0].url, "https://r1.example.com");
	});
});

test("remove-last-relay contract: empty pool save is not blocked and persists", () => {
	withIsolatedRelayFiles(() => {
		clearRelayFiles();
		// Main already empty (e.g. after a previous removal) and no .bak:
		// saving the empty pool must persist, never be silently aborted.
		writeState("", []);
		saveRelayState({ mode: "auto", enabled: true, url: "", relays: [] });
		const onDisk = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		assert.deepEqual(onDisk.relays, [], "removal must persist to disk");
		assert.equal(fs.existsSync(BAK_FILE), false, "empty main must not spawn a backup");
		const loaded = loadRelayState();
		assert.deepEqual(loaded.relays, [], "without a .bak, the empty pool stays empty");
	});
});
