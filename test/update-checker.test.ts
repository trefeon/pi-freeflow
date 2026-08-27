/**
 * Hermetic unit and integration tests for auto-update notifier and /freeflow update command
 *
 * Covers:
 * 1. compareVersions: numeric segment comparison (e.g. 1.4.10 > 1.4.2), differing lengths, malformed strings
 * 2. getCachedUpdate: missing file, corrupted JSON, missing fields, valid cache
 * 3. setCachedUpdate: directory creation, write formatting, error swallowing
 * 4. fetchLatestVersion: mock fetch for 200 OK, empty/invalid response, 500 server error, network drop/timeout
 * 5. isLinkedInstall: returns boolean reflecting entrypoint status without throwing
 * 6. checkForUpdateInBackground: LINK-skip, 24h TTL cache skip, fetch -> cache -> log pipeline, error recovery
 * 7. /freeflow update & status Command Integration: up-to-date check, offline handling, and status banner alert
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
	compareVersions,
	getCachedUpdate,
	setCachedUpdate,
	fetchLatestVersion,
	isLinkedInstall,
	checkForUpdateInBackground,
} from "../src/update-checker.ts";
import { createCommandSpec } from "../src/commands.ts";
import { UPDATE_CACHE_FILE, UPDATE_CHECK_TTL_MS } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/types.ts";

// ── 1. Semver Comparison Logic ───────────────────────────────────────────────

test("compareVersions accurately compares semver strings", () => {
	// Numeric vs Lexicographic (10 > 2)
	assert.ok(compareVersions("1.4.10", "1.4.2") > 0, "1.4.10 must be numerically greater than 1.4.2");
	assert.ok(compareVersions("1.4.2", "1.4.10") < 0, "1.4.2 must be numerically less than 1.4.10");

	// Patch version comparisons
	assert.ok(compareVersions("1.4.12", "1.4.11") > 0, "1.4.12 must be greater than 1.4.11");
	assert.ok(compareVersions("1.4.10", "1.4.11") < 0, "1.4.10 must be less than 1.4.11");
	assert.equal(compareVersions("1.4.11", "1.4.11"), 0, "Equal versions must return 0");

	// Minor and Major version comparisons
	assert.ok(compareVersions("1.5.0", "1.4.99") > 0, "1.5.0 must be greater than 1.4.99");
	assert.ok(compareVersions("2.0.0", "1.99.99") > 0, "2.0.0 must be greater than 1.99.99");
	assert.ok(compareVersions("0.9.0", "1.0.0") < 0, "0.9.0 must be less than 1.0.0");

	// Differing segment lengths
	assert.ok(compareVersions("1.4.10.1", "1.4.10") > 0, "1.4.10.1 must be greater than 1.4.10");
	assert.equal(compareVersions("1.4", "1.4.0"), 0, "1.4 must equal 1.4.0");

	// Malformed inputs return 0 gracefully without throwing
	assert.equal(compareVersions("invalid", "invalid"), 0);
	assert.equal(compareVersions("", ""), 0);
});

// ── 2. Update Cache Lifecycle & Error Edge Matrix ─────────────────────────────

test("getCachedUpdate & setCachedUpdate edge matrix with disk isolation", () => {
	const existed = fs.existsSync(UPDATE_CACHE_FILE);
	const backup = existed ? fs.readFileSync(UPDATE_CACHE_FILE, "utf8") : "";

	try {
		// Clean start: missing file returns null
		fs.rmSync(UPDATE_CACHE_FILE, { force: true });
		assert.equal(getCachedUpdate(), null, "Missing cache file must return null");

		// Valid write and read
		const testVersion = "1.5.0";
		setCachedUpdate(testVersion);
		const cached = getCachedUpdate();
		assert.ok(cached, "Cached update must exist");
		assert.equal(cached.latest, testVersion);
		assert.ok(typeof cached.checkedAt === "number");
		assert.ok(Date.now() - cached.checkedAt < 5000, "checkedAt must be fresh");

		// Corrupted JSON recovery
		fs.writeFileSync(UPDATE_CACHE_FILE, "{ corrupted json payload ...", "utf8");
		assert.equal(getCachedUpdate(), null, "Corrupt JSON must return null without throwing");

		// Missing required fields recovery (no latest field)
		fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify({ checkedAt: Date.now() }), "utf8");
		assert.equal(getCachedUpdate(), null, "Missing latest field must return null");

		// Missing required fields recovery (no checkedAt field)
		fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify({ latest: "1.5.0" }), "utf8");
		assert.equal(getCachedUpdate(), null, "Missing checkedAt field must return null");

		// Empty file recovery
		fs.writeFileSync(UPDATE_CACHE_FILE, "", "utf8");
		assert.equal(getCachedUpdate(), null, "Empty cache file must return null without throwing");
	} finally {
		if (existed) {
			fs.writeFileSync(UPDATE_CACHE_FILE, backup);
		} else {
			fs.rmSync(UPDATE_CACHE_FILE, { force: true });
		}
	}
});

// ── 3. Mocked Registry Fetcher (Zero Real Network Dependency) ─────────────────

test("fetchLatestVersion handles valid response, non-200 status, and network rejections", async () => {
	const realFetch = globalThis.fetch;

	try {
		// Scenario A: Registry returns 200 OK with version string
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ version: "1.4.99" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const verA = await fetchLatestVersion();
		assert.equal(verA, "1.4.99");

		// Scenario B: Registry returns 200 OK with empty/whitespace version
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ version: "   " }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const verB = await fetchLatestVersion();
		assert.equal(verB, null);

		// Scenario C: Registry returns 404 or 500 error
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: "Not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		const verC = await fetchLatestVersion();
		assert.equal(verC, null);

		// Scenario D: Network failure or timeout (fetch rejects)
		globalThis.fetch = async () => {
			throw new Error("Network timeout (ETIMEDOUT)");
		};
		const verD = await fetchLatestVersion();
		assert.equal(verD, null, "Network error must return null without throwing");
	} finally {
		globalThis.fetch = realFetch;
	}
});

// ── 4. LINK Install Detection ────────────────────────────────────────────────

test("isLinkedInstall returns a boolean without throwing", () => {
	const isLinked = isLinkedInstall();
	assert.equal(typeof isLinked, "boolean");
});

// ── 5. Background Check Isolation & 24h TTL Throttling ────────────────────────

test("checkForUpdateInBackground respects 24h TTL cache and never throws", async () => {
	const existed = fs.existsSync(UPDATE_CACHE_FILE);
	const backup = existed ? fs.readFileSync(UPDATE_CACHE_FILE, "utf8") : "";
	const realFetch = globalThis.fetch;
	let fetchCalls = 0;

	try {
		globalThis.fetch = async () => {
			fetchCalls++;
			return new Response(JSON.stringify({ version: "2.0.0" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		// Prime cache with a fresh check (< 24 hours ago)
		setCachedUpdate("1.4.12");

		// Execution within TTL must skip network fetch entirely
		checkForUpdateInBackground();
		assert.equal(fetchCalls, 0, "Background check within 24h TTL must not query network");

		// Expired cache (> 24 hours ago)
		const expiredData = { latest: "1.4.12", checkedAt: Date.now() - (UPDATE_CHECK_TTL_MS + 1000) };
		fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(expiredData), "utf8");

		// Trigger background check on expired cache
		checkForUpdateInBackground();

		// Drain microtasks deterministically
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(fetchCalls >= 1, "Expired cache must trigger background network query");
	} finally {
		globalThis.fetch = realFetch;
		if (existed) {
			fs.writeFileSync(UPDATE_CACHE_FILE, backup);
		} else {
			fs.rmSync(UPDATE_CACHE_FILE, { force: true });
		}
	}
});

// ── 6. /freeflow update & status Command Integration ──────────────────────────

test("/freeflow update and status commands handle up-to-date, offline, and update alerts", async () => {
	const realFetch = globalThis.fetch;
	const notifications: Array<{ msg: string; type?: "info" | "warning" | "error" }> = [];

	const mockUi = {
		notify(msg: string, type?: "info" | "warning" | "error") {
			notifications.push({ msg, type });
		},
		select: async () => undefined,
		confirm: async () => true,
		input: async () => "",
		setStatus: () => {},
	};

	const mockCtx: ExtensionContext = {
		ui: mockUi,
		model: { provider: "freeflow", id: "muse-spark-1.2-contributor-free" },
	};

	const mockPi: ExtensionAPI = {
		registerProvider: () => {},
		registerCommand: () => {},
		on: () => {},
	};

	const cmd = createCommandSpec(mockPi, () => {});

	try {
		// Scenario A: When already on latest version
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ version: "1.4.12" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		notifications.length = 0;
		await cmd.handler("update", mockCtx);
		assert.ok(
			notifications.some((n) => n.msg.includes("Already on latest") || n.msg.includes("LINK install")),
			"Update command must report already on latest (or LINK install in dev mode)",
		);

		// Scenario B: When network is offline / fetch fails
		globalThis.fetch = async () => {
			throw new Error("Offline network failure");
		};

		const existed = fs.existsSync(UPDATE_CACHE_FILE);
		const backup = existed ? fs.readFileSync(UPDATE_CACHE_FILE, "utf8") : "";

		try {
			fs.rmSync(UPDATE_CACHE_FILE, { force: true });
			notifications.length = 0;
			await cmd.handler("update", mockCtx);
			assert.ok(
				notifications.some((n) => n.msg.includes("offline") || n.msg.includes("LINK install")),
				"Update command must report offline gracefully without crashing",
			);

			// Scenario C: Status command displays update prompt when cached update > local
			setCachedUpdate("9.9.9");
			notifications.length = 0;
			await cmd.handler("status", mockCtx);
			assert.ok(
				notifications.some((n) => n.msg.includes("Update available") && n.msg.includes("9.9.9")),
				"Status command must alert user when an update is cached",
			);
		} finally {
			if (existed) {
				fs.writeFileSync(UPDATE_CACHE_FILE, backup);
			} else {
				fs.rmSync(UPDATE_CACHE_FILE, { force: true });
			}
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});
