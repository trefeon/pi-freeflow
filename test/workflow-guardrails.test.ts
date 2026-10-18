/**
 * Guardrails for the workflows shipped in .github/workflows.
 *
 * The configuration contracts (concurrency, permissions, matrix, tag gating)
 * are asserted on the parsed document, and the shell blocks that carry behavior
 * are taken verbatim from the parsed document and executed under bash with
 * stubbed CLIs — so argument handling and the state push are observed, never
 * pattern-matched against the file text.
 *
 * Everything runs in temp directories with local-only tools: no network and no
 * listening sockets. A test skips — never fails — when a capability it needs is
 * missing, whether that is the workflow parser (js-yaml), a shell, or PATH-resolved
 * shell stubs (which Git Bash provides).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

const WATCH_JOB = "watch";
const DRIFT_ISSUE_STEP = "Open or Update GitHub Issue on Drift";
const STATE_STEP = "Update State and Commit";
const RELEASE_JOB = "validate-and-publish";
const TAG_VALIDATION_STEP = "Validate tag against package version";
const RELEASE_STEP = "Create or Update GitHub Release";
const TAG_GATE = "startsWith(github.ref, 'refs/tags/')";
const FALLBACK_BODY = "OpenCode upstream drift detected but drift-report.md is missing. See workflow logs.";

type Step = { name?: string; if?: string; run?: string; uses?: string };
type Job = { "runs-on"?: unknown; strategy?: { matrix?: Record<string, unknown> }; steps?: Step[] };
type Workflow = { concurrency?: unknown; permissions?: unknown; jobs?: Record<string, Job> };
type YamlLoad = (source: string) => unknown;

/**
 * Opportunistic loader for the workflow documents: js-yaml is a devDependency, but an
 * install that never linked it must still be able to load this file and skip — a static
 * import would take the whole suite down with it, so the specifier is resolved at
 * runtime instead.
 */
const JS_YAML_SPECIFIER: string = "js-yaml";
const yamlLoad: YamlLoad | null = await (async (): Promise<YamlLoad | null> => {
	try {
		const module = (await import(JS_YAML_SPECIFIER)) as {
			load?: YamlLoad;
			default?: { load?: YamlLoad };
		};
		const load = module.load ?? module.default?.load;
		return typeof load === "function" ? load : null;
	} catch {
		return null;
	}
})();

// ---------------------------------------------------------------- host probes

const slash = (value: string): string => value.split(path.sep).join("/");

function probe(command: string, args: string[]): boolean {
	try {
		return spawnSync(command, args, { encoding: "utf8", timeout: 30_000 }).status === 0;
	} catch {
		return false;
	}
}

/** Verifies bash *and* that a PATH-resolved extensionless shell stub is executed. */
function probeShellStubs(): boolean {
	if (!probe("bash", ["-c", "echo ok"])) return false;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pff-stub-probe-"));
	try {
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "probe-cmd"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$PROBE_DIR/out.log"\n');
		fs.chmodSync(path.join(bin, "probe-cmd"), 0o755);
		const result = spawnSync("bash", ["-e", "-c", "probe-cmd pipeline"], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, PROBE_DIR: slash(bin), PATH: bin + path.delimiter + (process.env.PATH ?? "") },
		});
		const log = path.join(bin, "out.log");
		return result.status === 0 && fs.existsSync(log) && fs.readFileSync(log, "utf8").trim() === "pipeline";
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const SHELL_STUBS = probeShellStubs();
const SKIP_NO_STUBS = SHELL_STUBS ? undefined : "bash with PATH-resolved shell stubs is unavailable on this host";
const SKIP_NO_SHELL = probe("bash", ["-c", "echo ok"]) ? undefined : "bash is unavailable on this host";
const SKIP_NO_GIT = probe("git", ["--version"]) ? undefined : "git is unavailable on this host";
// Probed once at module load. Every test that reads a workflow document — directly or
// through scriptOf — gates on this, combined with any other capability it needs, so a
// parser-less install skips the whole set instead of asserting.
const SKIP_NO_YAML = yamlLoad ? undefined : "js-yaml is not resolvable in this install";

// ------------------------------------------------------------------- fixtures

function loadWorkflow(name: string): Workflow {
	assert.ok(yamlLoad, "workflow parsing unavailable");
	return yamlLoad(fs.readFileSync(path.join(WORKFLOWS, name), "utf8")) as Workflow;
}

