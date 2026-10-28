/**
 * Bun-aware /freeflow update fallback: when npm is missing from PATH but bun
 * is present, the update command must attempt the equivalent bun global
 * install instead of failing with an npm-only manual hint.
 *
 * Covers:
 * 1. Manager preference: npm wins when present, bun covers npm-missing
 *    machines, neither leaves the previous manual hint in place.
 * 2. PATH probing: a shimmed binary on PATH reads available, an unknown or
 *    broken binary reads unavailable.
 * 3. Host plugin-manager order: omp reinstall first, pi package update
 *    second, empty when neither host binary applies.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCommandAvailable, probeCommandsAvailable, selectGlobalUpdatePlan, selectHostUpdateSteps } from "../src/updater.ts";
import { runUpdateStep } from "../src/update-core.ts";

// ── 1. Manager preference ────────────────────────────────────────────────

test("npm is preferred whenever it is on PATH", () => {
	const expected = {
		cmd: "npm",
		args: ["i", "-g", "pi-freeflow@latest"],
		manual: "npm i -g pi-freeflow@latest",
	};
	assert.deepEqual(
		selectGlobalUpdatePlan({ npmAvailable: true, bunAvailable: true }),
		expected,
		"npm must win when both managers are present (legacy behavior unchanged)",
	);
	assert.deepEqual(
		selectGlobalUpdatePlan({ npmAvailable: true, bunAvailable: false }),
		expected,
		"npm-only machines must keep the legacy npm install step",
	);
});

test("bun covers npm-missing machines with the equivalent global command", () => {
	assert.deepEqual(
		selectGlobalUpdatePlan({ npmAvailable: false, bunAvailable: true }),
		{ cmd: "bun", args: ["add", "-g", "pi-freeflow@latest"], manual: "bun add -g pi-freeflow@latest" },
		"bun-only machines must get the bun global install step, not an npm-only hint",
	);
});

test("no manager on PATH leaves the previous manual hint in place", () => {
	assert.equal(
		selectGlobalUpdatePlan({ npmAvailable: false, bunAvailable: false }),
		null,
		"with neither manager the caller must keep its previous manual hint",
	);
});

// ── 2. PATH probing ──────────────────────────────────────────────────────

test("isCommandAvailable rejects unknown binaries", () => {
	assert.equal(isCommandAvailable("definitely-not-a-pi-freeflow-cmd"), false);
	assert.equal(isCommandAvailable("not a binary"), false, "names outside binary syntax must never spawn");
});

test("isCommandAvailable follows PATH for working and broken shims", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-updater-probe-"));
	const prevPath = process.env["PATH"];
	const stem = "pfshim" + process.pid;
	try {
		const okName = process.platform === "win32" ? stem + "-ok.cmd" : stem + "-ok";
		const badName = process.platform === "win32" ? stem + "-bad.cmd" : stem + "-bad";
		if (process.platform === "win32") {
			fs.writeFileSync(path.join(dir, okName), "@echo off" + "\r\n" + "exit /b 0" + "\r\n");
			fs.writeFileSync(path.join(dir, badName), "@echo off" + "\r\n" + "exit /b 3" + "\r\n");
		} else {
			fs.writeFileSync(path.join(dir, okName), "#!/bin/sh" + "\n" + "exit 0" + "\n", { mode: 0o755 });
			fs.writeFileSync(path.join(dir, badName), "#!/bin/sh" + "\n" + "exit 3" + "\n", { mode: 0o755 });
		}
		process.env["PATH"] = dir + path.delimiter + (prevPath ?? "");
		assert.equal(isCommandAvailable(stem + "-ok"), true, "shim exiting 0 must read available");
		assert.equal(isCommandAvailable(stem + "-bad"), false, "shim exiting nonzero must read unavailable");
		assert.equal(isCommandAvailable(stem + "-missing"), false, "absent binary must read unavailable");
	} finally {
		if (prevPath === undefined) delete process.env["PATH"];
		else process.env["PATH"] = prevPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── 3. Host plugin-manager order ───────────────────────────────────────────

test("host steps try omp reinstall then pi update, empty when neither applies", () => {
	assert.deepEqual(
		selectHostUpdateSteps({ ompAvailable: true, piAvailable: true }),
		[
			{
				cmd: "omp",
				args: ["plugin", "install", "pi-freeflow@latest"],
				manual: "omp plugin install pi-freeflow@latest",
			},
			{ cmd: "pi", args: ["update", "pi-freeflow"], manual: "pi update pi-freeflow" },
		],
		"omp reinstall first (update-by-reinstall is the manager semantic), pi package update second",
	);
	assert.deepEqual(
		selectHostUpdateSteps({ ompAvailable: true, piAvailable: false }),
		[
			{
				cmd: "omp",
				args: ["plugin", "install", "pi-freeflow@latest"],
				manual: "omp plugin install pi-freeflow@latest",
			},
		],
		"omp-only machines keep the reinstall step (the old `plugin update` action never existed)",
	);
	assert.deepEqual(
		selectHostUpdateSteps({ ompAvailable: false, piAvailable: true }),
		[{ cmd: "pi", args: ["update", "pi-freeflow"], manual: "pi update pi-freeflow" }],
		"pi-only machines must reach the pi package update, never a bare global install",
	);
	assert.deepEqual(
		selectHostUpdateSteps({ ompAvailable: false, piAvailable: false }),
		[],
		"with no host manager the global npm/bun plan decides",
	);
});

// ── 4. Async update-step runner (src/update-core.ts) ───────────────────────
//
// Installs used to run through spawnSync, which froze the host TUI for the
// whole install when auto-update fired from extension activation, and reported
// a signal-killed child as success.

test("runUpdateStep resolves the exit code without blocking the event loop", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-step-"));
	try {
		// The child genuinely sleeps: the point is that the RUNNER never blocks
		// the parent loop, so a deterministic fake clock cannot express it.
		const slow = path.join(dir, "slow.mjs");
		fs.writeFileSync(slow, "setTimeout(function(){process.exit(0);},300);\n", "utf8");
		const order: string[] = [];
		const step = runUpdateStep(process.execPath, [slow], { timeoutMs: 20_000 }).then((code) => {
			order.push(`step:${code}`);
			return code;
		});
		// setImmediate fires in the check phase of the current turn: under the
		// old spawnSync runner it could not run before the child exited.
		await new Promise<void>((resolve) => {
			setImmediate(() => {
				order.push("immediate");
				resolve();
			});
		});
		assert.equal(await step, 0, "a clean exit must resolve 0");
		assert.equal(
			order[0],
			"immediate",
			`the event loop must stay free while a step runs, got: ${order.join(",")}`,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runUpdateStep streams the step's output lines", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-step-"));
	try {
		const noisy = path.join(dir, "noisy.mjs");
		fs.writeFileSync(noisy, "console.log('installing');\nconsole.log('done');\n", "utf8");
		const lines: string[] = [];
		const code = await runUpdateStep(process.execPath, [noisy], {
			timeoutMs: 20_000,
			onOutput: (line) => lines.push(line),
		});
		assert.equal(code, 0);
		assert.ok(lines.includes("installing") && lines.includes("done"), `output not streamed: ${JSON.stringify(lines)}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runUpdateStep reports a signal-killed step as a failure, never as success", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-step-"));
	try {
		const killed = path.join(dir, "killed.mjs");
		fs.writeFileSync(killed, "process.kill(process.pid, 'SIGKILL');\n", "utf8");
		// close() reports code null for a signal death: resolving 0 there made a
		// killed install print success for /freeflow update.
		assert.equal(
			await runUpdateStep(process.execPath, [killed], { timeoutMs: 20_000 }),
			1,
			"a child killed by a signal must not resolve as exit code 0",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runUpdateStep kills a step that overruns its timeout and reports why", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-step-"));
	try {
		const hung = path.join(dir, "hung.mjs");
		// A real overrun measured against the platform clock is the behaviour
		// under test (the runner's own timeout), so fake timers cannot drive it.
		fs.writeFileSync(hung, "setTimeout(function(){},3000);\n", "utf8");
		const warnings: string[] = [];
		const code = await runUpdateStep(process.execPath, [hung], {
			timeoutMs: 400,
			onWarning: (message) => warnings.push(message),
		});
		assert.equal(code, 1, "a timed-out step must fail");
		assert.ok(
			warnings.some((message) => message.includes("timed out after 400ms")),
			`the timeout must be reported, got: ${JSON.stringify(warnings)}`,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runUpdateStep reports a step it cannot launch as a failure", async () => {
	const warnings: string[] = [];
	const code = await runUpdateStep("definitely-not-a-pi-freeflow-cmd", ["--version"], {
		timeoutMs: 10_000,
		onWarning: (message) => warnings.push(message),
	});
	assert.equal(code, 1, "a step that cannot be launched must fail");
	// Under a Windows shell the unknown command is answered by cmd.exe (exit 1)
	// instead of emitting a spawn error, so only POSIX gets the warning.
	if (process.platform !== "win32") {
		assert.ok(
			warnings.some((message) => message.includes("failed")),
			`the spawn failure must be reported, got: ${JSON.stringify(warnings)}`,
		);
	}
});

test("probeCommandsAvailable matches the sync probe without blocking", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-async-probe-"));
	const prevPath = process.env["PATH"];
	const stem = "pfprobe" + process.pid;
	try {
		const okName = process.platform === "win32" ? stem + "-ok.cmd" : stem + "-ok";
		if (process.platform === "win32") {
			fs.writeFileSync(path.join(dir, okName), "@echo off" + "\r\n" + "exit /b 0" + "\r\n");
		} else {
			fs.writeFileSync(path.join(dir, okName), "#!/bin/sh" + "\n" + "exit 0" + "\n", { mode: 0o755 });
		}
		process.env["PATH"] = dir + path.delimiter + (prevPath ?? "");
		const order: string[] = [];
		const probed = probeCommandsAvailable([stem + "-ok", "definitely-not-a-pi-freeflow-cmd", "not a binary"]).then(
			(results) => {
				order.push(`probed:${results.join(",")}`);
				return results;
			},
		);
		await new Promise<void>((resolve) => {
			setImmediate(() => {
				order.push("immediate");
				resolve();
			});
		});
		assert.deepEqual(await probed, [true, false, false], "shim ok, unknown no, invalid name no");
		assert.equal(order[0], "immediate", `probes must not block the loop, got: ${order.join(",")}`);
	} finally {
		if (prevPath === undefined) delete process.env["PATH"];
		else process.env["PATH"] = prevPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
