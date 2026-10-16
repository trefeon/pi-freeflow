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
 *  5. A /_health answer is OUR daemon only when it carries our shape (numeric
 *     `port`); a stranger answering `{}` is reclaimed, never attached to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import { HOST, LOG_FILE } from "../src/config.ts";
import { _resetLeaseStateForTest } from "../src/lease.ts";
import { isPortBound, startProxy } from "../src/proxy.ts";
import {
	ensureProxyReady,
	isLoopbackRefused,
	isOurDaemonHealthBody,
	probeDarkHolder,
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

test("dark holder (held but answering nothing) is reclaimable; free and live are not", () => {
	assert.equal(
		shouldReclaimDarkHolder({ alive: false, bound: true, healthOurs: false }),
		true,
		"a held port answering neither models nor health must be reclaimable",
	);
	assert.equal(
		shouldReclaimDarkHolder({ alive: false, bound: false, healthOurs: false }),
		false,
		"a free port is not a dark holder (issue #52: treating it as one cost ~2s per cold start)",
	);
	assert.equal(
		shouldReclaimDarkHolder({ alive: true, bound: true, healthOurs: false }),
		false,
		"a holder answering /v1/models is live, not dark",
	);
	assert.equal(
		shouldReclaimDarkHolder({ alive: false, bound: true, healthOurs: true }),
		false,
		"a holder answering /_health in OUR shape is a daemon (stale/live path owns it), not dark",
	);
});

test("isPortBound: true for a held port, false once released (issue #52)", async () => {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, HOST, () => resolve()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const port = address.port;
	try {
		assert.equal(await isPortBound(port), true, "a listening port must be reported as bound");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	assert.equal(await isPortBound(port), false, "a released port must not be reported as bound");
});

// ── 2b. Only an OUR-shape /_health answer counts as a daemon ─────────────

/**
 * Minimal loopback holder: /_health answers `body(port)`, everything else
 * (including /v1/models) 404s, so only the /_health shape can identify it.
 */
async function listenHolder(
	body: (port: number) => Record<string, unknown> | null,
): Promise<{ port: number; close: () => Promise<void> }> {
	let port = 0;
	const server = createServer((req, res) => {
		const payload = body(port);
		if (payload !== null && (req.url === "/_health" || req.url === "/health")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, HOST, () => resolve()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	port = address.port;
	return {
		port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("a stranger answering /_health with {} is not our daemon and stays reclaimable", async () => {
	const holder = await listenHolder(() => ({}));
	try {
		assert.equal(
			isOurDaemonHealthBody(holder.port, {}),
			false,
			"arbitrary JSON is not our /_health shape",
		);
		assert.equal(isOurDaemonHealthBody(holder.port, null), false, "no body at all is not our shape");
		assert.equal(
			isOurDaemonHealthBody(holder.port, { version: "9.9.9", activeRequests: 0 }),
			false,
			"a version-answering stranger is still a stranger",
		);
		assert.equal(
			isOurDaemonHealthBody(holder.port, { port: holder.port + 1 }),
			false,
			"a port field naming a different port is not this holder",
		);
		const probe = await probeDarkHolder(holder.port);
		assert.deepEqual(
			probe,
			{ alive: false, bound: true, healthOurs: false },
			"a foreign holder is bound but neither alive nor one of ours",
		);
		assert.equal(
			shouldReclaimDarkHolder(probe),
			true,
			"a stranger must stay reclaimable: the client walks on instead of attaching to it",
		);
	} finally {
		await holder.close();
	}
});

test("our /_health shape (numeric port) is accepted as ours", async () => {
	const holder = await listenHolder((port) => ({
		port,
		active: "auto",
		mode: "auto",
		enabled: true,
		version: "9.9.9",
	}));
	try {
		const res = await fetch(`http://${HOST}:${holder.port}/_health`);
		assert.equal(res.status, 200);
		const body: unknown = await res.json();
		assert.equal(
			isOurDaemonHealthBody(holder.port, body),
			true,
			"our shape (object carrying the listening port) is accepted",
		);
		const probe = await probeDarkHolder(holder.port);
		assert.deepEqual(probe, { alive: false, bound: true, healthOurs: true });
		assert.equal(
			shouldReclaimDarkHolder(probe),
			false,
			"a holder answering in our shape is owned by the stale/live path, not reclaimed as dark",
		);
	} finally {
		await holder.close();
	}
});

test("a real daemon's /_health body satisfies the shape predicate", async () => {
	await withIsolatedSandboxFiles(async () => {
		_resetLeaseStateForTest();
		const r = await startProxy(0);
		assert.ok(r.server);
		const server = r.server;
		try {
			const res = await fetch(`http://${HOST}:${r.port}/_health`);
			assert.equal(res.status, 200);
			const body: unknown = await res.json();
			assert.equal(
				isOurDaemonHealthBody(r.port, body),
				true,
				"src/health.ts must keep reporting the bound port — the shape gate depends on it",
			);
			const probe = await probeDarkHolder(r.port);
			assert.equal(probe.alive, true, "a real daemon answers /v1/models");
			assert.equal(shouldReclaimDarkHolder(probe), false);
		} finally {
			_resetLeaseStateForTest();
			try {
				server.close();
			} catch { }
		}
	});
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
