/**
 * A dark holder on the base port — a process that accepts TCP connections but
 * never answers HTTP, e.g. a frozen (SIGSTOP) daemon — must not strand the
 * client on the in-process fallback. Recovery must end on a detached daemon
 * bound to the base port, with no orphan daemon left on a walked port.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	_resetClientForTest,
	_setDaemonSpawnForTest,
	ensureDaemon,
	hasChildExited,
	hasFallbackServer,
} from "../src/client.ts";
import { DAEMON_NO_WALK_ENV, DEFAULT_PORT, HOST, PORT } from "../src/config.ts";
import { isPortBound, isProxyAlive, killPortHolder } from "../src/proxy.ts";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(rootDir, "src", "daemon.ts");

function assertSandboxPort(): void {
	if (PORT === DEFAULT_PORT) {
		throw new Error(
			`dark-holder-spawn.test.ts: refusing to run on the default proxy port ${DEFAULT_PORT} — ` +
			`run this file via test/setup.mjs (npm test), which re-roots the port and data dir`,
		);
	}
}

/** Start a child that binds `port`, accepts connections and never answers. */
async function startDarkHolder(port: number): Promise<ChildProcess> {
	const script =
		`const s = require("node:net").createServer(() => {});` +
		`s.listen(${port}, ${JSON.stringify(HOST)}, () => process.stdout.write("ready\\n"));`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	child.stdout?.on("data", (buf: Buffer) => {
		if (buf.toString().includes("ready")) resolve();
	});
	child.once("exit", (code) => reject(new Error(`dark holder exited early (code ${code})`)));
	await promise;
	return child;
}

function stopChild(child: ChildProcess | null): void {
	if (child && !hasChildExited(child)) child.kill("SIGKILL");
}

/** Reap whatever this file left on the suite port and the first walked port. */
async function cleanupPorts(): Promise<void> {
	await killPortHolder(PORT);
	await killPortHolder(PORT + 1);
}

test("ensureDaemon: a dark holder on the base port is reclaimed before the daemon spawns", async () => {
	assertSandboxPort();
	await cleanupPorts();
	_resetClientForTest();
	const holder = await startDarkHolder(PORT);
	let spawns = 0;
	_setDaemonSpawnForTest((command, args, options) => {
		spawns++;
		return spawn(command, args, options);
	});
	try {
		const port = await ensureDaemon();
		assert.equal(port, PORT, "the client must end on the base port");
		assert.equal(hasFallbackServer(), false, "a frozen holder must not push the client onto the in-process proxy");
		assert.equal(spawns, 1, "exactly one daemon spawn");
		assert.equal(await isProxyAlive(PORT), true, "a detached daemon must answer on the base port");
		assert.equal(await isPortBound(PORT + 1), false, "no daemon may be left on a walked port");
	} finally {
		_setDaemonSpawnForTest(null);
		_resetClientForTest();
		stopChild(holder);
		await cleanupPorts();
	}
});

test("daemon: spawned with the no-walk flag, it exits instead of walking off a busy base port", async () => {
	assertSandboxPort();
	await cleanupPorts();
	const holder = await startDarkHolder(PORT);
	const daemon = spawn(process.execPath, ["--experimental-strip-types", daemonEntry], {
		stdio: "ignore",
		env: { ...process.env, [DAEMON_NO_WALK_ENV]: "1" },
	});
	try {
		const exited = once(daemon, "exit");
		const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000).unref());
		const result = await Promise.race([exited, timeout]);
		assert.notEqual(result, "timeout", "the daemon must exit, not keep running on a walked port");
		assert.notEqual(daemon.exitCode, 0, "a failed bind is a failure exit");
		assert.equal(await isPortBound(PORT + 1), false, "nothing may bind the walked port");
	} finally {
		stopChild(daemon);
		stopChild(holder);
		await cleanupPorts();
	}
});

test("ensureDaemon: a spawn that turns into a dark holder is reclaimed and respawned once", async () => {
	assertSandboxPort();
	await cleanupPorts();
	_resetClientForTest();
	let spawns = 0;
	let darkChild: ChildProcess | null = null;
	_setDaemonSpawnForTest((command, args, options) => {
		spawns++;
		if (spawns === 1) {
			// The first "daemon" binds the base port and then hangs.
			const script =
				`const s = require("node:net").createServer(() => {});` +
				`s.listen(${PORT}, ${JSON.stringify(HOST)});`;
			darkChild = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
			return darkChild;
		}
		return spawn(command, args, options);
	});
	try {
		const port = await ensureDaemon();
		assert.equal(port, PORT, "the client must end on the base port");
		assert.equal(hasFallbackServer(), false, "the reclaimed port must go to a fresh daemon, not the in-process proxy");
		assert.equal(spawns, 2, "one respawn after the dark holder was killed");
		assert.equal(await isProxyAlive(PORT), true, "a detached daemon must answer on the base port");
	} finally {
		_setDaemonSpawnForTest(null);
		_resetClientForTest();
		stopChild(darkChild);
		await cleanupPorts();
	}
});
