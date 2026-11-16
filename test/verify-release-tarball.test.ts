/**
 * Focused tests for the release-tarball gate (scripts/verify-release-tarball.mjs).
 *
 * The gate packs the checkout and compares the result against the tree, so a
 * stale, dirty, or wrongly named asset can never be attached to a release.
 * The npm calls are stubbed: these tests never touch a registry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	compareFileLists,
	// @ts-expect-error: verify-release-tarball.mjs is an executable script without generated d.ts
} from "../scripts/verify-release-tarball.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "verify-release-tarball.mjs");
const IS_WINDOWS = process.platform === "win32";
const REPO_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const ASSET = `pi-freeflow-${REPO_VERSION}.tgz`;

const probe = (command: string, args: string[]): boolean => {
	try {
		return spawnSync(command, args, { encoding: "utf8", timeout: 30_000 }).status === 0;
	} catch {
		return false;
	}
};

const SKIP_NO_TAR = probe("tar", ["--version"]) ? undefined : "tar is unavailable on this host";

function withTempDir(run: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tarball-gate-"));
	try {
		run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Installs a PATH-resolved `npm` stub that replays the fixture staged in the
 * environment: `pack --dry-run --json` prints the tree list, and plain `pack`
 * copies the fixture tarball into the `--pack-destination` directory,
 * preserving its file name. cmd.exe resolves extensionless scripts only
 * through PATHEXT, so Windows gets a .cmd twin with the same behavior.
 */
function makeNpmStub(dir: string): Record<string, string> {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(
		path.join(bin, "npm"),
		`#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_STUB_DIR/argv.log"
if [ "$1" = "pack" ] && [ "$2" = "--dry-run" ]; then cat "$NPM_STUB_TREE_JSON"; exit 0; fi
if [ "$1" = "pack" ]; then cp "$NPM_STUB_TARBALL" "$3/"; exit 0; fi
exit 0
`,
	);
	fs.chmodSync(path.join(bin, "npm"), 0o755);
	if (IS_WINDOWS) {
		fs.writeFileSync(
			path.join(bin, "npm.cmd"),
			`@echo off\r
echo %* >> "%NPM_STUB_DIR%\\argv.log"\r
if "%2"=="--dry-run" (type "%NPM_STUB_TREE_JSON%" & exit /b 0)\r
if "%1"=="pack" (copy /y "%NPM_STUB_TARBALL%" "%~3" >nul & exit /b 0)\r
exit /b 0\r
`,
		);
	}
	return { PATH: bin + path.delimiter + (process.env.PATH ?? "") };
}

