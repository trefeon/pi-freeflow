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
import { isCommandAvailable, selectGlobalUpdatePlan, selectHostUpdateSteps } from "../src/updater.ts";

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
