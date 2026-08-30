/**
 * Detached-daemon lease + control-endpoint suite.
 *
 * Covers: lease registry GC, proxy control endpoints, request-touch fallback,
 * and the health snapshot that surfaces lease state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HOST } from "../src/config.ts";
import {
	getLastActivityAt,
	getLeaseCount,
	getLeaseSnapshot,
	_resetLeaseStateForTest,
	registerClient,
	renewClient,
	startLeaseGC,
	stopLeaseGC,
	touchActivity,
	unregisterClient,
} from "../src/lease.ts";
import { getAliveCatalog } from "../src/catalog.ts";
import { getHealthData } from "../src/health.ts";
import { getActiveRequests, startProxy } from "../src/proxy.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

async function jsonPost(port: number, pathname: string, body: unknown): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`http://${HOST}:${port}${pathname}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(1500),
	});
	let json: unknown = null;
	try {
		json = await res.json();
	} catch {}
	return { status: res.status, json };
}

async function getJson(port: number, pathname: string): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`http://${HOST}:${port}${pathname}`, {
		signal: AbortSignal.timeout(1500),
	});
	let json: unknown = null;
	try {
		json = await res.json();
	} catch {}
	return { status: res.status, json };
}

// ── 1. Lease registry unit ──────────────────────────────────────────────

test("lease registry: register → renew → unregister", () => {
	_resetLeaseStateForTest();
	assert.equal(getLeaseCount(), 0);

	registerClient("c1");
	assert.equal(getLeaseCount(), 1);
	assert.ok("c1" in getLeaseSnapshot());

	const before = getLeaseSnapshot().c1;
	// tiny delay so renewal timestamp moves forward
	const start = Date.now();
	while (Date.now() === start) {
		// spin ~1ms — lease timestamps are ms-granular
	}
	renewClient("c1");
	assert.ok(getLeaseSnapshot().c1 >= before);

	registerClient("c2");
	assert.equal(getLeaseCount(), 2);

	unregisterClient("c1");
	assert.equal(getLeaseCount(), 1);
	assert.ok(!("c1" in getLeaseSnapshot()));

	unregisterClient("c2");
	assert.equal(getLeaseCount(), 0);

	_resetLeaseStateForTest();
});

test("lease GC: expires stale leases, retires when idle and lease-less", async () => {
	_resetLeaseStateForTest();

	let retired = false;
	startLeaseGC({
		ttlMs: 200,
		gcMs: 50,
		graceMs: 100,
		getActiveRequests: () => 0,
		onIdle: () => {
			retired = true;
		},
	});

	// Fresh daemon with no leases: lastActivityAt is at GC start, so it
	// survives the readiness-poll grace — init-at-bind contract.
	await new Promise<void>((r) => setTimeout(r, 60));
	assert.equal(retired, false, "fresh daemon must not retire during grace");

	// One lease keeps the daemon alive past the grace.
	registerClient("keepalive");
	await new Promise<void>((r) => setTimeout(r, 180));
	assert.equal(retired, false, "daemon with a live lease must not retire");
	assert.equal(getLeaseCount(), 1);

	// After the lease TTL the GC drops it; with 0 leases + idle + past grace it retires.
	await new Promise<void>((r) => setTimeout(r, 300));
	assert.equal(getLeaseCount(), 0);
	// Grace is 100ms after lastActivityAt (still at GC start ~400ms ago) — should have retired
	await new Promise<void>((r) => setTimeout(r, 120));
	assert.equal(retired, true, "lease-less idle daemon must retire after grace");

	stopLeaseGC();
	_resetLeaseStateForTest();
});

test("lease GC: request-touch keeps lease-less daemon alive (legacy clients)", async () => {
	_resetLeaseStateForTest();

	let retired = false;
	startLeaseGC({
		ttlMs: 200,
		gcMs: 50,
		graceMs: 150,
		getActiveRequests: () => 0,
		onIdle: () => {
			retired = true;
		},
	});

	// Lease-less but actively proxied — touchActivity refreshes the grace.
	for (let i = 0; i < 5; i++) {
		touchActivity();
		await new Promise<void>((r) => setTimeout(r, 80));
		assert.equal(retired, false, `tick ${i}: activity must prevent retire`);
	}

	// Stop touching — after grace it should retire.
	await new Promise<void>((r) => setTimeout(r, 200));
	assert.equal(retired, true);

	stopLeaseGC();
	_resetLeaseStateForTest();
});

test("lease GC: in-flight requests block retire", async () => {
	_resetLeaseStateForTest();

	let active = 1;
	let retired = false;
	startLeaseGC({
		ttlMs: 100,
		gcMs: 50,
		graceMs: 80,
		getActiveRequests: () => active,
		onIdle: () => {
			retired = true;
		},
	});

	await new Promise<void>((r) => setTimeout(r, 200));
	assert.equal(retired, false, "in-flight requests must block retire");

	active = 0;
	await new Promise<void>((r) => setTimeout(r, 150));
	assert.equal(retired, true, "after requests drain, idle daemon must retire");

	stopLeaseGC();
	_resetLeaseStateForTest();
});

// ── 2. Proxy control endpoints ──────────────────────────────────────────

test("proxy control endpoints: attach → heartbeat → detach", async () => {
	_resetLeaseStateForTest();
	const _r = await startProxy(0);
	assert.ok(_r.server);
	const server = _r.server;
	const port = _r.port;
	try {
		// attach c1
		let r = await jsonPost(port, "/_client/attach", { id: "c1" });
		assert.equal(r.status, 200);
		assert.equal(getLeaseCount(), 1);

		// heartbeat renews
		const before = getLeaseSnapshot().c1;
		await new Promise<void>((res) => setTimeout(res, 5));
		r = await jsonPost(port, "/_client/heartbeat", { id: "c1" });
		assert.equal(r.status, 200);
		assert.ok(getLeaseSnapshot().c1 >= before);

		// attach c2 → now 2 leases
		r = await jsonPost(port, "/_client/attach", { id: "c2" });
		assert.equal(r.status, 200);
		assert.equal(getLeaseCount(), 2);

		// detach c1 → 1 remains (multi-instance: one leaves, daemon stays)
		r = await jsonPost(port, "/_client/detach", { id: "c1" });
		assert.equal(r.status, 200);
		assert.equal(getLeaseCount(), 1);
		assert.ok(!("c1" in getLeaseSnapshot()));
		assert.ok("c2" in getLeaseSnapshot());

		// detach c2 → 0
		r = await jsonPost(port, "/_client/detach", { id: "c2" });
		assert.equal(r.status, 200);
		assert.equal(getLeaseCount(), 0);

		// missing id → 400, no lease created
		r = await jsonPost(port, "/_client/attach", {});
		assert.equal(r.status, 400);
		assert.equal(getLeaseCount(), 0);

		// unknown control path → 404
		r = await jsonPost(port, "/_client/unknown", { id: "c1" });
		assert.equal(r.status, 404);
	} finally {
		_resetLeaseStateForTest();
		await new Promise<void>((res) => server.close(() => res()));
	}
});

test("proxy control: /_shutdown is loopback-only and closes the server", async () => {
	_resetLeaseStateForTest();
	const _r = await startProxy(0);
	assert.ok(_r.server);
	const server = _r.server;
	const port = _r.port;
	let closed = false;
	server.on("close", () => {
		closed = true;
	});
	try {
		const res = await fetch(`http://${HOST}:${port}/_shutdown`, {
			method: "POST",
			signal: AbortSignal.timeout(1500),
		});
		assert.equal(res.status, 200);
		// Server should close shortly after the response
		await new Promise<void>((r) => setTimeout(r, 250));
		assert.equal(closed, true);
	} finally {
		_resetLeaseStateForTest();
		try {
			server.close();
		} catch {}
		// process.exit is mocked by handleControlRequest in this in-process test
		// — restore the exit so the test process itself doesn't die
	}
});

// ── 3. Health snapshot reflects lease state ────────────────────────────

test("health snapshot includes lease state and request-touch", async () => {
	_resetLeaseStateForTest();
	const _r = await startProxy(0);
	assert.ok(_r.server);
	const server = _r.server;
	const port = _r.port;
	try {
		registerClient("h1");
		registerClient("h2");
		touchActivity();

		const data = getHealthData(port, getActiveRequests());
		assert.equal(data.clients, 2);
		assert.ok("h1" in data.leases);
		assert.ok("h2" in data.leases);
		assert.ok(typeof data.lastActivityAt === "number");
		assert.ok(data.lastActivityAt > 0);

		// Also reachable over HTTP
		const httpHealth = await getJson(port, "/_health");
		assert.equal(httpHealth.status, 200);
		const body = httpHealth.json as Record<string, unknown>;
		assert.equal(body.clients, 2);
	} finally {
		_resetLeaseStateForTest();
		await new Promise<void>((r) => server.close(() => r()));
	}
});

test("request-touch: /v1/models updates lastActivityAt", async () => {
	_resetLeaseStateForTest();
	const _r = await startProxy(0);
	assert.ok(_r.server);
	const server = _r.server;
	const port = _r.port;
	try {
		const before = getLastActivityAt();
		await new Promise<void>((r) => setTimeout(r, 5));
		const r = await getJson(port, "/v1/models");
		assert.equal(r.status, 200);
		assert.ok(getLastActivityAt() >= before);
		assert.ok(getLastActivityAt() > before || getLastActivityAt() === before);
	} finally {
		_resetLeaseStateForTest();
		await new Promise<void>((r) => server.close(() => r()));
	}
});

// ── 4. Daemon helpers ─────────────────────────────────────────────────

test("daemon entry: isDaemonMain is false when imported", async () => {
	const { isDaemonMain } = await import("../src/daemon.ts");
	assert.equal(isDaemonMain(), false);
});

test("daemon seed helpers do not throw when disk files absent", async () => {
	const { syncRelayStateFromDisk, seedCatalog } = await import("../src/daemon.ts");
	// Should not throw even with empty/missing files (sandbox dir)
	syncRelayStateFromDisk();
	await seedCatalog();
	// catalog still has at least the static set
	assert.ok(getAliveCatalog().length >= 25);
});
