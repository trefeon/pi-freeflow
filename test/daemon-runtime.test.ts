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
 findExecutableOnPath,
 isJsRuntimeExecutable,
 resolveDaemonRuntime,
} from "../src/client.ts";
import { getStartupPlan } from "../src/commands.ts";
import { DAEMON_RUNTIME_ENV, DAEMON_SPAWN_ENV } from "../src/config.ts";
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