/** Builds a real tgz whose members are `package/<relative>` entries. */
function buildTarball(dir: string, members: Record<string, string | Buffer>, name = ASSET): string {
	const work = path.join(dir, "work");
	fs.mkdirSync(path.join(work, "package"), { recursive: true });
	for (const [relative, content] of Object.entries(members)) {
		const target = path.join(work, "package", relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	const packed = spawnSync("tar", ["-czf", name, "-C", "work", "package"], {
		cwd: dir,
		encoding: "utf8",
	});
	assert.equal(packed.status, 0, `${packed.stdout ?? ""}${packed.stderr ?? ""}`);
	return path.join(dir, name);
}

/** Runs the shipped CLI against the fixture in `dir`; returns status + output. */
function runGate(
	dir: string,
	fixture: { tarball: string; treeFiles: string[] },
): { status: number | null; output: string } {
	const treeJson = path.join(dir, "tree.json");
	fs.writeFileSync(treeJson, JSON.stringify([{ files: fixture.treeFiles.map((file) => ({ path: file })) }]));
	const result = spawnSync(process.execPath, [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			...makeNpmStub(dir),
			NPM_STUB_DIR: path.join(dir, "bin"),
			NPM_STUB_TREE_JSON: treeJson,
			NPM_STUB_TARBALL: fixture.tarball,
		},
	});
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("compareFileLists reports files the tarball lacks and files the tree lacks", () => {
	const local = ["package.json", "src/catalog.ts", "src/only-local.ts"];
	const published = ["package.json", "src/catalog.ts", "src/only-published.ts"];
	assert.deepEqual(compareFileLists(local, published), [
		"missing-from-tarball src/only-local.ts",
		"not-in-tree          src/only-published.ts",
	]);
	assert.deepEqual(compareFileLists(local, local), [], "identical lists are a clean gate");
	assert.equal(compareFileLists([], ["a", "b"]).length, 2, "an empty tree fails on every published file");
	assert.equal(compareFileLists(["a", "b"], []).length, 2, "an empty tarball fails on every local file");
});

test("gate passes a tarball that matches the tree file list exactly", { skip: SKIP_NO_TAR }, () => {
	withTempDir((dir) => {
		const tarball = buildTarball(dir, {
			"package.json": fs.readFileSync(path.join(ROOT, "package.json")),
			"README.md": fs.readFileSync(path.join(ROOT, "README.md")),
		});
		const run = runGate(dir, { tarball, treeFiles: ["package.json", "README.md"] });
		assert.equal(run.status, 0, run.output);
		assert.match(run.output, /2 files, 0 mismatches/);
		assert.match(run.output, new RegExp(`asset dist/${ASSET.replace(/\./g, "\\.")} sha256 [0-9a-f]{64}`));
	});
});

test("gate fails on a local file the tarball does not carry", { skip: SKIP_NO_TAR }, () => {
	withTempDir((dir) => {
		const tarball = buildTarball(dir, {
			"package.json": fs.readFileSync(path.join(ROOT, "package.json")),
			"README.md": fs.readFileSync(path.join(ROOT, "README.md")),
		});
		const run = runGate(dir, { tarball, treeFiles: ["package.json", "README.md", "src/only-local.ts"] });
		assert.equal(run.status, 1, run.output);
		assert.match(run.output, /missing-from-tarball src\/only-local\.ts/);
	});
});

test("gate fails on a tarball file this tree does not carry", { skip: SKIP_NO_TAR }, () => {
	withTempDir((dir) => {
		const tarball = buildTarball(dir, {
			"package.json": fs.readFileSync(path.join(ROOT, "package.json")),
			"README.md": fs.readFileSync(path.join(ROOT, "README.md")),
			"src/only-published.ts": "export const shipped = true;\n",
		});
		const run = runGate(dir, { tarball, treeFiles: ["package.json", "README.md"] });
		assert.equal(run.status, 1, run.output);
		// Both sides of the diff are reported: the tarball carries a file the tree
		// lacks (not-in-tree) and has no counterpart for it in the checkout.
		assert.match(run.output, /not-in-tree\s+src\/only-published\.ts/);
		assert.match(run.output, /missing-in-repo\s+src\/only-published\.ts/);
	});
});

test("gate fails on a tarball file whose bytes differ from the tree", { skip: SKIP_NO_TAR }, () => {
	withTempDir((dir) => {
		const tarball = buildTarball(dir, {
			"package.json": fs.readFileSync(path.join(ROOT, "package.json")),
			"README.md": "# a README that is not this checkout's\n",
		});
		const run = runGate(dir, { tarball, treeFiles: ["package.json", "README.md"] });
		assert.equal(run.status, 1, run.output);
		assert.match(run.output, /content-differs\s+README\.md/);
	});
});

test("gate fails when the asset name does not match the package version", { skip: SKIP_NO_TAR }, () => {
	withTempDir((dir) => {
		const tarball = buildTarball(
			dir,
			{
				"package.json": fs.readFileSync(path.join(ROOT, "package.json")),
				"README.md": fs.readFileSync(path.join(ROOT, "README.md")),
			},
			"pi-freeflow-0.0.0-other.tgz",
		);
		const run = runGate(dir, { tarball, treeFiles: ["package.json", "README.md"] });
		assert.equal(run.status, 1, run.output);
		assert.match(run.output, /does not match pi-freeflow-.*\.tgz/);
	});
});

test("gate exits 1 when npm cannot produce the release tarball (CLI entry)", () => {
	withTempDir((dir) => {
		const treeJson = path.join(dir, "tree.json");
		fs.writeFileSync(treeJson, JSON.stringify([{ files: [{ path: "package.json" }] }]));
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 1\n");
		fs.chmodSync(path.join(bin, "npm"), 0o755);
		if (IS_WINDOWS) fs.writeFileSync(path.join(bin, "npm.cmd"), "@exit /b 1\r\n");
		const result = spawnSync(process.execPath, [SCRIPT], {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				NPM_STUB_DIR: bin,
				NPM_STUB_TREE_JSON: treeJson,
				PATH: bin + path.delimiter + (process.env.PATH ?? ""),
			},
		});
		assert.equal(result.status, 1, `${result.stdout ?? ""}${result.stderr ?? ""}`);
		assert.match(`${result.stdout ?? ""}${result.stderr ?? ""}`, /npm pack did not produce exactly one tarball/);
	});
});
