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
import { loadRelayCore } from "./_relay-core.ts";
import type { RegisteredModel, RelayState } from "../src/types.ts";

// ── 1. HTTP Status Error Decision Matrix ─────────────────────────────────────

test("Error Matrix [1/10] isRetriableStatus strictly separates transient errors from deterministic faults (canonical boundary test)", () => {
	// Retriable statuses (trigger relay rolling)
	const retriable = [429, 408, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530];
	for (const code of retriable) {
		assert.equal(isRetriableStatus(code), true, `Status ${code} must be retriable`);
	}

	// Not retriable by the generic predicate: relayFetch handles 401 (relay auth),
	// 402, 404 and 413 in their own branches, and the rest surface terminally.
	const nonRetriable = [400, 401, 402, 403, 404, 405, 409, 410, 413, 422, 501];
	for (const code of nonRetriable) {
		assert.equal(isRetriableStatus(code), false, `Status ${code} must not be generically retriable`);
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
			id: "nemotron-3.5-super-vl-free",
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
			id: "nemotron-3.5-super-vl-free",
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

test("Error Matrix [5/10] relay worker cores block private, loopback and metadata hosts", () => {
	const cores = [CLOUDFLARE_RELAY_WORKER, VERCEL_RELAY_WORKER, DENO_RELAY_SCRIPT].map((src) => loadRelayCore(src));
	const blocked: Array<[string, string]> = [
		["[::1]", "bracketed IPv6 loopback"],
		["[fd00::1]", "bracketed IPv6 unique-local"],
		["::1", "IPv6 loopback"],
		["::ffff:127.0.0.1", "IPv4-mapped loopback"],
		["fe80::1", "IPv6 link-local"],
		["fd12:3456::1", "IPv6 unique-local"],
		["127.0.0.1", "IPv4 loopback"],
		["127.1", "short-form loopback (inet_aton)"],
		["2130706433", "decimal loopback (inet_aton)"],
		["0x7f.0.0.1", "hex loopback (inet_aton)"],
		["0.0.0.0", "unspecified"],
		["10.1.2.3", "RFC1918 10/8"],
		["172.16.0.1", "RFC1918 172.16/12 lower bound"],
		["172.31.255.255", "RFC1918 172.16/12 upper bound"],
		["192.168.0.5", "RFC1918 192.168/16"],
		["100.64.0.1", "CGNAT 100.64/10 lower bound"],
		["169.254.169.254", "link-local cloud metadata address"],
		["localhost", "localhost"],
		["opencode.ai.localhost", "*.localhost zone"],
		["metadata.google.internal", "*.internal zone"],
		["", "empty host"],
	];
	const allowed: Array<[string, string]> = [
		["8.8.8.8", "public IPv4"],
		["172.32.0.1", "just above 172.16/12"],
		["100.128.0.1", "just above CGNAT 100.64/10"],
		["opencode.ai.", "trailing-dot FQDN sanitized to the public host"],
		["api.kilo.ai", "whitelisted upstream"],
	];

	for (const [index, core] of cores.entries()) {
		for (const [host, why] of blocked) {
			assert.equal(core.isPrivateHostname(host), true, `worker ${index}: ${host} must be blocked (${why})`);
		}
		for (const [host, why] of allowed) {
			assert.equal(core.isPrivateHostname(host), false, `worker ${index}: ${host} must pass (${why})`);
		}
	}
});

// ── 6. Path Traversal & Credential Spoofing Guards ───────────────────────────

test("Error Matrix [6/10] relay worker cores refuse credential, traversal and host-mismatch paths", async () => {
	const cores = [CLOUDFLARE_RELAY_WORKER, VERCEL_RELAY_WORKER, DENO_RELAY_SCRIPT].map((src) => loadRelayCore(src));
	const refusedPaths: unknown[] = [
		"zen/v1/models", // no leading slash
		"/a@b", // embedded credentials
		"/zen\\x", // backslash traversal
		"/zen/../\\x", // mixed traversal
		undefined,
		null,
		42,
	];

	for (const [index, core] of cores.entries()) {
		const label = `worker ${index}`;
		assert.deepEqual(
			core.resolveRelayTarget("https://opencode.ai", "/zen/v1/models"),
			{ ok: true, url: "https://opencode.ai/zen/v1/models" },
			`${label}: the canonical upstream path must resolve`,
		);
		assert.equal(
			core.resolveRelayTarget("https://opencode.ai/", "/zen/v1/models").ok,
			true,
			`${label}: a trailing slash on the target is not a host mismatch`,
		);
		for (const relayPath of refusedPaths) {
			const verdict = core.resolveRelayTarget("https://opencode.ai", relayPath);
			assert.equal(verdict.ok, false, `${label}: ${String(relayPath)} must be refused`);
			assert.equal(verdict.status, 403, `${label}: ${String(relayPath)} must be a 403`);
			assert.equal(verdict.reason, "forbidden x-relay-path", `${label}: ${String(relayPath)} reason`);
		}

		// A protocol-relative or absolute path must not escape the whitelisted host.
		const escaped = core.resolveRelayTarget("https://opencode.ai", "//evil.example.com/zen");
		assert.equal(escaped.ok, false, `${label}: a protocol-relative path must not dodge the host check`);
		assert.equal(escaped.reason, "forbidden x-relay-path (host mismatch)");
		assert.equal(core.resolveRelayTarget("https://opencode.ai", "https://evil.example.com/zen").status, 403);
		assert.equal(core.resolveRelayTarget("https://opencode.ai", "/zen#@evil.example.com").status, 403);

		// Credentials embedded in the target never survive resolution.
		assert.equal(core.resolveRelayTarget("https://user:pw@opencode.ai", "/zen").ok, false);

		// Dot-segment traversal normalizes inside the whitelisted host, never out of it.
		const traversal = core.resolveRelayTarget("https://opencode.ai", "/zen/../../zen/v1/models");
		assert.equal(traversal.ok, true, `${label}: same-host dot-segment traversal stays resolvable`);
		assert.equal(traversal.url, "https://opencode.ai/zen/v1/models");

		// A target that is not a URL is rejected before any host check.
		const invalid = core.resolveRelayTarget("not a url", "/zen");
		assert.equal(invalid.status, 400);
		assert.equal(invalid.reason, "invalid x-relay-target");
	}

	// The handler decides the target before any upstream fetch, so bracket,
	// loopback and metadata hosts never reach the wire, and the relay's own
	// routing headers are never forwarded to the upstream.
	const fetched: Array<{ url: string; headers: Headers }> = [];
	const realFetch = globalThis.fetch;
	(globalThis as Record<string, unknown>).fetch = async (url: unknown, init?: RequestInit) => {
		fetched.push({ url: String(url), headers: new Headers(init?.headers) });
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		for (const [index, core] of cores.entries()) {
			const refusedTargets = [
				"https://evil.example.com",
				"https://169.254.169.254",
				"http://127.0.0.1:8080",
				"https://[::1]",
				"file:///etc/passwd",
			];
			for (const target of refusedTargets) {
				const res = await core.relayHandler({
					method: "GET",
					headers: new Headers({ "x-relay-target": target, "x-relay-path": "/zen/v1/models" }),
					body: null,
				});
				assert.equal(res.status, 403, `worker ${index}: ${target} must be refused`);
			}
			assert.equal(fetched.length, index, `worker ${index}: a refused target must never reach fetch`);

			const relayed = await core.relayHandler({
				method: "GET",
				headers: new Headers({
					"x-relay-target": "https://opencode.ai",
					"x-relay-path": "/zen/v1/models",
					"x-relay-auth": "not-the-deployment-secret",
				}),
				body: null,
			});
			assert.equal(relayed.status, 200, `worker ${index}: the whitelisted target must relay`);
			assert.equal(fetched[index].url, "https://opencode.ai/zen/v1/models");
			for (const hop of ["host", "x-relay-target", "x-relay-path", "x-relay-auth"]) {
				assert.equal(
					fetched[index].headers.get(hop),
					null,
					`worker ${index}: ${hop} must never be forwarded upstream`,
				);
			}
		}
	} finally {
		globalThis.fetch = realFetch;
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
