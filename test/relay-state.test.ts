/**
 * Unit tests for relay state management and ordering
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs, { type PathLike } from "node:fs";
import path from "node:path";
import { RELAY_STATE_FILE } from "../src/config.ts";
import {
	ensureRelay,
	ewmaBadge,
	findRelay,
	getActiveRelayState,
	getOrderedRelayUrls,
	getRelayHealth,
	isRelayHealthy,
	markRelayFailure,
	markRelaySuccess,
	removeRelay,
	resetAllRelayHealth,
	setActiveRelayState,
	saveRelayState,
	setRelayLabel,
	shortRelayLabel,
	withRelayState,
	validateRelayUrl,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { ALLOW_UNSAFE_RELAY_ENV } from "../src/config.ts";

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

test("ensureRelay adds new relay without duplicate", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay1.example.com",
		relays: [{ url: "https://relay1.example.com" }],
	};

	ensureRelay(state, "https://relay2.example.com", "second");
	assert.equal(state.relays.length, 2);

	// Adding same URL again should not duplicate
	ensureRelay(state, "https://relay2.example.com");
	assert.equal(state.relays.length, 2);
});

test("removeRelay filters out specified relay", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay1.example.com",
		relays: [
			{ url: "https://relay1.example.com" },
			{ url: "https://relay2.example.com" },
		],
	};

	removeRelay(state, "https://relay2.example.com");
	assert.equal(state.relays.length, 1);
	assert.equal(state.relays[0].url, "https://relay1.example.com");
});

test("getOrderedRelayUrls rotates candidates starting from active relay", () => {
	// Order-immune: clear health state carried over from other tests so no
	// relay is demoted into cooldown and skews the rotation.
	resetAllRelayHealth();
	withSavedDiskState(() => {
		const state: RelayState = {
			enabled: true,
			url: "https://relay2.example.com",
			relays: [
				{ url: "https://relay1.example.com" },
				{ url: "https://relay2.example.com" },
				{ url: "https://relay3.example.com" },
			],
		};
		setActiveRelayState(state, false);

		const ordered = getOrderedRelayUrls();
		assert.equal(ordered[0], "https://relay2.example.com");
		assert.equal(ordered[1], "https://relay3.example.com");
		assert.equal(ordered[2], "https://relay1.example.com");
	});
	resetAllRelayHealth();
});

test("shortRelayLabel extracts readable host or custom label", () => {
	withSavedDiskState(() => {
		const state: RelayState = {
			enabled: true,
			url: "https://my-relay.workers.dev",
			relays: [
				{ url: "https://my-relay.workers.dev", label: "CustomLabel" },
				{ url: "https://alpha-beta.vercel.app" },
			],
		};
		setActiveRelayState(state, false);

		assert.equal(shortRelayLabel("https://my-relay.workers.dev"), "CustomLabel");
		assert.equal(shortRelayLabel("https://alpha-beta.vercel.app"), "alpha-beta");
	});
});

test("findRelay finds by 1-based index, exact URL, or label alias", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay1.example.com",
		relays: [
			{ url: "https://relay1.example.com", label: "Primary" },
			{ url: "https://relay2.example.com", label: "cf-backup" },
			{ url: "https://relay3.example.com" },
		],
	};

	// By index (number and numeric string)
	assert.equal(findRelay(state, 1)?.url, "https://relay1.example.com");
	assert.equal(findRelay(state, "2")?.url, "https://relay2.example.com");
	assert.equal(findRelay(state, 4), undefined);

	// By label (case insensitive)
	assert.equal(findRelay(state, "primary")?.url, "https://relay1.example.com");
	assert.equal(findRelay(state, "CF-BACKUP")?.url, "https://relay2.example.com");

	// By URL
	assert.equal(findRelay(state, "https://relay3.example.com")?.url, "https://relay3.example.com");
});

test("setRelayLabel updates label by URL, index, or existing label", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay1.example.com",
		relays: [
			{ url: "https://relay1.example.com", label: "OldLabel" },
			{ url: "https://relay2.example.com" },
		],
	};

	setRelayLabel(state, 1, "NewPrimary");
	assert.equal(state.relays[0].label, "NewPrimary");

	setRelayLabel(state, "https://relay2.example.com", "MyCustomVercel");
	assert.equal(state.relays[1].label, "MyCustomVercel");
	assert.equal(shortRelayLabel("https://relay2.example.com", state.relays), "MyCustomVercel");
});

test("ensureRelay updates existing relay label if provided", () => {
	const state: RelayState = {
		enabled: true,
		url: "https://relay1.example.com",
		relays: [{ url: "https://relay1.example.com" }],
	};

	ensureRelay(state, "https://relay1.example.com", "UpdatedAlias");
	assert.equal(state.relays.length, 1);
	assert.equal(state.relays[0].label, "UpdatedAlias");
});

test("shortRelayLabel handles IP addresses and subdomains nicely", () => {
	assert.equal(shortRelayLabel("http://192.168.1.100:8080"), "192.168.1.100:8080");
	assert.equal(shortRelayLabel("https://sg-edge.workers.dev"), "sg-edge");
});

test("relay health tracking: 429 and errors trigger cooldown and demote candidate order", () => {
	resetAllRelayHealth();
	const r1 = "https://relay1.example.com";
	const r2 = "https://relay2.example.com";
	const r3 = "https://relay3.example.com";

	const state: RelayState = {
		enabled: true,
		url: r1,
		relays: [{ url: r1 }, { url: r2 }, { url: r3 }],
	};
	setActiveRelayState(state, false);

	// Initial: all healthy
	assert.equal(isRelayHealthy(r1), true);
	assert.equal(isRelayHealthy(r2), true);

	// Mark r1 as 429 (rate-limited)
	markRelayFailure(r1, 429);
	assert.equal(isRelayHealthy(r1), false);
	const health = getRelayHealth(r1);
	assert.ok(health);
	assert.equal(health?.lastStatus, 429);
	assert.ok(health!.cooldownUntil > Date.now());

	// getOrderedRelayUrls must place r1 at the tail behind healthy r2 and r3
	const ordered = getOrderedRelayUrls();
	assert.equal(ordered[0], r2);
	assert.equal(ordered[1], r3);
	assert.equal(ordered[2], r1);

	// Mark r1 as succeeded -> immediately restored to healthy
	markRelaySuccess(r1);
	assert.equal(isRelayHealthy(r1), true);

	resetAllRelayHealth();
});

test("getOrderedRelayUrls returns empty candidates instead of blank URL when pool is empty", () => {
	withSavedDiskState(() => {
		setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
		assert.deepEqual(getOrderedRelayUrls(), [], "empty pool must yield [] so consumers short-circuit to direct");

		// A pool whose entries are all blank URLs is still an empty pool.
		setActiveRelayState({ enabled: true, url: "", relays: [{ url: "" }, { url: "   " }] }, false);
		assert.deepEqual(getOrderedRelayUrls(), [], "blank-only pool must not produce a '' candidate");
	});
});

test("consecutive failures escalate cooldown up to 4x base", () => {
	resetAllRelayHealth();
	const r = "https://chronic-429.example.com";
	const BASE_MS = 90_000; // 429 base
	const SLACK_MS = 2_000;

	for (let n = 1; n <= 5; n++) {
		markRelayFailure(r, 429);
		const expected = BASE_MS * Math.min(4, n); // multiplier caps at 4
		const remaining = getRelayHealth(r)!.cooldownUntil - Date.now();
		assert.ok(
			remaining > expected - SLACK_MS && remaining <= expected,
			`failure #${n}: expected ~${expected}ms cooldown window, got ${remaining}ms`,
		);
	}

	// Escalation resets on success (record deleted).
	markRelaySuccess(r);
	assert.equal(getRelayHealth(r), undefined);

	// Other failure classes escalate from their own base too (socket error: 30s base).
	const s = "https://chronic-socket.example.com";
	markRelayFailure(s, 0, "socket hang up");
	let remainingSocket = getRelayHealth(s)!.cooldownUntil - Date.now();
	assert.ok(remainingSocket > 30_000 - SLACK_MS && remainingSocket <= 30_000);
	markRelayFailure(s, 0, "socket hang up");
	remainingSocket = getRelayHealth(s)!.cooldownUntil - Date.now();
	assert.ok(remainingSocket > 60_000 - SLACK_MS && remainingSocket <= 60_000);

	resetAllRelayHealth();
});

test("markRelaySuccess with latencyMs keeps record, records rounded latency, and resets failure fields", () => {
	resetAllRelayHealth();
	const r = "https://latency.example.com";

	// Success with measured latency keeps the record and reports it.
	markRelaySuccess(r, 250);
	const health = getRelayHealth(r);
	assert.ok(health, "record must be kept when a finite latency is provided");
	assert.equal(health!.lastLatencyMs, 250);
	assert.equal(health!.consecutiveFailures, 0);
	assert.equal(health!.cooldownUntil, 0);
	assert.equal(isRelayHealthy(r), true);

	// Latency is rounded to whole ms.
	markRelaySuccess(r, 150.6);
	assert.equal(getRelayHealth(r)!.lastLatencyMs, 151);

	resetAllRelayHealth();
});

test("markRelaySuccess after markRelayFailure clears failure state but keeps recorded latency", () => {
	resetAllRelayHealth();
	const r = "https://recovered.example.com";

	markRelayFailure(r, 429);
	assert.equal(isRelayHealthy(r), false);
	assert.ok(getRelayHealth(r)!.cooldownUntil > 0);

	markRelaySuccess(r, 150);
	const health = getRelayHealth(r);
	assert.ok(health);
	assert.equal(health!.lastLatencyMs, 150);
	assert.equal(health!.consecutiveFailures, 0);
	assert.equal(health!.cooldownUntil, 0);
	assert.equal(isRelayHealthy(r), true);

	resetAllRelayHealth();
});

test("relay health counters: successCount and failureCount increment, last429At tracks 429", () => {
	resetAllRelayHealth();
	const r = "https://counter.example.com";

	markRelayFailure(r, 429);
	markRelaySuccess(r, 150);
	let health = getRelayHealth(r);
	assert.ok(health, "record must be kept after success with latency");
	assert.equal(health!.successCount, 1);
	assert.equal(health!.failureCount, 1);
	assert.ok(
		typeof health!.last429At === "number" && health!.last429At > 0,
		`last429At should be a positive timestamp, got ${health!.last429At}`,
	);
	const first429At = health!.last429At;

	// A second success keeps incrementing successCount.
	markRelaySuccess(r, 200);
	health = getRelayHealth(r);
	assert.ok(health);
	assert.equal(health!.successCount, 2);

	// A non-429 failure increments failureCount but preserves last429At.
	markRelayFailure(r, 503);
	health = getRelayHealth(r);
	assert.ok(health);
	assert.equal(health!.failureCount, 2);
	assert.equal(health!.last429At, first429At);

	resetAllRelayHealth();
});

test("saveRelayState retries atomic rename once EPERM clears (Windows file lock)", () => {
	withSavedDiskState(() => {
		const realRenameSync = fs.renameSync.bind(fs);
		const fsp = fs as unknown as { renameSync: (from: string, to: string) => void }; // monkey-patch of CJS default-export object
		let attempts = 0;
		fsp.renameSync = (from: string, to: string) => {
			attempts++;
			if (attempts === 1) {
				const err: NodeJS.ErrnoException = new Error(
					`EPERM: operation not permitted, rename '${from}' -> '${to}'`,
				);
				err.code = "EPERM";
				throw err;
			}
			return realRenameSync(from, to);
		};
		try {
			const state: RelayState = {
				enabled: true,
				url: "https://retry-lock.example.com",
				relays: [{ url: "https://retry-lock.example.com" }],
			};
			saveRelayState(state);

			assert.equal(attempts, 2, "first attempt throws EPERM, retry must succeed");
			const persisted = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
			assert.equal(persisted.url, "https://retry-lock.example.com", "state must land on disk despite the lock");
		} finally {
			fsp.renameSync = realRenameSync;
		}
	});
});

test("saveRelayState fails fast on non-transient rename errors without retrying", () => {
	withSavedDiskState(() => {
		const realRenameSync = fs.renameSync.bind(fs);
		const fsp = fs as unknown as { renameSync: (oldPath: PathLike, newPath: PathLike) => void }; // monkey-patch of CJS default-export object
		let attempts = 0;
		fsp.renameSync = () => {
			attempts++;
			const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory, rename");
			err.code = "ENOENT";
			throw err;
		};
		try {
			assert.doesNotThrow(() => saveRelayState({ enabled: true, url: "", relays: [] }));
			assert.equal(attempts, 1, "ENOENT must not be retried");
		} finally {
			fsp.renameSync = realRenameSync;
		}
	});
});

test("withRelayState applies the updater to the freshest disk state and persists it", () => {
	withSavedDiskState(() => {
		saveRelayState({
			mode: "auto",
			enabled: true,
			url: "https://cas1.example.com",
			relays: [{ url: "https://cas1.example.com" }],
		});
		const next = withRelayState((s) => {
			s.mode = "off";
			s.enabled = false;
			return s;
		});
		assert.equal(next.mode, "off");
		assert.equal(next.enabled, false);
		const onDisk = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8")) as RelayState;
		assert.equal(onDisk.mode, "off", "the mutation must land on disk");
		assert.equal(onDisk.relays.length, 1, "unrelated pool data must survive the CAS write");
		assert.equal(getActiveRelayState().mode, "off", "in-memory state must follow the write");
		assert.equal(fs.existsSync(`${RELAY_STATE_FILE}.lock`), false, "lock must be released");
	});
});

test("withRelayState takes over a stale lock (crashed holder) without waiting", () => {
	withSavedDiskState(() => {
		const lock = `${RELAY_STATE_FILE}.lock`;
		fs.writeFileSync(lock, "999999", "utf8");
		const stale = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, stale, stale);
		const next = withRelayState((s) => {
			s.enabled = true;
			return s;
		});
		assert.ok(next, "CAS must complete despite a stale lock");
		assert.equal(fs.existsSync(lock), false, "stale lock must be taken over and removed");
	});
});

test("withRelayState proceeds unlocked after a busy-lock timeout and never touches the foreign lock", () => {
	withSavedDiskState(() => {
		const lock = `${RELAY_STATE_FILE}.lock`;
		fs.writeFileSync(lock, String(process.pid), "utf8"); // fresh lock = held by another process
		try {
			const next = withRelayState((s) => {
				s.url = "https://cas-timeout.example.com";
				return s;
			});
			assert.equal(next.url, "https://cas-timeout.example.com", "write still applies past the lock timeout");
		} finally {
			// Simulate the foreign holder releasing its lock.
			fs.rmSync(lock, { force: true });
		}
	});
});

// ── Relay URL validation ──────────────────────────────────────────────

test("validateRelayUrl: accepts public https relay URLs", () => {
	const ok = validateRelayUrl("https://good.example.com");
	assert.equal(ok.ok, true);
	assert.ok(ok.ok && ok.url instanceof URL, "must return a parsed URL");
	assert.equal(validateRelayUrl("https://good.example.com:443").ok, true, "explicit default port is allowed");
	assert.equal(validateRelayUrl("https://sg-edge.workers.dev").ok, true);
});

test("validateRelayUrl: rejects http, credentials, private/loopback hosts, .local, and non-default ports", () => {
	assert.equal(validateRelayUrl("http://relay.example.com").ok, false, "http must be rejected");
	assert.equal(
		validateRelayUrl("https://user:pass@relay.example.com").ok,
		false,
		"embedded credentials must be rejected",
	);
	assert.equal(validateRelayUrl("https://127.0.0.1").ok, false, "loopback must be rejected");
	assert.equal(validateRelayUrl("https://192.168.1.5").ok, false, "RFC1918 must be rejected");
	assert.equal(validateRelayUrl("https://169.254.10.2").ok, false, "link-local must be rejected");
	assert.equal(validateRelayUrl("https://relay.local").ok, false, ".local must be rejected");
	assert.equal(validateRelayUrl("https://10.0.0.7").ok, false, "10/8 must be rejected");
	assert.equal(validateRelayUrl("https://172.31.4.8").ok, false, "172.16/12 must be rejected");
	assert.equal(validateRelayUrl("https://good.example.com:8443").ok, false, "non-default port must be rejected");
	assert.equal(validateRelayUrl("://invalid").ok, false, "unparseable URL must be rejected");
	assert.equal(validateRelayUrl("").ok, false, "empty must be rejected");
});

test("validateRelayUrl: unsafe env allows http and private hosts", () => {
	const previous = process.env[ALLOW_UNSAFE_RELAY_ENV];
	process.env[ALLOW_UNSAFE_RELAY_ENV] = "1";
	try {
		assert.equal(validateRelayUrl("http://127.0.0.1:28180").ok, true, "unsafe env allows http loopback");
		assert.equal(validateRelayUrl("http://192.168.1.5:8080").ok, true, "unsafe env allows private hosts");
		assert.equal(validateRelayUrl("https://relay.example.com:8443").ok, true, "unsafe env allows non-default ports");
		assert.equal(
			validateRelayUrl("https://user:pass@relay.example.com").ok,
			false,
			"credentials stay rejected even in unsafe env",
		);
	} finally {
		if (previous === undefined) {
			delete process.env[ALLOW_UNSAFE_RELAY_ENV];
		} else {
			process.env[ALLOW_UNSAFE_RELAY_ENV] = previous;
		}
	}
});

test("ensureRelay rejects invalid relay URLs", () => {
	const state: RelayState = { enabled: true, url: "", relays: [], mode: "auto" };
	assert.throws(() => ensureRelay(state, "http://127.0.0.1:8080"), /Relay URL rejected/);
	assert.throws(() => ensureRelay(state, "https://relay.local"), /Relay URL rejected/);
	assert.throws(() => ensureRelay(state, "https://good.example.com:9999"), /Relay URL rejected/);
	assert.equal(state.relays.length, 0, "rejected URLs must not enter the pool");
});
// ── Phase 1 smart-routing: margin-gated EWMA challenger ───────────────────

function seedEwma(url: string, samples: number[]): void {
	for (const ms of samples) markRelaySuccess(url, ms);
}

function autoPool(active: string, urls: string[]): RelayState {
	return { enabled: true, url: active, relays: urls.map((url) => ({ url })), mode: "auto" };
}

test("challenger: sub-margin gap keeps the sticky primary", () => {
	resetAllRelayHealth();
	withSavedDiskState(() => {
		const slow = "https://primary-slow.example.com";
		const fast = "https://challenger-fast.example.com";
		setActiveRelayState(autoPool(slow, [slow, fast]), false);
		seedEwma(slow, [2000, 2000, 2000]);
		seedEwma(fast, [1200, 1200, 1200]);
		// Gap 800ms < max(1500, 25% of 2000): upstream noise, not worth a cold hop.
		assert.deepEqual(getOrderedRelayUrls(), [slow, fast]);
	});
	resetAllRelayHealth();
});

test("challenger: above-margin gap promotes challenger, primary stays second", () => {
	resetAllRelayHealth();
	withSavedDiskState(() => {
		const slow = "https://sticky-slow.example.com";
		const fast = "https://fast-challenger.example.com";
		setActiveRelayState(autoPool(slow, [slow, fast]), false);
		seedEwma(slow, [5000, 5000, 5000]);
		seedEwma(fast, [1000, 1000, 1000]);
		// Gap 4000ms > max(1500, 25% of 5000): switch, nothing removed.
		assert.deepEqual(getOrderedRelayUrls(), [fast, slow]);
	});
	resetAllRelayHealth();
});

test("challenger: under-floor relay cannot challenge even with a huge gap", () => {
	resetAllRelayHealth();
	withSavedDiskState(() => {
		const slow = "https://sticky-measured.example.com";
		const fresh = "https://fresh-relay.example.com";
		setActiveRelayState(autoPool(slow, [slow, fresh]), false);
		seedEwma(slow, [5000, 5000, 5000]);
		seedEwma(fresh, [100, 100]);
		assert.deepEqual(getOrderedRelayUrls(), [slow, fresh], "2 samples < floor 3: no promotion");
	});
	resetAllRelayHealth();
});

test("challenger: unknown-sample relays sort after measured, before cooling", () => {
	resetAllRelayHealth();
	withSavedDiskState(() => {
		const sticky = "https://sticky-measured.example.com";
		const newcomer = "https://newcomer-unknown.example.com";
		const down = "https://down-cooling.example.com";
		setActiveRelayState(autoPool(sticky, [sticky, newcomer, down]), false);
		seedEwma(sticky, [3000, 3000, 3000]);
		seedEwma(newcomer, [900]);
		markRelayFailure(down, 503);
		assert.deepEqual(getOrderedRelayUrls(), [sticky, newcomer, down]);
	});
	resetAllRelayHealth();
});

test("challenger: 429-cooling beats any EWMA — fastest relay stays tailed", () => {
	resetAllRelayHealth();
	withSavedDiskState(() => {
		const slow = "https://steady-slow.example.com";
		const hot = "https://hot-fast.example.com";
		setActiveRelayState(autoPool(hot, [hot, slow]), false);
		seedEwma(slow, [5000, 5000, 5000]);
		seedEwma(hot, [200, 200, 200]);
		markRelayFailure(hot, 429);
		assert.equal(isRelayHealthy(hot), false);
		assert.deepEqual(getOrderedRelayUrls(), [slow, hot], "cooling partition excludes first");
	});
	resetAllRelayHealth();
});

test("challenger: Vercel band exempt — fast Vercel never jumps non-Vercel", () => {
	resetAllRelayHealth();
	withSavedDiskState(() => {
		const slow = "https://steady-origin.example.com";
		const vercel = "https://fast-embassy.vercel.app";
		setActiveRelayState(autoPool(slow, [slow, vercel]), false);
		seedEwma(slow, [5000, 5000, 5000]);
		seedEwma(vercel, [200, 200, 200]);
		assert.deepEqual(getOrderedRelayUrls(), [slow, vercel], "latency never crosses the metered band");
	});
	resetAllRelayHealth();
});

test("challenger: recovering relay cannot challenge until its first post-recovery success", (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	resetAllRelayHealth();
	try {
		withSavedDiskState(() => {
			const slow = "https://sticky-slow.example.com";
			const cand = "https://candidate-fast.example.com";
			setActiveRelayState(autoPool(slow, [slow, cand]), false);
			seedEwma(slow, [5000, 5000, 5000]);
			seedEwma(cand, [500, 500, 500]);
			markRelayFailure(cand, 503);
			t.mock.timers.tick(46_000);
			assert.equal(isRelayHealthy(cand), true, "503 cooldown (45s) must have expired");
			assert.deepEqual(getOrderedRelayUrls(), [slow, cand], "recovering challenger must not displace sticky");
			markRelaySuccess(cand, 500);
			assert.deepEqual(getOrderedRelayUrls(), [cand, slow], "cleared challenger wins on margin");
		});
	} finally {
		resetAllRelayHealth();
	}
});

test("ewmaBadge: shows ~Nms avg with samples, blank without", () => {
	resetAllRelayHealth();
	try {
		assert.equal(ewmaBadge(undefined), "");
		const url = "https://badge-relay.example.com";
		markRelaySuccess(url, 1200);
		assert.equal(ewmaBadge(getRelayHealth(url)), " ~1200ms avg");
		assert.equal(ewmaBadge(getRelayHealth("https://never-seen.example.com")), "");
	} finally {
		resetAllRelayHealth();
	}
});
