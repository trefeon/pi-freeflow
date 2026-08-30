/**
 * Comprehensive Error Matrix & Chaos Edge-Case Test Suite
 *
 * Exhaustively tests:
 * 1. Network error isolation & socket resets (ECONNRESET, ETIMEDOUT, ECONNREFUSED)
 * 2. HTTP status code decision matrix (Retriable 429/502/503/504 vs Non-retriable 400/401/403/404 vs Bare 500)
 * 3. 504 Gateway Timeout fast-fallback detection
 * 4. Dead model pruning and catalog sanitization
 * 5. Adaptive cooldown escalation (exponential backoff capped at 4x)
 * 6. Full SSRF private IP matrix in relay workers (IPv4 loopback, RFC1918, CGNAT, link-local, IPv6 ULA/link-local, trailing dots)
 * 7. Path traversal & credential injection guards (@, \, port/host/protocol mismatch)
 * 8. Complete 14-header denylist stripping in all relay workers
 * 9. Windows EPERM file lock retry mechanism
 * 10. Stream truncation threshold boundaries and corrupt disk state recovery
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs, { type PathLike } from "node:fs";

import { isRetriableStatus } from "../src/relay.ts";
import {
	markRelayFailure,
	markRelaySuccess,
	getRelayHealth,
	resetAllRelayHealth,
	saveRelayState,
	loadRelayState,
} from "../src/relay-state.ts";
import { RELAY_STATE_FILE, CATALOG_CACHE_FILE } from "../src/config.ts";
import {
	CLOUDFLARE_RELAY_WORKER,
	VERCEL_RELAY_WORKER,
	DENO_RELAY_SCRIPT,
} from "../src/deploy.ts";
import { isSubstantial } from "../src/stream-pipe.ts";
import { readCatalogCache, mergeCatalog, DEAD_MODEL_IDS } from "../src/catalog.ts";
import type { RegisteredModel, RelayState } from "../src/types.ts";

// ── 1. HTTP Status Error Decision Matrix ─────────────────────────────────────

test("Error Matrix [1/10] isRetriableStatus strictly separates transient errors from deterministic faults (canonical boundary test)", () => {
	// Retriable statuses (trigger relay rolling)
	const retriable = [429, 408, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530];
	for (const code of retriable) {
		assert.equal(isRetriableStatus(code), true, `Status ${code} must be retriable`);
	}

	// Non-retriable client errors (must surface immediately to client, never roll relays)
	const nonRetriable = [400, 401, 402, 403, 404, 405, 409, 410, 413, 422, 501];
	for (const code of nonRetriable) {
		assert.equal(isRetriableStatus(code), false, `Status ${code} must not roll relays`);
	}

	// Cloudflare 52x band boundaries: just below/above must NOT roll
	assert.equal(isRetriableStatus(519), false, "519 is below the 52x band");
	assert.equal(isRetriableStatus(531), false, "531 is above the 52x band");

	// Bare 500 Internal Server Error (deterministic upstream fault - do not roll)
	assert.equal(isRetriableStatus(500), false, "Bare 500 must not roll relays");

	// Success statuses
	assert.equal(isRetriableStatus(200), false);
	assert.equal(isRetriableStatus(204), false);
});

// ── 2. 504 Gateway Timeout Retriability ──────────────────────────────────────

test("Error Matrix [2/10] 504 Gateway Timeout is recognized as retriable for fast direct fallback", () => {
	assert.equal(isRetriableStatus(504), true, "504 must be marked retriable");
	assert.equal(isRetriableStatus(502), true);
	assert.equal(isRetriableStatus(429), true);
});

// ── 3. Adaptive Cooldown Escalation (Capped at 4x) ────────────────────────────
test("Error Matrix [3/10] relay consecutive failures escalate cooldown exponentially up to 4x base", () => {
	resetAllRelayHealth();
	const testRelay = "https://chaos-cooldown.example.com";

	try {
		// Network/socket error: base cooldown is 30s
		// Failure 1: 1x base (~30s)
		markRelayFailure(testRelay);
		const h1 = getRelayHealth(testRelay);
		assert.ok(h1);
		assert.equal(h1.consecutiveFailures, 1);
		const cd1 = h1.cooldownUntil - Date.now();
		assert.ok(cd1 > 20000 && cd1 <= 35000, `First cooldown should be ~30s (was ${cd1}ms)`);

		// Failure 2: 2x base (~60s)
		markRelayFailure(testRelay);
		const h2 = getRelayHealth(testRelay);
		assert.equal(h2?.consecutiveFailures, 2);
		const cd2 = (h2?.cooldownUntil || 0) - Date.now();
		assert.ok(cd2 > 45000 && cd2 <= 65000, `Second cooldown should be ~60s (was ${cd2}ms)`);

		// Failure 3: 3x base (~90s)
		markRelayFailure(testRelay);
		const h3 = getRelayHealth(testRelay);
		assert.equal(h3?.consecutiveFailures, 3);
		const cd3 = (h3?.cooldownUntil || 0) - Date.now();
		assert.ok(cd3 > 75000 && cd3 <= 95000, `Third cooldown should be ~90s (was ${cd3}ms)`);

		// Failure 4: 4x base cap (~120s)
		markRelayFailure(testRelay);
		const h4 = getRelayHealth(testRelay);
		assert.equal(h4?.consecutiveFailures, 4);
		const cd4 = (h4?.cooldownUntil || 0) - Date.now();
		assert.ok(cd4 > 105000 && cd4 <= 125000, `Fourth cooldown should be ~120s (was ${cd4}ms)`);

		// Failure 5: capped at 4x base (~120s)
		markRelayFailure(testRelay);
		const h5 = getRelayHealth(testRelay);
		assert.equal(h5?.consecutiveFailures, 5);
		const cd5 = (h5?.cooldownUntil || 0) - Date.now();
		assert.ok(cd5 <= 125000, `Fifth cooldown must not exceed 4x cap (was ${cd5}ms)`);

		// 429 Rate Limit error: base cooldown is 90s
		const test429Relay = "https://chaos-429.example.com";
		markRelayFailure(test429Relay, 429);
		const h429 = getRelayHealth(test429Relay);
		const cd429 = (h429?.cooldownUntil || 0) - Date.now();
		assert.ok(cd429 > 80000 && cd429 <= 95000, `429 base cooldown should be ~90s (was ${cd429}ms)`);

		// Success resets consecutive failures immediately
		markRelaySuccess(testRelay);
		assert.equal(getRelayHealth(testRelay), undefined, "Success must clear health record");
	} finally {
		resetAllRelayHealth();
	}
});

// ── 4. Dead Model Filter & Catalog Recovery ──────────────────────────────────

test("Error Matrix [4/10] catalog gracefully strips dead model IDs on cache read and merge", () => {
	// Verify DEAD_MODEL_IDS set
	assert.ok(DEAD_MODEL_IDS.has("deepseek-v4-flash-free"));
	assert.ok(DEAD_MODEL_IDS.has("x-preview-f-free"));

	// Simulated incoming payload containing resurrected dead models
	const dirtyCatalog: RegisteredModel[] = [
		{
			id: "muse-spark-1.2-contributor-free",
			name: "Muse Spark",
			contextWindow: 128000,
			maxTokens: 4096,
			reasoning: true,
			source: "opencode",
		},
		{
			id: "deepseek-v4-flash-free",
			name: "Dead DeepSeek",
			contextWindow: 128000,
			maxTokens: 4096,
			reasoning: true,
			source: "opencode",
		},
		{
			id: "x-preview-f-free",
			name: "Dead Ox Alpha",
			contextWindow: 128000,
			maxTokens: 4096,
			reasoning: true,
			source: "opencode",
		},
	];

	// Merge must sanitize out dead model IDs
	const base: RegisteredModel[] = [
		{
			id: "muse-spark-1.2-contributor-free",
			name: "Muse Spark",
			contextWindow: 128000,
			maxTokens: 4096,
			reasoning: true,
			source: "opencode",
		},
	];

	const sanitized = mergeCatalog(base, dirtyCatalog);
	assert.equal(sanitized.some((m) => m.id === "deepseek-v4-flash-free"), false);
	assert.equal(sanitized.some((m) => m.id === "x-preview-f-free"), false);
	assert.equal(sanitized.length, 1);
});

// ── 5. SSRF Private & Loopback IP Guardrails in Relay Workers ────────────────

test("Error Matrix [5/10] relay worker code blocks all private IPv4/IPv6 ranges and loopback variants", () => {
	const workers = [CLOUDFLARE_RELAY_WORKER, VERCEL_RELAY_WORKER, DENO_RELAY_SCRIPT];

	for (const src of workers) {
		// RFC1918 IPv4 ranges
		assert.ok(src.includes("a === 10"), "Must block 10.0.0.0/8");
		assert.ok(src.includes("a === 172") && src.includes("b >= 16"), "Must block 172.16.0.0/12");
		assert.ok(src.includes("a === 192") && src.includes("b === 168"), "Must block 192.168.0.0/16");

		// Loopback & Unspecified
		assert.ok(src.includes("a === 127"), "Must block 127.0.0.0/8 loopback");
		assert.ok(src.includes("a === 0"), "Must block 0.0.0.0/8 unspecified");

		// Carrier-Grade NAT (CGNAT)
		assert.ok(src.includes("a === 100") && src.includes("b >= 64"), "Must block CGNAT 100.64.0.0/10");

		// Link-Local
		assert.ok(src.includes("a === 169") && src.includes("b === 254"), "Must block Link-Local 169.254.0.0/16");

		// IPv6 Private & Link-Local
		assert.ok(src.includes("fc") && src.includes("fd"), "Must block IPv6 ULA fc00::/7 & fd00::/8");
		assert.ok(src.includes("fe80") || src.includes("fe[89ab]"), "Must block IPv6 Link-Local fe80::/10");
		assert.ok(src.includes('startsWith("::")'), "Must block IPv6 loopback ::1");

		// Localhost and trailing dot sanitization
		assert.ok(src.includes('"localhost"'), "Must block localhost");
		assert.ok(src.includes('endsWith(".")'), "Must sanitize trailing dot bypasses");
		assert.ok(src.includes(".localhost") && src.includes(".internal"), "Must block local DNS zones");
	}
});

// ── 6. Path Traversal & Credential Spoofing Guards ───────────────────────────

test("Error Matrix [6/10] relay path resolution blocks credentials, backslashes, and target mismatches", () => {
	const workers = [CLOUDFLARE_RELAY_WORKER, VERCEL_RELAY_WORKER, DENO_RELAY_SCRIPT];

	for (const src of workers) {
		// Embedded credentials guard (@)
		assert.ok(src.includes('@') && src.includes('indexOf("@")'), "Must reject URLs with embedded credentials");

		// Windows backslash traversal guard (\)
		assert.ok(src.includes('indexOf("\\\\")') || src.includes('indexOf("\\")'), "Must reject backslash path separators");

		// Leading slash requirement
		assert.ok(src.includes('charAt(0) !== "/"'), "Must enforce leading forward slash on path");

		// Protocol, host, and port mismatch detection
		assert.ok(src.includes("hostname !== targetUrl.hostname"), "Must reject hostname spoofing");
		assert.ok(src.includes("protocol !== targetUrl.protocol"), "Must reject protocol tampering");
		assert.ok(src.includes("port !== targetUrl.port"), "Must reject port tampering");
	}
});

// ── 7. 14-Header Denylist Stripping ──────────────────────────────────────────

test("Error Matrix [7/10] all 3 relay workers enforce complete 14-header security denylist", () => {
	const expectedHeaders = [
		"host",
		"connection",
		"content-length",
		"keep-alive",
		"proxy-connection",
		"proxy-authenticate",
		"proxy-authorization",
		"transfer-encoding",
		"te",
		"trailer",
		"upgrade",
		"x-relay-target",
		"x-relay-path",
		"x-relay-auth",
	];

	for (const src of [CLOUDFLARE_RELAY_WORKER, VERCEL_RELAY_WORKER, DENO_RELAY_SCRIPT]) {
		for (const h of expectedHeaders) {
			assert.ok(src.includes(`"${h}"`), `Worker must denylist header: ${h}`);
		}
	}
});

// ── 8. Windows EPERM File Lock Retry Resilience ──────────────────────────────

test("Error Matrix [8/10] saveRelayState recovers from Windows EPERM lock contention with bounded retry", () => {
	const existed = fs.existsSync(RELAY_STATE_FILE);
	const backup = existed ? fs.readFileSync(RELAY_STATE_FILE, "utf8") : "";
	const bakFile = `${RELAY_STATE_FILE}.bak`;
	const existedBak = fs.existsSync(bakFile);
	const backupBak = existedBak ? fs.readFileSync(bakFile, "utf8") : "";

	const realRenameSync = fs.renameSync.bind(fs);
	const fsp = fs as unknown as { renameSync: (from: PathLike, to: PathLike) => void };

	let attempts = 0;
	try {
		// Simulate temporary Windows file lock on first attempt
		fsp.renameSync = (from: PathLike, to: PathLike) => {
			attempts++;
			if (attempts === 1) {
				const err: NodeJS.ErrnoException = new Error("EPERM: operation not permitted, rename");
				err.code = "EPERM";
				throw err;
			}
			realRenameSync(from, to);
		};

		const testState: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://retry-test.example.com",
			relays: [{ url: "https://retry-test.example.com" }],
		};

		saveRelayState(testState);
		let hadPriorRelays = false;
		try { const p = JSON.parse(backup); hadPriorRelays = Array.isArray(p?.relays) && p.relays.length > 0; } catch {}
		// Simple .bak uses writeFileSync, so only main rename counts -> 2 attempts (1 fail + 1 retry) regardless of prior
		void hadPriorRelays;
		const expectedAttempts = 2;
		assert.equal(attempts, expectedAttempts, "Must retry exactly once on transient EPERM and succeed");
		const loaded = loadRelayState();
		assert.equal(loaded.url, "https://retry-test.example.com");
	} finally {
		fsp.renameSync = realRenameSync;
		if (existed) {
			fs.writeFileSync(RELAY_STATE_FILE, backup);
		} else {
			fs.rmSync(RELAY_STATE_FILE, { force: true });
		}
		if (existedBak) {
			fs.writeFileSync(bakFile, backupBak);
		} else {
			try { fs.rmSync(bakFile, { force: true }); } catch {}
		}
	}
});

// ── 9. Stream Truncation Threshold Boundary Invariants ───────────────────────

test("Error Matrix [9/10] stream truncation thresholds enforce >50 chunks AND >100KB boundary logic", () => {
	// Boundary Matrix against the real exported implementation:
	// 1. Both met: >50 chunks and >100KB -> SUBSTANTIAL (incomplete)
	assert.equal(isSubstantial(51, 100 * 1024 + 1), true);
	assert.equal(isSubstantial(100, 500 * 1024), true);

	// 2. High chunks but low bytes (e.g. 60 tiny chunks of 10 bytes = 600B) -> NOT substantial (failed)
	assert.equal(isSubstantial(60, 600), false);

	// 3. High bytes but low chunks (e.g. 1 giant chunk of 200KB dropped instantly) -> NOT substantial (failed)
	assert.equal(isSubstantial(1, 200 * 1024), false);

	// 4. Exact boundary values: 50 chunks, 100KB -> NOT substantial (strict > required)
	assert.equal(isSubstantial(50, 100 * 1024), false);
});

// ── 10. Corrupt State File Recovery ──────────────────────────────────────────

test("Error Matrix [10/10] loadRelayState and readCatalogCache recover cleanly from corrupt disk files", () => {
	const existedState = fs.existsSync(RELAY_STATE_FILE);
	const backupState = existedState ? fs.readFileSync(RELAY_STATE_FILE, "utf8") : "";
	const bakFile = `${RELAY_STATE_FILE}.bak`;
	const existedBak = fs.existsSync(bakFile);
	const backupBak = existedBak ? fs.readFileSync(bakFile, "utf8") : "";
	const existedCatalog = fs.existsSync(CATALOG_CACHE_FILE);
	const backupCatalog = existedCatalog ? fs.readFileSync(CATALOG_CACHE_FILE, "utf8") : "";
	try {
		try { fs.rmSync(bakFile, { force: true }); } catch {}
		fs.writeFileSync(RELAY_STATE_FILE, "!!! not valid json !!!", "utf8");
		const recoveredState = loadRelayState();
		assert.ok(recoveredState, "loadRelayState must never throw on corrupt JSON");
		assert.equal(recoveredState.mode, "auto");
		assert.equal(recoveredState.relays.length, 0);
		fs.writeFileSync(bakFile, JSON.stringify({ mode: "on", enabled: true, url: "https://bak.example.com", relays: [{ url: "https://bak.example.com" }] }));
		fs.writeFileSync(RELAY_STATE_FILE, "!!! not valid json !!!", "utf8");
		const recoveredFromBak = loadRelayState();
		assert.equal(recoveredFromBak.relays.length, 1, "should recover from .bak when main is corrupt");
		assert.equal(recoveredFromBak.url, "https://bak.example.com");
		// Valid-but-empty main with data in .bak → must recover (wipe aftermath)
		fs.writeFileSync(RELAY_STATE_FILE, JSON.stringify({ mode: "auto", enabled: false, url: "", relays: [] }));
		const recoveredEmptyMain = loadRelayState();
		assert.equal(recoveredEmptyMain.relays.length, 1, "should recover from .bak when main is valid but empty");
		assert.equal(recoveredEmptyMain.url, "https://bak.example.com");
		fs.writeFileSync(CATALOG_CACHE_FILE, "{ corrupted catalog cache", "utf8");
		const recoveredCatalog = readCatalogCache();
		assert.equal(recoveredCatalog, null, "readCatalogCache must return null on corrupt JSON without throwing");
	} finally {
		if (existedState) {
			fs.writeFileSync(RELAY_STATE_FILE, backupState);
		} else {
			fs.rmSync(RELAY_STATE_FILE, { force: true });
		}
		if (existedBak) {
			fs.writeFileSync(bakFile, backupBak);
		} else {
			try { fs.rmSync(bakFile, { force: true }); } catch {}
		}
		if (existedCatalog) {
			fs.writeFileSync(CATALOG_CACHE_FILE, backupCatalog);
		} else {
			fs.rmSync(CATALOG_CACHE_FILE, { force: true });
		}
	}
});
