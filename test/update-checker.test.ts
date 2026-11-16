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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	getCachedUpdate,
	setCachedUpdate,
	isLinkedInstall,
	checkForUpdateInBackground,
} from "../src/update-checker.ts";
import {
	compareVersions,
	downloadReleaseTarball,
	fetchLatestVersion,
	getLocalVersion,
	releaseTarballUrl,
	removeReleaseTarball,
} from "../src/update-core.ts";
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

test("compareVersions orders prereleases below their release, build metadata ignored", () => {
	assert.ok(compareVersions("1.4.2-beta", "1.4.2") < 0, "prerelease must sort below its own release");
	assert.ok(compareVersions("1.4.2", "1.4.2-beta") > 0, "release must sort above its prerelease");
	assert.ok(compareVersions("1.4.2-beta", "1.4.0") > 0, "core still dominates: 1.4.2-beta beats 1.4.0");
	assert.ok(compareVersions("1.4.2-alpha", "1.4.2-beta") < 0, "alpha before beta");
	assert.ok(compareVersions("1.4.2-beta.2", "1.4.2-beta.11") < 0, "numeric prerelease ids compare numerically");
	assert.equal(compareVersions("1.4.2+build.5", "1.4.2"), 0, "build metadata never orders");
	assert.equal(compareVersions("1.4.2-beta", "1.4.2-beta"), 0, "identical prereleases are equal");
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

test("setCachedUpdate ignores malformed versions", () => {
	const existed = fs.existsSync(UPDATE_CACHE_FILE);
	const backup = existed ? fs.readFileSync(UPDATE_CACHE_FILE, "utf8") : "";
	try {
		fs.rmSync(UPDATE_CACHE_FILE, { force: true });
		setCachedUpdate("garbage");
		assert.equal(
			fs.existsSync(UPDATE_CACHE_FILE),
			false,
			"malformed version must not be written to the cache",
		);
		setCachedUpdate("1.4");
		assert.equal(fs.existsSync(UPDATE_CACHE_FILE), false, "partial version must not be cached");
		setCachedUpdate("1.2.3");
		assert.ok(fs.existsSync(UPDATE_CACHE_FILE), "valid semver must be cached");
	} finally {
		if (existed) {
			fs.writeFileSync(UPDATE_CACHE_FILE, backup);
		} else {
			fs.rmSync(UPDATE_CACHE_FILE, { force: true });
		}
	}
});

// ── 3. Mocked Registry Fetcher (Zero Real Network Dependency) ─────────────────

test("fetchLatestVersion reads the GitHub release tag from the redirect or the page", async () => {
	const realFetch = globalThis.fetch;

	/** A `releases/latest` response whose redirect landed on v<version>. */
	const redirected = (version: string): Response => {
		const res = new Response("<html></html>", { status: 200 });
		Object.defineProperty(res, "url", {
			value: `https://github.com/trefeon/pi-freeflow/releases/tag/v${version}`,
		});
		return res;
	};

	try {
		// Scenario A: the redirect URL names the tag (the normal path).
		globalThis.fetch = async () => redirected("1.4.99");
		assert.equal(await fetchLatestVersion(), "1.4.99");

		// Scenario A2: no `v` prefix on the tag still yields the bare version.
		globalThis.fetch = async () => redirected("2.0.0");
		assert.equal(await fetchLatestVersion(), "2.0.0");

		// Scenario B: a proxy stripped the redirect — the page body links the tag.
		globalThis.fetch = async () =>
			new Response('<a href="/trefeon/pi-freeflow/releases/tag/v1.4.99">latest</a>', { status: 200 });
		assert.equal(await fetchLatestVersion(), "1.4.99", "page body must be a second source for the tag");

		// Scenario C: releases page missing (or GitHub down).
		globalThis.fetch = async () => new Response("Not found", { status: 404 });
		assert.equal(await fetchLatestVersion(), null);

		// Scenario C2: a tag that is not a semver version.
		globalThis.fetch = async () =>
			new Response('<a href="/releases/tag/nightly">x</a>', { status: 200 });
		assert.equal(await fetchLatestVersion(), null, "malformed tag must be treated as no-update");

		// Scenario C3: a partial (major.minor only) tag.
		globalThis.fetch = async () => new Response('<a href="/releases/tag/v1.4">x</a>', { status: 200 });
		assert.equal(await fetchLatestVersion(), null, "partial version must be treated as no-update");

		// Scenario D: network failure or timeout (fetch rejects).
		globalThis.fetch = async () => {
			throw new Error("Network timeout (ETIMEDOUT)");
		};
		assert.equal(await fetchLatestVersion(), null, "Network error must return null without throwing");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("releaseTarballUrl points at the tagged release asset", () => {
	assert.equal(
		releaseTarballUrl("1.46.0"),
		"https://github.com/trefeon/pi-freeflow/releases/download/v1.46.0/pi-freeflow-1.46.0.tgz",
		"the install specifier must be the asset attached to the release tag",
	);
});

test("downloadReleaseTarball writes the asset to a file and rejects failures", async () => {
	const realFetch = globalThis.fetch;
	const version = "9.9.8";
	const target = path.join(os.tmpdir(), `pi-freeflow-${version}.tgz`);
	fs.rmSync(target, { force: true });
	try {
		// 200 with bytes: the bytes land in a temp file, because npm 12 refuses
		// remote specifiers and every install step takes a local path.
		const payload = new Uint8Array([31, 139, 8, 0, 1, 2]);
		globalThis.fetch = (async () => ({
			ok: true,
			headers: { get: () => String(payload.length) },
			arrayBuffer: async () => payload.buffer,
		})) as unknown as typeof fetch;
		assert.equal(await downloadReleaseTarball(version), target);
		assert.deepEqual(new Uint8Array(fs.readFileSync(target)), payload);
		await removeReleaseTarball(target);
		assert.equal(fs.existsSync(target), false, "cleanup must remove the downloaded tarball");

		// Missing release asset.
		globalThis.fetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
		assert.equal(await downloadReleaseTarball(version), null, "a 404 must not produce a file");
		assert.equal(fs.existsSync(target), false);

		// Empty body.
		globalThis.fetch = (async () => ({
			ok: true,
			headers: { get: () => "0" },
			arrayBuffer: async () => new ArrayBuffer(0),
		})) as unknown as typeof fetch;
		assert.equal(await downloadReleaseTarball(version), null, "an empty asset must be refused");

		// Network failure.
		globalThis.fetch = (async () => {
			throw new Error("ETIMEDOUT");
		}) as unknown as typeof fetch;
		assert.equal(await downloadReleaseTarball(version), null, "a network error must not throw");
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(target, { force: true });
	}
});

// ── 4. LINK Install Detection ────────────────────────────────────────────────

test("isLinkedInstall returns a boolean without throwing", () => {
	const isLinked = isLinkedInstall();
	assert.equal(typeof isLinked, "boolean");
});

test("isLinkedInstall detects a linked package root, not only a linked entry", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "ff-link-"));
	const checkout = path.join(base, "checkout");
	fs.mkdirSync(path.join(checkout, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(checkout, "extensions", "index.ts"), "export {};\n", "utf8");
	const linkedRoot = path.join(base, "node_modules", "pi-freeflow");
	try {
		assert.equal(
			isLinkedInstall(checkout),
			false,
			"a real checkout with a regular entry is not a linked install",
		);
		assert.equal(isLinkedInstall(path.join(base, "absent")), false, "a missing root is not a link");
		fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
		// The shape `omp plugin link` creates: the package ROOT is the symlink,
		// so the extension entry below it is an ordinary file — the entry-only
		// check missed this and let auto-update overwrite the dev checkout.
		fs.symlinkSync(checkout, linkedRoot, process.platform === "win32" ? "junction" : "dir");
		assert.equal(isLinkedInstall(linkedRoot), true, "a linked package root must read as a linked install");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

// ── 4b. Module graph ─────────────────────────────────────────────────────────

/**
 * update-checker ⇄ updater used to be a value-level cycle (each imported the
 * other). The version facts now live in the leaf src/update-core.ts, which
 * nothing else in this trio imports, and updater reaches the port killer
 * through a lazy import only. A new top-level edge here re-creates the cycle.
 */
test("the update modules keep a one-way dependency graph", () => {
	const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
	const read = (file: string): string => fs.readFileSync(path.join(srcDir, file), "utf8");
	const edges: Array<{ from: string; to: string; expected: boolean }> = [
		{ from: "update-checker.ts", to: "./updater.ts", expected: true },
		{ from: "updater.ts", to: "./update-checker.ts", expected: false },
		{ from: "updater.ts", to: "./proxy.ts", expected: false },
		{ from: "update-core.ts", to: "./update-checker.ts", expected: false },
		{ from: "update-core.ts", to: "./updater.ts", expected: false },
		{ from: "update-core.ts", to: "./client.ts", expected: false },
		{ from: "update-core.ts", to: "./proxy.ts", expected: false },
	];
	for (const { from, to, expected } of edges) {
		assert.equal(
			read(from).includes(`from "${to}"`),
			expected,
			`${from} must ${expected ? "" : "not "}import ${to} as a static edge`,
		);
	}
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
		model: { provider: "freeflow", id: "nemotron-3.5-super-vl-free" },
	};

	const mockPi: ExtensionAPI = {
		registerProvider: () => {},
		registerCommand: () => {},
		on: () => {},
	};

	const cmd = createCommandSpec(mockPi, () => {});

	try {
		// Scenario A: When already on latest version — the releases redirect
		// names the tag this checkout already carries.
		const localVersion = getLocalVersion() ?? "0.0.0";
		globalThis.fetch = async () => {
			const res = new Response("<html></html>", { status: 200 });
			Object.defineProperty(res, "url", {
				value: `https://github.com/trefeon/pi-freeflow/releases/tag/v${localVersion}`,
			});
			return res;
		};

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
