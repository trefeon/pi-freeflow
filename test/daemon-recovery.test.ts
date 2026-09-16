/**
 * Daemon-recovery regression suite (issue 9: silent mid-stream death, no recovery).
 *
 * The shared loopback proxy serves every model from one baseUrl, so a dead
 * daemon fails ALL models with a refused loopback connection. These tests pin:
 *  1. The /_shutdown control path leaves an info log line (was silent).
 *  2. A port holder that answers neither /v1/models nor /_health is
 *     reclaimable (was left untouched, deadlocking respawn behind EADDRINUSE).
 *  3. Loopback-refused errors classify explicitly (vs per-model connect noise).
 *  4. The pre-request readiness probe retries after one respawn, then reports
 *     proxy-down explicitly instead of failing silently per model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { HOST, LOG_FILE } from "../src/config.ts";
import { _resetLeaseStateForTest } from "../src/lease.ts";
import { startProxy } from "../src/proxy.ts";
import {
	ensureProxyReady,
	isLoopbackRefused,
	proxyDownMessage,
	shouldReclaimDarkHolder,
} from "../src/client.ts";
import { withIsolatedSandboxFiles } from "./_sandbox-helpers.ts";

// ── 1. Shutdown is visible ───────────────────────────────────────────────

test("control /_shutdown leaves an info log line", async () => {
	await withIsolatedSandboxFiles(async () => {
		_resetLeaseStateForTest();
		const r = await startProxy(0);
		assert.ok(r.server);
		const server = r.server;
		const port = r.port;
		try {
			const closedP = once(server, "close");
			const res = await fetch(`http://${HOST}:${port}/_shutdown`, {
				method: "POST",
				signal: AbortSignal.timeout(1500),
			});
			assert.equal(res.status, 200);
			await closedP;
			let logText = "";
			try {
				logText = fs.readFileSync(LOG_FILE, "utf8");
			} catch {
				logText = "";
			}
			assert.match(logText, /_shutdown/, "shutdown must leave a log line");
		} finally {
			_resetLeaseStateForTest();
			try {
				server.close();
			} catch { }
		}
	});
});

// ── 2. Dark-holder reclaim decision ──────────────────────────────────────

test("dark holder (no models, no health) is reclaimable; live is not", () => {
	assert.equal(
		shouldReclaimDarkHolder({ alive: false, health: null }),
		true,
		"dark holder must be reclaimable",
	);
	assert.equal(
		shouldReclaimDarkHolder({ alive: true, health: null }),
		false,
		"a holder answering /v1/models is live, not dark",
	);
	assert.equal(
		shouldReclaimDarkHolder({
			alive: false,
			health: {
				version: "0.0.0",
				activeRequests: 0,
				sseRate: 0,
				sseDegraded: false,
				lastBytesAt: 0,
			},
		}),
		false,
		"a holder answering /_health is owned by the stale-replace path",
	);
});

// ── 3. Loopback-refused classification ───────────────────────────────────

test("isLoopbackRefused fires only on refused loopback connections", () => {
	assert.equal(
		isLoopbackRefused({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:28180" }),
		true,
	);
	assert.equal(
		isLoopbackRefused(
			new TypeError("fetch failed", {
				cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:28180" },
			}),
		),
		true,
		"undici nests ECONNREFUSED under cause",
	);
	assert.equal(
		isLoopbackRefused({ code: "ECONNREFUSED", message: "connect ECONNREFUSED ::1:28180" }),
		true,
	);
	assert.equal(
		isLoopbackRefused({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 192.168.1.5:28180" }),
		false,
		"non-loopback refusals are not the proxy-down case",
	);
	assert.equal(
		isLoopbackRefused({ code: "ETIMEDOUT", message: "connect ETIMEDOUT 127.0.0.1:28180" }),
		false,
		"timeouts are a different failure",
	);
	assert.equal(isLoopbackRefused(null), false);
	assert.equal(isLoopbackRefused("boom"), false);
});

// ── 4. Explicit proxy-down message ───────────────────────────────────────

test("proxyDownMessage names the loopback port with an actionable hint", () => {
	const msg = proxyDownMessage(28180);
	assert.match(msg, /127\.0\.0\.1:28180/);
	assert.doesNotMatch(msg, /Unable to connect/, "must not reuse the host connect-error wording");
});

// ── 5. Pre-request readiness: probe, one respawn retry, explicit down ────

test("ensureProxyReady passes a live proxy without respawning", async () => {
	_resetLeaseStateForTest();
	const r = await startProxy(0);
	assert.ok(r.server);
	const server = r.server;
	try {
		let respawns = 0;
		const ready = await ensureProxyReady(r.port, async () => {
			respawns += 1;
			return r.port;
		});
		assert.equal(ready.ok, true);
		assert.equal(respawns, 0, "healthy proxy needs no respawn");
	} finally {
		_resetLeaseStateForTest();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("ensureProxyReady retries once after respawn, then reports proxy-down", async () => {
	const probe = await startProxy(0);
	assert.ok(probe.server);
	const deadPort = probe.port;
	const probeServer = probe.server;
	await new Promise<void>((resolve) => probeServer.close(() => resolve()));

	let respawns = 0;
	const down = await ensureProxyReady(deadPort, async () => {
		respawns += 1;
		return deadPort;
	});
	assert.equal(down.ok, false);
	assert.equal(respawns, 1, "exactly one respawn retry");
	if (!down.ok) {
		assert.match(down.reason, new RegExp(`127\\.0\\.0\\.1:${deadPort}`));
	}

	const fixed = await startProxy(0);
	assert.ok(fixed.server);
	const fixedServer = fixed.server;
	try {
		const revived = await ensureProxyReady(deadPort, async () => fixed.port);
		assert.equal(revived.ok, true);
		if (revived.ok) assert.equal(revived.port, fixed.port);
	} finally {
		await new Promise<void>((resolve) => fixedServer.close(() => resolve()));
	}
});
