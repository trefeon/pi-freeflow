/**
 * Auto-recovery upgrade tests — watchdog matrix, breaker, bypass, install hooks.
 * Sandboxed: DATA_DIR is already re-rooted to tmp by test/setup.mjs; relay
 * disk files are untouched (in-memory state only, restored after), startup
 * hook file writes go to a fresh tmp homeDir, proxy binds use ephemeral ports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type * as http from "node:http";

import {
	BUSY_BYPASS_CONTINUOUS_MS,
	BUSY_BYPASS_QUIET_MS,
	BREAKER_HALT_MS,
	DAEMON_CONTROL_TIMEOUT_MS,
	DAEMON_CONTROL_TIMEOUT_MS_ENV,
	DAEMON_SPAWN_ENV,
	PKG_VERSION,
} from "../src/config.ts";
import {
	computeRecoveryBackoffMs,
	isBreakerHalted,
	isStuckBusy,
	recordRecoveryFailure,
	recordRecoverySuccess,
	shouldRecoverOnHealth,
	trackBusyEdge,
	_resetClientForTest,
	_getRecoveryStateForTest,
	_resetRecoveryForTest,
	getControlTimeoutMs,
} from "../src/client.ts";
import {
	getLastForwardedByteAt,
	getSseStats,
	pipeUpstreamStream,
	recordSseOutcome,
	_resetSseStatsForTest,
} from "../src/stream-pipe.ts";
import { getHealthData } from "../src/health.ts";
import { getActiveRelayState, setActiveRelayState } from "../src/relay-state.ts";
import { isProxyAlive, reprobeBasePortAlive, startProxy } from "../src/proxy.ts";
import { getStartupPlan, installStartupHook, uninstallStartupHook } from "../src/commands.ts";

// ── backoff ──────────────────────────────────────────────────────────────

test("backoff doubles from 2s and caps at 60s", () => {
	assert.equal(computeRecoveryBackoffMs(0, 0), 2_000);
	assert.equal(computeRecoveryBackoffMs(1, 0), 4_000);
	assert.equal(computeRecoveryBackoffMs(2, 0), 8_000);
	assert.equal(computeRecoveryBackoffMs(4, 0), 32_000);
	assert.equal(computeRecoveryBackoffMs(5, 0), 60_000);
	assert.equal(computeRecoveryBackoffMs(10, 0), 60_000);
});

// ── breaker ──────────────────────────────────────────────────────────────

test("breaker opens after 5 straight failures, success resets", () => {
	_resetRecoveryForTest();
	const t0 = Date.now();
	for (let i = 0; i < 4; i++) {
		assert.equal(recordRecoveryFailure(t0 + i * 1000), false);
	}
	assert.equal(isBreakerHalted(t0 + 4000), false);
	assert.equal(recordRecoveryFailure(t0 + 4000), true);
	assert.equal(isBreakerHalted(t0 + 5000), true);
	assert.equal(isBreakerHalted(t0 + BREAKER_HALT_MS + 5000), false);
	recordRecoverySuccess();
	assert.equal(isBreakerHalted(t0 + 5000), false);
	assert.equal(_getRecoveryStateForTest().failures.length, 0);
	_resetRecoveryForTest();
});

test("breaker window slides: stale failures age out", () => {
	_resetRecoveryForTest();
	const t0 = Date.now();
	recordRecoveryFailure(t0);
	recordRecoveryFailure(t0 + 1000);
	// 6 minutes later the first two are outside the 5min window.
	assert.equal(recordRecoveryFailure(t0 + 6 * 60_000), false);
	assert.equal(_getRecoveryStateForTest().failures.length, 1);
	_resetRecoveryForTest();
});

// ── watchdog matrix ──────────────────────────────────────────────────────

test("watchdog matrix: gone/version/sse trigger, healthy does not", () => {
	assert.equal(shouldRecoverOnHealth(null), true);
	assert.equal(
		shouldRecoverOnHealth({ version: "0.0.0-test", activeRequests: 0 }),
		true,
	);
	assert.equal(
		shouldRecoverOnHealth({ version: PKG_VERSION, activeRequests: 0 }),
		false,
	);
	assert.equal(
		shouldRecoverOnHealth({ version: PKG_VERSION, sseDegraded: true }),
		true,
	);
	assert.equal(
		shouldRecoverOnHealth({ version: PKG_VERSION, sseDegraded: false }),
		false,
	);
	assert.equal(
		shouldRecoverOnHealth({ version: PKG_VERSION, sseDegraded: undefined }),
		false,
		"pre-window daemon without sse fields must not trigger",
	);
});

// ── busy bypass ──────────────────────────────────────────────────────────

test("busy bypass only after 5min continuous busy with 60s+ quiet bytes", () => {
	const now = Date.now();
	assert.equal(isStuckBusy(0, 0, now), false);
	assert.equal(
		isStuckBusy(now - 4 * 60_000, 0, now),
		false,
		"4min busy is not enough",
	);
	assert.equal(
		isStuckBusy(now - BUSY_BYPASS_CONTINUOUS_MS - 1000, now - 30_000, now),
		false,
		"recent bytes block the bypass",
	);
	assert.equal(
		isStuckBusy(now - BUSY_BYPASS_CONTINUOUS_MS - 1000, now - BUSY_BYPASS_QUIET_MS - 1000, now),
		true,
	);
	assert.equal(
		isStuckBusy(now - 6 * 60_000, 0, now),
		true,
		"never-streamed busy daemon counts as quiet",
	);
});

test("trackBusyEdge sets on busy, clears on idle", () => {
	_resetRecoveryForTest();
	const now = Date.now();
	assert.equal(trackBusyEdge(2, 0, now), now);
	assert.equal(_getRecoveryStateForTest().busySince, now);
	assert.equal(trackBusyEdge(0, 0, now + 1000), 0);
	_resetRecoveryForTest();
	_resetClientForTest();
});

// ── failed-SSE rolling window ────────────────────────────────────────────

test("sse window records rate and degrades above 50% with enough samples", () => {
	_resetSseStatsForTest();
	assert.deepEqual(getSseStats(), { failures: 0, total: 0, rate: 0, degraded: false });
	recordSseOutcome(true);
	assert.equal(getSseStats().degraded, false, "single sample must not flap");
	recordSseOutcome(true);
	recordSseOutcome(true);
	recordSseOutcome(false);
	recordSseOutcome(false);
	const s = getSseStats();
	assert.equal(s.total, 5);
	assert.equal(s.failures, 3);
	assert.equal(s.rate, 0.6);
	assert.equal(s.degraded, true);
	_resetSseStatsForTest();
});

test("sse window caps at 20 streams", () => {
	_resetSseStatsForTest();
	for (let i = 0; i < 25; i++) recordSseOutcome(true);
	const s = getSseStats();
	assert.equal(s.total, 20);
	assert.equal(s.failures, 20);
	assert.equal(s.degraded, true);
	_resetSseStatsForTest();
});

class FakeResponse extends EventEmitter {
	headersSent = false;
	writableEnded = false;
	write(): boolean {
		return true;
	}
	end(): void {
		this.writableEnded = true;
	}
}

class FakeRequest extends EventEmitter {
	url = "/v1/chat/completions";
}

test("stream data touches lastBytesAt", async () => {
	_resetSseStatsForTest();
	assert.equal(getLastForwardedByteAt(), 0);
	const stream = new PassThrough();
	const res = new FakeResponse();
	const req = new FakeRequest();
	pipeUpstreamStream(
		stream,
		res as unknown as http.ServerResponse,
		req as unknown as http.IncomingMessage,
		"test",
		undefined,
	);
	stream.write(Buffer.from("data: hello\n\n", "utf8"));
	await new Promise<void>((r) => setImmediate(r));
	assert.ok(getLastForwardedByteAt() > 0);
	stream.end();
	await new Promise<void>((r) => setTimeout(r, 20));
	_resetSseStatsForTest();
});

// ── health exposes sse ───────────────────────────────────────────────────

test("health snapshot exposes sse window and lastBytesAt", () => {
	const orig = JSON.parse(JSON.stringify(getActiveRelayState()));
	_resetSseStatsForTest();
	try {
		recordSseOutcome(true);
		recordSseOutcome(false);
		const d = getHealthData(28180, 0);
		assert.equal(d.sseTotal, 2);
		assert.equal(d.sseFailed, 1);
		assert.equal(d.sseRate, 0.5);
		assert.equal(d.sseDegraded, false);
		assert.equal(typeof d.lastBytesAt, "number");
		assert.equal(d.version, PKG_VERSION);
	} finally {
		setActiveRelayState(orig, false);
		_resetSseStatsForTest();
	}
});

// ── control timeout env ──────────────────────────────────────────────────

test("control timeout honors env override, falls back to per-OS default", () => {
	const key = DAEMON_CONTROL_TIMEOUT_MS_ENV;
	const prev = process.env[key];
	try {
		process.env[key] = "1234";
		assert.equal(getControlTimeoutMs(), 1234);
		process.env[key] = "bogus";
		assert.equal(getControlTimeoutMs(), DAEMON_CONTROL_TIMEOUT_MS);
		delete process.env[key];
		assert.equal(getControlTimeoutMs(), DAEMON_CONTROL_TIMEOUT_MS);
	} finally {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
});

// ── base-port reprobe ────────────────────────────────────────────────────

test("reprobe finds a live proxy and misses a closed port", async () => {
	const { server, port } = await startProxy(0);
	try {
		assert.equal(await isProxyAlive(port), true);
		assert.equal(await reprobeBasePortAlive(port, 500), true);
	} finally {
		await new Promise<void>((r) => server!.close(() => r()));
	}
	assert.equal(await reprobeBasePortAlive(29998, 300), false);
});

// ── install hooks ────────────────────────────────────────────────────────

test("startup plan: windows logon task is single-shot with undo", () => {
	const p = getStartupPlan({ platform: "win32", execPath: "C:\\node.exe", scriptPath: "D:\\daemon.ts" });
	assert.match(p.command, /schtasks \/create/);
	assert.match(p.command, /onlogon/);
	assert.match(p.undo, /schtasks \/delete/);
	assert.equal(getStartupPlan({ platform: "win32" }).command, getStartupPlan({ platform: "win32" }).command);
});

test("startup plan: linux unit is single-shot oneshot with undo", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-home-"));
	try {
		const p = getStartupPlan({ platform: "linux", homeDir: home });
		assert.match(p.fileContent, /Type=oneshot/);
		assert.match(p.fileContent, /WantedBy=default\.target/);
		assert.match(p.undo, /systemctl --user disable/);
		assert.ok(p.filePath.startsWith(home));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("startup install/uninstall is idempotent with undo output (linux, tmp home)", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "ff-home-"));
	const spawnKey = DAEMON_SPAWN_ENV;
	const prev = process.env[spawnKey];
	try {
		delete process.env[spawnKey];
		const first = installStartupHook({ platform: "linux", homeDir: home });
		assert.equal(first.ok, true);
		assert.equal(first.changed, true);
		assert.ok(first.undo.length > 0);
		const again = installStartupHook({ platform: "linux", homeDir: home });
		assert.equal(again.ok, true);
		assert.equal(again.changed, false);
		assert.ok(again.detail.includes("already installed"));
		const rm = uninstallStartupHook({ platform: "linux", homeDir: home });
		assert.equal(rm.ok, true);
		assert.equal(rm.changed, true);
		const rmAgain = uninstallStartupHook({ platform: "linux", homeDir: home });
		assert.equal(rmAgain.changed, false);
		assert.ok(rmAgain.detail.includes("already removed"));
	} finally {
		if (prev === undefined) delete process.env[spawnKey];
		else process.env[spawnKey] = prev;
		fs.rmSync(home, { recursive: true, force: true });
		_resetClientForTest();
	}
});

test("startup hooks refuse when spawn disabled", () => {
	const key = DAEMON_SPAWN_ENV;
	const prev = process.env[key];
	try {
		process.env[key] = "0";
		assert.equal(installStartupHook({ platform: "linux", homeDir: os.tmpdir() }).ok, false);
		assert.equal(uninstallStartupHook({ platform: "linux", homeDir: os.tmpdir() }).ok, false);
	} finally {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
});
