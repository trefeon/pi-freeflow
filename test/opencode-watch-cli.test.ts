/**
 * Smoke tests for the watcher's CLI entry (scripts/opencode-watch.mjs).
 *
 * The unit tests in test/opencode-watch.test.ts call runWatch directly; these
 * spawn the real binary, so argument parsing, the report file write, stdout and
 * the process exit code are observed as a user or CI job would see them.
 *
 * Offline by construction: a `--import` preload replaces globalThis.fetch with
 * a fixture table keyed by the monitored URLs (or a hard failure), so no test
 * reaches the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "opencode-watch.mjs");

/**
 * Preload installed with `--import`: serves WATCH_CLI_FIXTURES (a URL -> body
 * map) or fails every request in offline mode. Global fetch is read at call
 * time by the watcher, so replacing it here reaches the real run.
 */
const PRELOAD = `const mode = process.env.WATCH_CLI_MODE;
if (mode === "offline") {
	globalThis.fetch = async (url) => {
		throw new Error(\`offline: \${url}\`);
	};
} else {
	const fixtures = JSON.parse(process.env.WATCH_CLI_FIXTURES ?? "{}");
	globalThis.fetch = async (url) => {
		const body = fixtures[String(url)];
		if (body === undefined) throw new Error(\`unexpected fetch: \${url}\`);
		return new Response(body, { status: 200 });
	};
}
`;

const RELEASE_URL = "https://api.github.com/repos/anomalyco/opencode/releases/latest";
const MODELS_URL = "https://opencode.ai/inference/v1/models";
const SCHEMA_URLS: Record<string, string> = {
	"identifier.ts": "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/identifier.ts",
	"session-id.ts": "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/session-id.ts",
	"zen.mdx": "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx",
};
const SCHEMA_BODIES: Record<string, string> = {
	"identifier.ts": "export const Identifier = { create: () => 'ses_abc' };\n",
	"session-id.ts": "export const SessionId = 'ses_abc';\n",
	"zen.mdx": "# Zen\n\n- free tier: yes\n",
};

/** sha256 of a file's text after EOL and trailing-newline normalization. */
function normalizedSha(text: string): string {
	return crypto
		.createHash("sha256")
		.update(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, ""))
		.digest("hex");
}

type Fixture = { lastRelease?: string; liveRelease?: string; state?: Record<string, unknown> };

/** Writes the state file + fixture table + preload into `dir`; returns argv. */
function stageRun(
	dir: string,
	options: { fixture?: Fixture; mode?: string } = {},
): { argv: string[]; env: Record<string, string>; stateFile: string } {
	const lastRelease = options.fixture?.lastRelease ?? "v1.18.31";
	const liveRelease = options.fixture?.liveRelease ?? lastRelease;
	const state = {
		lastRelease,
		fileShas: Object.fromEntries(Object.entries(SCHEMA_BODIES).map(([name, body]) => [name, normalizedSha(body)])),
		freeModels: ["big-pickle", "nemotron-3-ultra-free"],
		lastChecked: "2026-09-19T00:00:00.000Z",
		...options.fixture?.state,
	};
	const stateFile = path.join(dir, "state.json");
	fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");

	const fixtures: Record<string, string> = { [RELEASE_URL]: JSON.stringify({ tag_name: liveRelease }) };
	for (const [name, url] of Object.entries(SCHEMA_URLS)) fixtures[url] = SCHEMA_BODIES[name];
	fixtures[MODELS_URL] = JSON.stringify({
		data: [{ id: "big-pickle" }, { id: "nemotron-3-ultra-free" }, { id: "claude-opus-4-1" }],
	});

	const preload = path.join(dir, "preload.mjs");
	fs.writeFileSync(preload, PRELOAD);
	return {
		argv: ["--import", pathToFileURL(preload).href, SCRIPT],
		env: {
			WATCH_CLI_MODE: options.mode ?? "fixtures",
			WATCH_CLI_FIXTURES: JSON.stringify(fixtures),
		},
		stateFile,
	};
}

function runCli(
	dir: string,
	flags: string[],
	staged: { argv: string[]; env: Record<string, string> },
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [...staged.argv, ...flags], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, ...staged.env },
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withTempDir(prefix: string, run: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("CLI --help prints usage and exits 0 without touching upstream", () => {
	withTempDir("pff-cli-help-", (dir) => {
		const staged = stageRun(dir, { mode: "offline" });
		const run = runCli(dir, ["--help"], staged);
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /--check/);
		assert.match(run.stdout, /--state <f>/);
	});
});

test("CLI --check exits 0 and writes the in-sync report when upstream matches state", () => {
	withTempDir("pff-cli-sync-", (dir) => {
		const staged = stageRun(dir);
		const run = runCli(dir, ["--check", "--state", "state.json", "--output", "drift-report.md"], staged);
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /OpenCode Upstream Status: In Sync/);
		const report = fs.readFileSync(path.join(dir, "drift-report.md"), "utf8");
		assert.match(report, /OpenCode Upstream Status: In Sync/);
		assert.equal(report.trimEnd(), run.stdout.trimEnd(), "the report file is what the step summary prints");
	});
});

test("CLI --check --json exits 1 and reports drift when the release moves", () => {
	withTempDir("pff-cli-drift-", (dir) => {
		const staged = stageRun(dir, { fixture: { liveRelease: "v1.18.32" } });
		const run = runCli(dir, ["--check", "--json", "--state", "state.json"], staged);
		assert.equal(run.status, 1, run.stderr);
		const drift = JSON.parse(run.stdout) as { hasDrift: boolean; release: { previous: string; current: string } };
		assert.equal(drift.hasDrift, true);
		assert.deepEqual([drift.release.previous, drift.release.current], ["v1.18.31", "v1.18.32"]);
	});
});

test("CLI --update rewrites the state file and keeps the in-sync exit code", () => {
	withTempDir("pff-cli-update-", (dir) => {
		const staged = stageRun(dir);
		const before = fs.readFileSync(staged.stateFile, "utf8");
		const run = runCli(dir, ["--check", "--update", "--state", "state.json"], staged);
		assert.equal(run.status, 0, run.stderr);
		const after = JSON.parse(fs.readFileSync(staged.stateFile, "utf8")) as { lastChecked: string };
		assert.notEqual(after.lastChecked, "2026-09-19T00:00:00.000Z", "the state file must be rewritten");
		assert.notEqual(fs.readFileSync(staged.stateFile, "utf8"), before);
	});
});

test("CLI exits 2 with an upstream infra report when the network is down", () => {
	withTempDir("pff-cli-offline-", (dir) => {
		const staged = stageRun(dir, { mode: "offline" });
		const before = fs.readFileSync(staged.stateFile, "utf8");
		const run = runCli(dir, ["--check", "--state", "state.json", "--output", "drift-report.md"], staged);
		assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
		assert.match(run.stderr, /OpenCode Watcher Infra Failure/);
		assert.match(run.stderr, /Phase:\*\* `upstream`/);
		assert.match(fs.readFileSync(path.join(dir, "drift-report.md"), "utf8"), /Infra Failure/);
		assert.equal(fs.readFileSync(staged.stateFile, "utf8"), before, "an infra failure must not touch the state file");
	});
});

test("CLI exits 2 with a state infra report when the state file is corrupt", () => {
	withTempDir("pff-cli-corrupt-", (dir) => {
		const staged = stageRun(dir, { mode: "offline" });
		fs.writeFileSync(staged.stateFile, "{ not json");
		const run = runCli(dir, ["--check", "--state", "state.json"], staged);
		assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
		assert.match(run.stderr, /Phase:\*\* `state`/);
	});
});