function jobOf(doc: Workflow, job: string): Job {
	const found = doc.jobs?.[job];
	assert.ok(found, `job not found: ${job}`);
	return found;
}

function stepOf(doc: Workflow, job: string, name: string): Step {
	const found = jobOf(doc, job).steps?.find((candidate) => candidate.name === name);
	assert.ok(found, `step not found: ${job} / ${name}`);
	return found;
}

/** The step's run script exactly as GitHub hands it to bash. */
function scriptOf(workflowName: string, job: string, stepName: string): string {
	const script = stepOf(loadWorkflow(workflowName), job, stepName).run;
	assert.ok(typeof script === "string", `step has no run script: ${stepName}`);
	return `${script}\n`;
}

function withTempDir(prefix: string, run: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Runs a step script the way GitHub does (`bash -e <file>`) inside `cwd`. */
function runShell(script: string, cwd: string, env: Record<string, string>): { status: number | null; output: string } {
	fs.writeFileSync(path.join(cwd, "step.sh"), script);
	const result = spawnSync("bash", ["-e", "step.sh"], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Installs an executable stub named `name` on PATH and returns its environment. */
function makeStub(dir: string, name: string, source: string): { bin: string; env: Record<string, string> } {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, name), source);
	fs.chmodSync(path.join(bin, name), 0o755);
	return { bin, env: { PATH: bin + path.delimiter + (process.env.PATH ?? "") } };
}

function ghCalls(bin: string): string[][] {
	return fs
		.readFileSync(path.join(bin, "argv.log"), "utf8")
		.split("---\n")
		.filter((chunk) => chunk.trim() !== "")
		.map((chunk) => chunk.split("\n").filter((line) => line !== ""));
}

function git(args: string[], cwd?: string): string {
	const result = spawnSync("git", cwd ? ["-C", slash(cwd), ...args] : args, { encoding: "utf8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${output}`);
	return output;
}

function initRepo(dir: string): void {
	git(["init", "--initial-branch=main"], dir);
	git(["config", "user.email", "workflow-test@example.com"], dir);
	git(["config", "user.name", "Workflow Test"], dir);
	git(["config", "commit.gpgsign", "false"], dir);
}

const GH_STUB = `#!/bin/sh
# Records every gh invocation and keeps the body gh would have published.
printf '%s\\n' '---' >> "$GH_STUB_DIR/argv.log"
for argument in "$@"; do printf '%s\\n' "$argument" >> "$GH_STUB_DIR/argv.log"; done
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s' "\${GH_STUB_LIST:-}"
  exit 0
fi
if [ "$1" = "issue" ] && { [ "$2" = "comment" ] || [ "$2" = "create" ]; }; then
  shift 2
  while [ $# -gt 0 ]; do
    if [ "$1" = "--body-file" ]; then cp "$2" "$GH_STUB_DIR/body.txt"; fi
    shift
  done
fi
exit 0
`;

const NODE_STUB = `#!/bin/sh
# Stands in for \`node scripts/opencode-watch.mjs --update\`: records the call and
# produces a state change so the push path runs without contacting upstream.
printf '%s\\n' "$*" >> "$NODE_STUB_DIR/node.log"
printf '%s\\n' '{"simulated":true}' > .github/opencode-watch-state.json
exit 0
`;

// -------------------------------------------------------------------- tests

test("opencode-watch.yml serializes watcher runs instead of overlapping them", { skip: SKIP_NO_YAML }, () => {
	const doc = loadWorkflow("opencode-watch.yml");
	assert.deepEqual(doc.concurrency, { group: "opencode-watch", "cancel-in-progress": false });
});

test("opencode-watch.yml files the drift issue body when the report is missing", { skip: SKIP_NO_YAML ?? SKIP_NO_STUBS }, () => {
	withTempDir("pff-drift-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB);
		const result = runShell(scriptOf("opencode-watch.yml", WATCH_JOB, DRIFT_ISSUE_STEP), dir, {
			...gh.env,
			GH_STUB_DIR: slash(gh.bin),
			GH_STUB_LIST: "",
		});
		assert.equal(result.status, 0, result.output);

		const calls = ghCalls(gh.bin);
		assert.deepEqual(calls[0].slice(0, 3), ["label", "create", "opencode-drift"]);

		const issueCall = calls.find((call) => call[0] === "issue" && call[1] === "create");
		assert.ok(issueCall, `expected an issue create call: ${JSON.stringify(calls)}`);
		assert.ok(!issueCall.includes("--body"), `the body must not be passed inline: ${JSON.stringify(issueCall)}`);
		assert.equal(issueCall[issueCall.indexOf("--body-file") + 1], "drift-report.md", JSON.stringify(issueCall));
		assert.ok(issueCall[issueCall.indexOf("--title") + 1].startsWith("🚨 OpenCode Upstream Drift Detected ("), issueCall.join(" "));

		assert.equal(fs.readFileSync(path.join(dir, "drift-report.md"), "utf8").trim(), FALLBACK_BODY);
		assert.equal(fs.readFileSync(path.join(gh.bin, "body.txt"), "utf8").trim(), FALLBACK_BODY);
	});
});

test("opencode-watch.yml comments the open drift issue with the report file", { skip: SKIP_NO_YAML ?? SKIP_NO_STUBS }, () => {
	withTempDir("pff-drift-comment-", (dir) => {
		const report = "# Drift\n\n- upstream file changed\n";
		fs.writeFileSync(path.join(dir, "drift-report.md"), report);
		const gh = makeStub(dir, "gh", GH_STUB);
		const result = runShell(scriptOf("opencode-watch.yml", WATCH_JOB, DRIFT_ISSUE_STEP), dir, {
			...gh.env,
			GH_STUB_DIR: slash(gh.bin),
			GH_STUB_LIST: "42",
		});
		assert.equal(result.status, 0, result.output);

		const calls = ghCalls(gh.bin);
		assert.deepEqual(
			calls.find((call) => call[1] === "comment"),
			["issue", "comment", "42", "--body-file", "drift-report.md"],
		);
		assert.equal(fs.readFileSync(path.join(gh.bin, "body.txt"), "utf8"), report);
	});
});

test(
	"opencode-watch.yml state push rebases over a commit that lands on main first",
	{ skip: SKIP_NO_YAML ?? SKIP_NO_STUBS ?? SKIP_NO_GIT },
	() => {
		withTempDir("pff-state-push-", (dir) => {
			const origin = path.join(dir, "origin.git");
			const seed = path.join(dir, "seed");
			const work = path.join(dir, "work");
			const other = path.join(dir, "other");

			git(["init", "--bare", "--initial-branch=main", slash(origin)]);
			fs.mkdirSync(seed);
			initRepo(seed);
			fs.mkdirSync(path.join(seed, ".github"));
			fs.writeFileSync(path.join(seed, ".github", "opencode-watch-state.json"), '{"release":"v1.18.31"}\n');
			git(["add", "-A"], seed);
			git(["commit", "-m", "seed watch state"], seed);
			git(["remote", "add", "origin", slash(origin)], seed);
			git(["push", "-u", "origin", "main"], seed);

			// The watcher checkout the step runs in.
			git(["clone", slash(origin), slash(work)]);
			initRepo(work);

			// A concurrent commit reaches main after that checkout.
			git(["clone", slash(origin), slash(other)]);
			initRepo(other);
			fs.writeFileSync(path.join(other, "CONCURRENT.txt"), "concurrent change\n");
			git(["add", "-A"], other);
			git(["commit", "-m", "feat: concurrent change on main"], other);
			git(["push", "origin", "main"], other);

			const node = makeStub(dir, "node", NODE_STUB);
			const result = runShell(scriptOf("opencode-watch.yml", WATCH_JOB, STATE_STEP), work, {
				...node.env,
				NODE_STUB_DIR: slash(node.bin),
			});
			assert.equal(result.status, 0, result.output);

			const history = git(["--git-dir", slash(origin), "log", "--pretty=%s", "main"]);
			assert.match(history, /chore\(watch\): update opencode watch state \[skip ci\]/, history);
			assert.match(history, /feat: concurrent change on main/, history);
			assert.equal(fs.readFileSync(path.join(node.bin, "node.log"), "utf8").trim(), "scripts/opencode-watch.mjs --update");
			// The rebase carries the state file through git, so the checkout may hand it back in the
			// host's line-ending convention (CRLF on Windows runners): the contract is that the content
			// survives the rebase-then-push, not which newline the OS writes.
			const state = fs.readFileSync(path.join(work, ".github", "opencode-watch-state.json"), "utf8").replace(/\r\n/g, "\n");
			assert.equal(state, '{"simulated":true}\n');
		});
	},
);

test("release.yml validates the pushed tag against package.json", { skip: SKIP_NO_YAML }, () => {
	const doc = loadWorkflow("release.yml");
	assert.equal(stepOf(doc, RELEASE_JOB, TAG_VALIDATION_STEP).if, TAG_GATE);
	assert.equal(stepOf(doc, RELEASE_JOB, RELEASE_STEP).if, TAG_GATE);
	// The maintained action is the contract; its major moves independently of this repo.
	assert.match(stepOf(doc, RELEASE_JOB, RELEASE_STEP).uses ?? "", /^softprops\/action-gh-release@v\d+$/);
});

test("release.yml never publishes to npm and proves the tarball before releasing", { skip: SKIP_NO_YAML }, () => {
	const steps = jobOf(loadWorkflow("release.yml"), RELEASE_JOB).steps ?? [];
	// Publishing is manual in this repo (maintainer terminal, 2FA): a workflow that can
	// publish on its own is the regression this guards.
	assert.doesNotMatch(steps.map((step) => step.run ?? "").join("\n"), /(npm publish|changeset publish)/);

	const verifyIndex = steps.findIndex((step) => (step.run ?? "").includes("scripts/verify-published-tarball.mjs"));
	const releaseIndex = steps.findIndex((step) => step.name === RELEASE_STEP);
	assert.ok(verifyIndex >= 0, `expected the published-tarball verification step: ${steps.map((step) => step.name).join(", ")}`);
	assert.ok(releaseIndex > verifyIndex, "the tarball verification must run before the GitHub Release is created");
});

test("release.yml tag validation rejects a tag that disagrees with the version", { skip: SKIP_NO_YAML ?? SKIP_NO_SHELL }, () => {
	withTempDir("pff-tag-", (dir) => {
		fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "pi-freeflow", version: "1.38.0" }, null, 2)}\n`);
		const script = scriptOf("release.yml", RELEASE_JOB, TAG_VALIDATION_STEP);

		const matching = runShell(script, dir, {
			GITHUB_REF: "refs/tags/v1.38.0",
			GITHUB_REF_NAME: "v1.38.0",
			GITHUB_REF_TYPE: "tag",
		});
		assert.equal(matching.status, 0, matching.output);
		assert.match(matching.output, /matches package\.json version 1\.38\.0/);

		const mismatch = runShell(script, dir, {
			GITHUB_REF: "refs/tags/v1.39.0",
			GITHUB_REF_NAME: "v1.39.0",
			GITHUB_REF_TYPE: "tag",
		});
		assert.equal(mismatch.status, 1, mismatch.output);
		assert.match(mismatch.output, /::error::Tag v1\.39\.0 \(1\.39\.0\) does not match package\.json version 1\.38\.0/);

		const branch = runShell(script, dir, {
			GITHUB_REF: "refs/heads/main",
			GITHUB_REF_NAME: "main",
			GITHUB_REF_TYPE: "branch",
		});
		assert.equal(branch.status, 0, branch.output);
		assert.doesNotMatch(branch.output, /::error::/);
	});
});

test("ci.yml exercises the declared node floor and scopes the token", { skip: SKIP_NO_YAML }, () => {
	const doc = loadWorkflow("ci.yml");
	assert.deepEqual(doc.permissions, { contents: "read" });

	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { engines?: { node?: string } };
	const floor = (pkg.engines?.node ?? "").replace(/^[^\d]*/, "");
	assert.notEqual(floor, "", "package.json must declare an engines floor");
	const versions = jobOf(doc, "test").strategy?.matrix?.["node-version"];
	assert.ok(Array.isArray(versions), `matrix node-version must be a list: ${JSON.stringify(versions)}`);
	assert.ok(versions.includes("lts/*"), JSON.stringify(versions));
	assert.ok(versions.includes(floor), `the declared engines floor ${floor} must be exercised: ${JSON.stringify(versions)}`);

	const fallback = jobOf(doc, "test-local");
	assert.deepEqual(fallback["runs-on"], ["self-hosted", "Linux", "X64", "acerblue-local"]);
	assert.equal(fallback.strategy, undefined);
});
