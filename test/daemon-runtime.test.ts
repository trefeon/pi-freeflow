/**
 * Unit & regression tests for proxy daemon runtime resolution and fork-bomb prevention.
 *
 * Covers issue #12:
 * "Launching omp with pi-freeflow 1.14.0 spawns unbounded omp child processes until the machine OOMs"
 *
 * Root cause:
 * When omp is installed as a prebuilt binary (via https://omp.sh/install),
 * process.execPath is the `omp` binary itself (not `node` or `bun`).
 * Previously, spawnDaemonProcess() blindly executed `process.execPath` with `daemon.ts`,
 * which launched interactive `omp` sessions that loaded the extension and recursively
 * spawned more `omp` processes, creating an exponential fork bomb.
 *
 * Fix:
 * 1. isJsRuntimeExecutable() validates that an executable is actually Node or Bun.
 * 2. resolveDaemonRuntime() detects non-runtime hosts (omp, pi, electron) and searches
 *    PATH for bun or node.
 * 3. If neither is found, it returns null and falls back to in-process proxying (no spawn).
 * 4. Children are always spawned with DAEMON_SPAWN_ENV="0" to guarantee zero recursion.
 * 5. getStartupPlan() resolves the real runtime instead of embedding `omp` into systemd/schtasks.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
 _resetClientForTest,
 _setDaemonSpawnForTest,
 ensureDaemon,
 findExecutableOnPath,
 hasChildExited,
 hasFallbackServer,
 isJsRuntimeExecutable,
 materializeDaemonSources,
 resolveDaemonRuntime,
 waitForReady,
} from "../src/client.ts";
import { getStartupPlan } from "../src/commands.ts";
import { DAEMON_RUNTIME_ENV, DAEMON_SPAWN_ENV, PORT } from "../src/config.ts";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { killPortHolder } from "../src/proxy.ts";
const isWin = process.platform === "win32";

test("isJsRuntimeExecutable: correctly classifies node binaries", () => {
 assert.equal(isJsRuntimeExecutable("node"), "node");
 assert.equal(isJsRuntimeExecutable("node.exe"), "node");
 assert.equal(isJsRuntimeExecutable("NODE.EXE"), "node");
 assert.equal(isJsRuntimeExecutable("nodejs"), "node");
 assert.equal(isJsRuntimeExecutable("nodejs.exe"), "node");
 assert.equal(isJsRuntimeExecutable("/usr/bin/node"), "node");
 assert.equal(isJsRuntimeExecutable("/usr/local/bin/nodejs"), "node");
 assert.equal(isJsRuntimeExecutable("C:\\Program Files\\nodejs\\node.exe"), "node");
});

test("isJsRuntimeExecutable: correctly classifies bun binaries", () => {
 assert.equal(isJsRuntimeExecutable("bun"), "bun");
 assert.equal(isJsRuntimeExecutable("bun.exe"), "bun");
 assert.equal(isJsRuntimeExecutable("BUN.EXE"), "bun");
 assert.equal(isJsRuntimeExecutable("bunx"), "bun");
 assert.equal(isJsRuntimeExecutable("bunx.exe"), "bun");
 assert.equal(isJsRuntimeExecutable("/usr/bin/bun"), "bun");
 assert.equal(isJsRuntimeExecutable("/home/user/.bun/bin/bun"), "bun");
 assert.equal(isJsRuntimeExecutable("C:\\Users\\user\\.bun\\bin\\bun.exe"), "bun");
});

test("isJsRuntimeExecutable: rejects agent and host binaries (fork-bomb prevention)", () => {
 assert.equal(isJsRuntimeExecutable("omp"), null);
 assert.equal(isJsRuntimeExecutable("omp.exe"), null);
 assert.equal(isJsRuntimeExecutable("/home/user/.local/bin/omp"), null);
 assert.equal(isJsRuntimeExecutable("/usr/local/bin/omp"), null);
 assert.equal(isJsRuntimeExecutable("/opt/omp/omp-linux-x64"), null);
 assert.equal(isJsRuntimeExecutable("pi"), null);
 assert.equal(isJsRuntimeExecutable("pi.exe"), null);
 assert.equal(isJsRuntimeExecutable("/usr/local/bin/pi"), null);
 assert.equal(isJsRuntimeExecutable("electron"), null);
 assert.equal(isJsRuntimeExecutable("Code.exe"), null);
 assert.equal(isJsRuntimeExecutable("bash"), null);
 assert.equal(isJsRuntimeExecutable(""), null);
});

test("findExecutableOnPath: locates binary in mock PATH directory", () => {
 const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-path-test-"));
 try {

  const binName = isWin ? "mock-bun.exe" : "mock-bun";
  const binPath = path.join(tmpDir, binName);
  fs.writeFileSync(binPath, "#!/bin/sh\necho ok\n");
  if (!isWin) {
   fs.chmodSync(binPath, 0o755);
  }

  const found = findExecutableOnPath("mock-bun", tmpDir);
  assert.ok(found, "should find mock-bun in tmpDir");
  assert.equal(path.resolve(found!).toLowerCase(), path.resolve(binPath).toLowerCase());
  // Search for non-existent binary returns null
  assert.equal(findExecutableOnPath("non-existent-binary-12345", tmpDir), null);
 } finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
 }
});

test("resolveDaemonRuntime: uses currentExecPath when it is node", () => {
 const runtime = resolveDaemonRuntime({
  currentExecPath: "/usr/bin/node",
  scriptPath: "/path/to/daemon.ts",
 });
 assert.ok(runtime);
 assert.equal(runtime!.execPath, "/usr/bin/node");
 assert.equal(runtime!.runtimeType, "node");
 assert.deepEqual(runtime!.args, ["--experimental-strip-types", "/path/to/daemon.ts"]);
});

test("resolveDaemonRuntime: uses currentExecPath when it is bun", () => {
 const runtime = resolveDaemonRuntime({
  currentExecPath: "/home/user/.bun/bin/bun",
  scriptPath: "/path/to/daemon.ts",
 });
 assert.ok(runtime);
 assert.equal(runtime!.execPath, "/home/user/.bun/bin/bun");
 assert.equal(runtime!.runtimeType, "bun");
 assert.deepEqual(runtime!.args, ["/path/to/daemon.ts"]);
});

test("resolveDaemonRuntime: honors explicit override (opts and env var)", () => {
 // Via opts
 const custom = resolveDaemonRuntime({
  overrideExecPath: "/opt/custom/bun",
  scriptPath: "/path/to/daemon.ts",
 });
 assert.ok(custom);
 assert.equal(custom!.execPath, "/opt/custom/bun");
 assert.equal(custom!.runtimeType, "bun");
 assert.deepEqual(custom!.args, ["/path/to/daemon.ts"]);

 // Via environment variable
 const prevEnv = process.env[DAEMON_RUNTIME_ENV];
 try {
  process.env[DAEMON_RUNTIME_ENV] = "/opt/custom/node";
  const fromEnv = resolveDaemonRuntime({
   scriptPath: "/path/to/daemon.ts",
  });
  assert.ok(fromEnv);
  assert.equal(fromEnv!.execPath, "/opt/custom/node");
  assert.equal(fromEnv!.runtimeType, "node");
 } finally {
  if (prevEnv !== undefined) {
   process.env[DAEMON_RUNTIME_ENV] = prevEnv;
  } else {
   delete process.env[DAEMON_RUNTIME_ENV];
  }
 }
});

test("resolveDaemonRuntime: issue #12 repro — when running under omp with bun on PATH, resolves bun", () => {
 const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-issue12-bun-"));
 try {

  const bunName = isWin ? "bun.exe" : "bun";
  const bunPath = path.join(tmpDir, bunName);
  fs.writeFileSync(bunPath, "");
  if (!isWin) fs.chmodSync(bunPath, 0o755);

  // Current executable is omp (the issue #12 report condition)
  const runtime = resolveDaemonRuntime({
   currentExecPath: "/home/user/.local/bin/omp",
   scriptPath: "/path/to/daemon.ts",
   envPath: tmpDir,
  });

  assert.ok(runtime);
  assert.equal(path.resolve(runtime!.execPath).toLowerCase(), path.resolve(bunPath).toLowerCase());
  assert.deepEqual(runtime!.args, ["/path/to/daemon.ts"]);
  assert.notEqual(runtime!.execPath, "/home/user/.local/bin/omp", "must NEVER use omp as the runtime");
 } finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
 }
});

test("resolveDaemonRuntime: issue #12 repro — when running under omp with node on PATH, resolves node", () => {
 const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-issue12-node-"));
 try {

  const nodeName = isWin ? "node.exe" : "node";
  const nodePath = path.join(tmpDir, nodeName);
  fs.writeFileSync(nodePath, "");
  if (!isWin) fs.chmodSync(nodePath, 0o755);

  // Current executable is omp
  const runtime = resolveDaemonRuntime({
   currentExecPath: "/home/user/.local/bin/omp",
   scriptPath: "/path/to/daemon.ts",
   envPath: tmpDir,
  });

  assert.ok(runtime);
  assert.equal(path.resolve(runtime!.execPath).toLowerCase(), path.resolve(nodePath).toLowerCase());
  assert.deepEqual(runtime!.args, ["--experimental-strip-types", "/path/to/daemon.ts"]);
  assert.notEqual(runtime!.execPath, "/home/user/.local/bin/omp", "must NEVER use omp as the runtime");
 } finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
 }
});

test("resolveDaemonRuntime: issue #12 repro — when running under omp with neither bun nor node, returns null (fallback to in-process)", () => {
 const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-issue12-empty-"));
 try {
  // Current executable is omp, and PATH has no bun or node
  const runtime = resolveDaemonRuntime({
   currentExecPath: "/home/user/.local/bin/omp",
   scriptPath: "/path/to/daemon.ts",
   envPath: emptyDir,
  });

  assert.equal(runtime, null, "must return null to prevent spawning non-runtime host (falling back to in-process proxy)");
 } finally {
  fs.rmSync(emptyDir, { recursive: true, force: true });
 }
});

test("getStartupPlan: generates correct commands for bun and node runtimes without using omp", () => {
 // Node explicit
 const nodePlan = getStartupPlan({
  platform: "linux",
  execPath: "/usr/bin/node",
  scriptPath: "/path/to/daemon.ts",
 });
 assert.match(nodePlan.fileContent, /"\/usr\/bin\/node" --experimental-strip-types "\/path\/to\/daemon\.ts"/);

 // Bun explicit (zero flags)
 const bunPlan = getStartupPlan({
  platform: "linux",
  execPath: "/usr/bin/bun",
  scriptPath: "/path/to/daemon.ts",
 });
 assert.match(bunPlan.fileContent, /"\/usr\/bin\/bun" "\/path\/to\/daemon\.ts"/);
 assert.ok(!bunPlan.fileContent.includes("--experimental-strip-types"), "bun command should not pass node flag");

 // When execPath is not specified, it must not embed omp
 const autoPlan = getStartupPlan({
  platform: "linux",
  scriptPath: "/path/to/daemon.ts",
 });
 assert.ok(!autoPlan.fileContent.includes('"omp"'), "startup plan must never embed omp binary");
});

// ── Issue #52: Node refuses type stripping for files under node_modules ──

test("materializeDaemonSources: stages src, package.json and deps outside node_modules", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "ff-stage-"));
	try {
		const pkgRoot = path.join(base, "node_modules", "pi-freeflow");
		fs.mkdirSync(path.join(pkgRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, "src", "daemon.ts"), "export {};\n");
		fs.writeFileSync(path.join(pkgRoot, "src", "config.ts"), "export const x = 1;\n");
		fs.writeFileSync(
			path.join(pkgRoot, "package.json"),
			JSON.stringify({
				name: "pi-freeflow",
				version: "9.9.9",
				type: "module",
				dependencies: { undici: "^7.0.0" },
			}),
		);
		const depDir = path.join(base, "node_modules", "undici");
		fs.mkdirSync(depDir, { recursive: true });
		fs.writeFileSync(path.join(depDir, "package.json"), JSON.stringify({ name: "undici", version: "7.0.0" }));

		const cacheRoot = path.join(base, "cache");
		const staged = materializeDaemonSources(path.join(pkgRoot, "src", "daemon.ts"), cacheRoot);

		assert.equal(staged, path.join(cacheRoot, "9.9.9", "src", "daemon.ts"));
		assert.equal(staged.includes("node_modules"), false, "staged entry must live outside node_modules");
		assert.ok(fs.existsSync(staged), "staged daemon entry must exist");
		assert.ok(fs.existsSync(path.join(cacheRoot, "9.9.9", "src", "config.ts")), "whole src tree must be staged");
		assert.match(fs.readFileSync(path.join(cacheRoot, "9.9.9", "package.json"), "utf8"), /"version":\s*"9\.9\.9"/);
		assert.ok(
			fs.existsSync(path.join(cacheRoot, "9.9.9", "node_modules", "undici", "package.json")),
			"runtime dependency must resolve from the staged tree",
		);

		// Second call reuses the staged copy and leaves no temp dirs behind.
		assert.equal(materializeDaemonSources(path.join(pkgRoot, "src", "daemon.ts"), cacheRoot), staged);
		assert.deepEqual(fs.readdirSync(cacheRoot).filter((entry) => entry.includes(".tmp-")), []);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("materializeDaemonSources: passes a script outside node_modules through unchanged", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "ff-stage-plain-"));
	try {
		const script = path.join(base, "src", "daemon.ts");
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.writeFileSync(script, "export {};\n");
		assert.equal(materializeDaemonSources(script, path.join(base, "cache")), script);
		assert.equal(fs.existsSync(path.join(base, "cache")), false, "no staging for dev checkouts");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("waitForReady: aborts when the spawned child exits instead of polling the full timeout", async () => {
	const child = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" });
	try {
		await once(child, "exit");
		assert.equal(hasChildExited(child), true, "exited child must be detected");
		const t0 = Date.now();
		const ready = await waitForReady(65533, 5000, child);
		const elapsed = Date.now() - t0;
		assert.equal(ready, false);
		assert.ok(elapsed < 1500, `ready-wait must abort on child exit, took ${elapsed}ms`);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
});

test("hasChildExited: false while running, true after exit code or signal", () => {
	assert.equal(hasChildExited({ exitCode: null, signalCode: null }), false);
	assert.equal(hasChildExited({ exitCode: 1, signalCode: null }), true);
	assert.equal(hasChildExited({ exitCode: null, signalCode: "SIGKILL" }), true);
});

test("ensureDaemon: falls back in-process fast when the spawned child exits (issue #52)", async () => {
	await killPortHolder(PORT);
	_resetClientForTest();
	const spawnCalls: string[][] = [];
	const fakeChild = Object.assign(new EventEmitter(), {
		pid: 424242,
		exitCode: 1,
		signalCode: null,
		unref() {},
	});
	_setDaemonSpawnForTest((command, args) => {
		spawnCalls.push([command, ...args]);
		return fakeChild;
	});
	try {
		const t0 = Date.now();
		const port = await ensureDaemon();
		const elapsed = Date.now() - t0;
		assert.ok(spawnCalls.length >= 1, "the detached spawn must have been attempted");
		assert.equal(typeof port, "number");
		assert.equal(hasFallbackServer(), true, "a dead child must fall through to the in-process proxy");
		assert.ok(elapsed < 1500, `cold start with a dead child must fail fast, took ${elapsed}ms`);
	} finally {
		_setDaemonSpawnForTest(null);
		_resetClientForTest();
	}
});

test("getStartupPlan: stages the daemon entry outside node_modules for node runtimes", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "ff-plan-stage-"));
	try {
		const pkgRoot = path.join(base, "node_modules", "pi-freeflow");
		fs.mkdirSync(path.join(pkgRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, "src", "daemon.ts"), "export {};\n");
		fs.writeFileSync(
			path.join(pkgRoot, "package.json"),
			JSON.stringify({ name: "pi-freeflow", version: "9.9.9", type: "module" }),
		);
		const script = path.join(pkgRoot, "src", "daemon.ts");
		const nodePlan = getStartupPlan({
			platform: "linux",
			homeDir: base,
			execPath: path.join(base, "bin", isWin ? "node.exe" : "node"),
			scriptPath: script,
		});
		assert.ok(nodePlan.fileContent.includes("--experimental-strip-types"), "node runtime must keep the strip-types flag");
		assert.ok(!nodePlan.fileContent.includes("node_modules"), "hook must not point node at a node_modules TypeScript file");
		const bunPlan = getStartupPlan({
			platform: "linux",
			homeDir: base,
			execPath: path.join(base, "bin", isWin ? "bun.exe" : "bun"),
			scriptPath: script,
		});
		assert.ok(bunPlan.fileContent.includes(script), "bun runs TypeScript anywhere — hook keeps the installed path");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});
