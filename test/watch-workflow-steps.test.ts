/**
 * Behavioral tests for the watch workflows' shell blocks.
 *
 * The drift/alert lifecycle is decision logic living in shell, so it is
 * executed here exactly as GitHub hands it to bash (`bash -e <file>`) with
 * stubbed `node` and `gh` on PATH: exit-code classification, the env/output
 * contract the later steps read, and the close decision are observed, never
 * pattern-matched against the YAML text.
 *
 * Everything runs in temp directories with local-only tools: no network and no
 * listening sockets. A test skips — never fails — when a capability it needs is
 * missing (the workflow parser, bash, or PATH-resolved shell stubs).
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

type Step = { name?: string; if?: string; run?: string; uses?: string };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };
type YamlLoad = (source: string) => unknown;

/**
 * Opportunistic loader: js-yaml is a devDependency, so an install that never
 * linked it must still load this file and skip — a static import would take the
 * whole suite down with it, which is why the specifier is resolved at runtime.
 */
const yamlLoad: YamlLoad | null = await (async (): Promise<YamlLoad | null> => {
	try {
		const module = (await import("js-yaml")) as { load?: YamlLoad; default?: { load?: YamlLoad } };
		const load = module.load ?? module.default?.load;
		return typeof load === "function" ? load : null;
	} catch {
		return null;
	}
})();

const slash = (value: string): string => value.split(path.sep).join("/");

/** bash *and* PATH-resolved extensionless shell stubs must both work. */
const SHELL_STUBS = (() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pff-step-probe-"));
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
})();

const SKIP = SHELL_STUBS ? (yamlLoad ? undefined : "js-yaml is not resolvable in this install") : "bash with PATH-resolved shell stubs is unavailable on this host";

function loadWorkflow(name: string): Workflow {
	assert.ok(yamlLoad, "workflow parsing unavailable");
	return yamlLoad(fs.readFileSync(path.join(WORKFLOWS, name), "utf8")) as Workflow;
}

function stepOf(workflowName: string, job: string, stepName: string): Step {
	const found = loadWorkflow(workflowName).jobs?.[job]?.steps?.find((candidate) => candidate.name === stepName);
	assert.ok(found, `step not found: ${workflowName} / ${job} / ${stepName}`);
	return found;
}

/** The step's run script exactly as GitHub hands it to bash. */
function scriptOf(workflowName: string, job: string, stepName: string): string {
	const script = stepOf(workflowName, job, stepName).run;
	assert.ok(typeof script === "string", `step has no run script: ${stepName}`);
	return `${script}\n`;
}

const GH_STUB = `#!/bin/sh
printf '%s\\n' '---' >> "$GH_STUB_DIR/argv.log"
for argument in "$@"; do printf '%s\\n' "$argument" >> "$GH_STUB_DIR/argv.log"; done
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s' "\${GH_STUB_LIST:-}"
  exit 0
fi
exit 0
`;

/** Stands in for `node <script> <flags>`: records argv, returns a chosen code. */
const NODE_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$NODE_STUB_DIR/node.log"
exit "\${NODE_STUB_EXIT:-0}"
`;

/** Git for Windows forces /mingw64/bin ahead of PATH, so `git` is exercised for real. */
const GIT_AVAILABLE = (() => {
	try {
		return spawnSync("git", ["--version"]).status === 0;
	} catch {
		return false;
	}
})();

type Stub = { bin: string; env: Record<string, string> };

/** Installs an executable stub named `name` on PATH and returns its environment. */
function makeStub(dir: string, name: string, source: string, dirVar: string): Stub {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, name), source);
	fs.chmodSync(path.join(bin, name), 0o755);
	return { bin, env: { PATH: bin + path.delimiter + (process.env.PATH ?? ""), [dirVar]: slash(bin) } };
}

function withTempDir(prefix: string, run: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Runs a step script the way GitHub does, with GITHUB_ENV/GITHUB_OUTPUT pointed
 * at files so the step's `>> "$GITHUB_*"` contract can be read back.
 */
function runStep(
	script: string,
	dir: string,
	env: Record<string, string>,
): { status: number | null; output: string; envFile: string; outFile: string } {
	const envFile = path.join(dir, "github-env");
	const outFile = path.join(dir, "github-output");
	fs.writeFileSync(envFile, "");
	fs.writeFileSync(outFile, "");
	fs.writeFileSync(path.join(dir, "step.sh"), script);
	const result = spawnSync("bash", ["-e", "step.sh"], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, ...env, GITHUB_ENV: slash(envFile), GITHUB_OUTPUT: slash(outFile) },
	});
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
		envFile: fs.readFileSync(envFile, "utf8"),
		outFile: fs.readFileSync(outFile, "utf8"),
	};
}

function ghCalls(bin: string): string[][] {
	const log = path.join(bin, "argv.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.split("---\n")
		.filter((chunk) => chunk.trim() !== "")
		.map((chunk) => chunk.split("\n").filter((line) => line !== ""));
}

const WATCH = "opencode-watch.yml";
const WATCH_JOB = "watch";
const WATCH_CHECK_STEP = "Run OpenCode Watch Check";
const WATCH_CLOSE_STEP = "Close Recovered Drift Issue";
const WATCH_REBASELINE_STEP = "Rebaseline Watcher State";
const WATCH_REBASELINE_CLOSE_STEP = "Close Drift Issue After Rebaseline";
const WATCH_ISSUE_STEP = "File or Update Critical Drift Issue";
const WATCH_COMMIT_STEP = "Commit Watcher State";

const MODEL_CHECK = "opencode-model-check.yml";
const MODEL_CHECK_JOB = "check-models";
const MODEL_CHECK_PROBE_STEP = "Probe All OpenCode Free Tier Models";
const MODEL_CHECK_ANNOTATE_STEP = "Annotate Unavailable Models (No Alert)";
const MODEL_CHECK_ISSUE_STEP = "Open or Update GitHub Issue on Dead Models";
const MODEL_CHECK_CLOSE_STEP = "Close Recovered Alert Issue";

// ── drift watcher: exit-code classification ─────────────────────────────────

test("opencode-watch.yml maps the watcher exit code onto the exit-code/infra flags", { skip: SKIP }, () => {
	const expectations: Array<[number, string]> = [
		// [node exit code, INFRA_FAILURE]
		[0, "false"],
		[1, "false"],
		[2, "true"],
	];
	assert.equal(
		stepOf(WATCH, WATCH_JOB, WATCH_CHECK_STEP).if,
		"github.event.inputs.rebaseline != 'true'",
		"the scheduled check must not run on the rebaseline dispatch path",
	);
	for (const [code, infra] of expectations) {
		withTempDir(`pff-watch-${code}-`, (dir) => {
			const node = makeStub(dir, "node", NODE_STUB, "NODE_STUB_DIR");
			const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_CHECK_STEP), dir, {
				...node.env,
				NODE_STUB_EXIT: String(code),
			});
			assert.equal(run.status, 0, `exit ${code}: the classifying step itself must succeed: ${run.output}`);
			assert.match(run.envFile, new RegExp(`^INFRA_FAILURE=${infra}$`, "m"), `exit ${code} env`);
			assert.match(run.outFile, new RegExp(`^exit_code=${code}$`, "m"), `exit ${code} output`);

			const args = fs.readFileSync(path.join(node.bin, "node.log"), "utf8").trim();
			assert.equal(args, "scripts/opencode-watch.mjs --check --advance --output drift-report.md");
		});
	}
});

test("opencode-watch.yml closes the drift issue only on a clean watcher run", { skip: SKIP }, () => {
	// The gate that makes "clean run" the close condition, asserted on the
	// parsed document because GitHub evaluates it before bash ever sees the step.
	assert.equal(stepOf(WATCH, WATCH_JOB, WATCH_CLOSE_STEP).if, "steps.check.outputs.exit_code == '0'");

	withTempDir("pff-drift-close-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_CLOSE_STEP), dir, { ...gh.env, GH_STUB_LIST: "42" });
		assert.equal(run.status, 0, run.output);
		const calls = ghCalls(gh.bin);
		const comment = calls.find((call) => call[0] === "issue" && call[1] === "comment");
		assert.ok(comment, `expected an issue comment call: ${JSON.stringify(calls)}`);
		assert.equal(comment[2], "42", "the open drift issue must be the one commented");
		assert.match(comment[comment.indexOf("--body") + 1], /in sync/);
		const close = calls.find((call) => call[0] === "issue" && call[1] === "close");
		assert.ok(close, `expected an issue close call: ${JSON.stringify(calls)}`);
		assert.deepEqual(close.slice(2), ["42", "--reason", "completed"]);
	});

	withTempDir("pff-drift-close-none-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_CLOSE_STEP), dir, { ...gh.env, GH_STUB_LIST: "" });
		assert.equal(run.status, 0, run.output);
		assert.match(run.output, /No open opencode-drift issue to close/);
		const calls = ghCalls(gh.bin);
		assert.equal(calls.filter((call) => call[1] === "close").length, 0, "nothing may be closed when no issue is open");
		assert.equal(calls.filter((call) => call[1] === "comment").length, 0);
	});
});

test("opencode-watch.yml files one critical issue and edits it in place", { skip: SKIP }, () => {
	assert.equal(
		stepOf(WATCH, WATCH_JOB, WATCH_ISSUE_STEP).if,
		"steps.check.outputs.exit_code == '1'",
		"only a critical exit files an issue",
	);

	withTempDir("pff-watch-issue-edit-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_ISSUE_STEP), dir, { ...gh.env, GH_STUB_LIST: "99" });
		assert.equal(run.status, 0, run.output);
		const calls = ghCalls(gh.bin);
		assert.equal(
			calls.filter((call) => call[0] === "issue" && call[1] === "comment").length,
			0,
			"an existing issue is edited, never commented on every run",
		);
		const edit = calls.find((call) => call[0] === "issue" && call[1] === "edit");
		assert.ok(edit, `expected an issue edit call: ${JSON.stringify(calls)}`);
		assert.equal(edit[2], "99");
		assert.deepEqual(edit.slice(3), ["--body-file", "drift-report.md"]);
		assert.equal(calls.filter((call) => call[0] === "issue" && call[1] === "create").length, 0);
	});

	withTempDir("pff-watch-issue-create-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_ISSUE_STEP), dir, { ...gh.env, GH_STUB_LIST: "" });
		assert.equal(run.status, 0, run.output);
		const calls = ghCalls(gh.bin);
		const create = calls.find((call) => call[0] === "issue" && call[1] === "create");
		assert.ok(create, `expected an issue create call: ${JSON.stringify(calls)}`);
		assert.ok(create.includes("--body-file"), "the report file is the issue body");
		assert.ok(create.includes("opencode-drift"), "the issue carries the drift label");
	});
});

test("opencode-watch.yml rebaseline dispatch writes the full baseline and closes the issue", { skip: SKIP }, () => {
	assert.equal(stepOf(WATCH, WATCH_JOB, WATCH_REBASELINE_STEP).if, "github.event.inputs.rebaseline == 'true'");
	assert.equal(
		stepOf(WATCH, WATCH_JOB, WATCH_REBASELINE_CLOSE_STEP).if,
		"github.event.inputs.rebaseline == 'true'",
	);

	withTempDir("pff-watch-rebaseline-", (dir) => {
		const node = makeStub(dir, "node", NODE_STUB, "NODE_STUB_DIR");
		const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_REBASELINE_STEP), dir, node.env);
		assert.equal(run.status, 0, run.output);
		const args = fs.readFileSync(path.join(node.bin, "node.log"), "utf8").trim();
		assert.equal(args, "scripts/opencode-watch.mjs --update --output drift-report.md");
	});

	withTempDir("pff-watch-rebaseline-close-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_REBASELINE_CLOSE_STEP), dir, {
			...gh.env,
			GH_STUB_LIST: "12",
		});
		assert.equal(run.status, 0, run.output);
		const calls = ghCalls(gh.bin);
		const comment = calls.find((call) => call[0] === "issue" && call[1] === "comment");
		assert.ok(comment, `expected an issue comment call: ${JSON.stringify(calls)}`);
		assert.match(comment[comment.indexOf("--body") + 1], /rebaseline/i);
		const close = calls.find((call) => call[0] === "issue" && call[1] === "close");
		assert.ok(close, `expected an issue close call: ${JSON.stringify(calls)}`);
		assert.deepEqual(close.slice(2), ["12", "--reason", "completed"]);
	});
});

test("opencode-watch.yml commits the advanced baseline after any successful read", { skip: SKIP ?? (GIT_AVAILABLE ? undefined : "git is unavailable") }, () => {
	const gate = stepOf(WATCH, WATCH_JOB, WATCH_COMMIT_STEP).if ?? "";
	assert.match(gate, /steps\.check\.outputs\.exit_code == '0'/, "exit 0 advances and commits the baseline");
	assert.match(gate, /steps\.check\.outputs\.exit_code == '1'/, "a critical run still advances informational signals");
	assert.match(gate, /inputs\.rebaseline == 'true'/, "the manual rebaseline commits its state");

	const git = (dir: string, args: string[]): void => {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	};

	withTempDir("pff-watch-commit-", (dir) => {
		fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
		const stateFile = path.join(dir, ".github", "opencode-watch-state.json");
		fs.writeFileSync(stateFile, '{ "lastRelease": "v1.0.0" }\n');
		git(dir, ["init", "-q", "-b", "main"]);
		git(dir, ["config", "user.name", "workflow-test"]);
		git(dir, ["config", "user.email", "workflow-test@example.com"]);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-qm", "init"]);
		git(dir, ["init", "-q", "--bare", "remote.git"]);
		git(dir, ["remote", "add", "origin", "remote.git"]);
		git(dir, ["push", "-q", "-u", "origin", "main"]);

		fs.writeFileSync(stateFile, '{ "lastRelease": "v1.1.0" }\n');
		const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_COMMIT_STEP), dir, {});
		assert.equal(run.status, 0, run.output);
		assert.doesNotMatch(run.output, /No state changes to commit/);
		const subject = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir, encoding: "utf8" }).stdout ?? "";
		assert.match(subject, /chore\(watch\): update opencode watch state/);
		assert.equal(
			spawnSync("git", ["status", "--porcelain", "--", ".github/opencode-watch-state.json"], {
				cwd: dir,
				encoding: "utf8",
			}).stdout,
			"",
			"the advanced state must be committed",
		);

		const clean = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_COMMIT_STEP), dir, {});
		assert.equal(clean.status, 0, clean.output);
		assert.match(clean.output, /No state changes to commit/, "an unchanged baseline commits nothing");
	});
});

// ── model health check: exit-code classification and close ──────────────────

test("opencode-model-check.yml maps the probe exit code onto the alert/infra flags", { skip: SKIP }, () => {
	const expectations: Array<[number, string, string]> = [
		// [node exit code, AFFECTED_MODELS, INFRA_FAILURE]
		[0, "false", "false"],
		[1, "true", "false"],
		[2, "false", "true"],
		// Any other code (signal death, unhandled crash) is infra, never a clean run.
		[137, "false", "true"],
	];
	for (const [code, affected, infra] of expectations) {
		withTempDir(`pff-model-${code}-`, (dir) => {
			const node = makeStub(dir, "node", NODE_STUB, "NODE_STUB_DIR");
			const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_PROBE_STEP), dir, {
				...node.env,
				NODE_STUB_EXIT: String(code),
			});
			assert.equal(run.status, 0, `exit ${code}: the classifying step itself must succeed: ${run.output}`);
			assert.match(run.envFile, new RegExp(`^AFFECTED_MODELS=${affected}$`, "m"), `exit ${code} env`);
			assert.match(run.envFile, new RegExp(`^INFRA_FAILURE=${infra}$`, "m"), `exit ${code} env`);
			assert.match(run.outFile, new RegExp(`^exit_code=${code}$`, "m"), `exit ${code} output`);

			const args = fs.readFileSync(path.join(node.bin, "node.log"), "utf8").trim();
			assert.equal(
				args,
				"--experimental-strip-types scripts/check-opencode-models.ts --output model-health-report.md --json",
			);
		});
	}
});

test("opencode-model-check.yml warns about unavailable models without filing an issue", { skip: SKIP }, () => {
	// The gate is GitHub's, so assert it on the parsed document: a run with a
	// dead model must not annotate this path (it files the alert instead).
	assert.equal(
		stepOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_ANNOTATE_STEP).if,
		"always() && env.INFRA_FAILURE != 'true' && env.AFFECTED_MODELS != 'true'",
	);

	withTempDir("pff-model-degraded-", (dir) => {
		fs.writeFileSync(
			path.join(dir, "model-health.json"),
			JSON.stringify({ affectedCount: 2, deadCount: 0, degradedCount: 2, results: [] }),
		);
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_ANNOTATE_STEP), dir, {
			AFFECTED_MODELS: "false",
			INFRA_FAILURE: "false",
		});
		assert.equal(run.status, 0, run.output);
		assert.match(run.output, /::warning::2 OpenCode free-tier model\(s\)/);
	});

	withTempDir("pff-model-clean-", (dir) => {
		fs.writeFileSync(
			path.join(dir, "model-health.json"),
			JSON.stringify({ affectedCount: 0, deadCount: 0, degradedCount: 0, results: [] }),
		);
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_ANNOTATE_STEP), dir, {
			AFFECTED_MODELS: "false",
			INFRA_FAILURE: "false",
		});
		assert.equal(run.status, 0, run.output);
		assert.ok(!/::warning::/.test(run.output), "a fully healthy run must not warn");
	});

	withTempDir("pff-model-nojson-", (dir) => {
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_ANNOTATE_STEP), dir, {
			AFFECTED_MODELS: "false",
			INFRA_FAILURE: "false",
		});
		assert.equal(run.status, 0, run.output);
		assert.match(run.output, /No probe JSON available/);
	});
});

test("opencode-model-check.yml replaces the alert body instead of commenting every run", { skip: SKIP }, () => {
	assert.equal(stepOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_ISSUE_STEP).if, "env.AFFECTED_MODELS == 'true'");

	withTempDir("pff-model-issue-", (dir) => {
		fs.writeFileSync(path.join(dir, "model-health-report.md"), "## report\n");
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_ISSUE_STEP), dir, {
			...gh.env,
			GH_STUB_LIST: "7",
		});
		assert.equal(run.status, 0, run.output);
		const calls = ghCalls(gh.bin);
		const edit = calls.find((call) => call[0] === "issue" && call[1] === "edit");
		assert.ok(edit, `expected an issue edit call: ${JSON.stringify(calls)}`);
		assert.deepEqual(edit.slice(2), ["7", "--body-file", "model-health-report.md"]);
		assert.equal(calls.filter((call) => call[1] === "comment").length, 0, "an update must not append a comment");
		assert.match(run.envFile, /^ALERT_ISSUE_TOUCHED=true$/m);
	});

	withTempDir("pff-model-issue-new-", (dir) => {
		fs.writeFileSync(path.join(dir, "model-health-report.md"), "## report\n");
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_ISSUE_STEP), dir, {
			...gh.env,
			GH_STUB_LIST: "",
		});
		assert.equal(run.status, 0, run.output);
		const calls = ghCalls(gh.bin);
		const create = calls.find((call) => call[0] === "issue" && call[1] === "create");
		assert.ok(create, `expected an issue create call: ${JSON.stringify(calls)}`);
		assert.ok(create.includes("opencode-model-alert"), "the alert label must be applied");
		assert.ok(create.includes("--body-file"));
		assert.equal(calls.filter((call) => call[1] === "comment").length, 0);
	});
});

test("opencode-model-check.yml closes the alert issue only after a healthy probe", { skip: SKIP }, () => {
	assert.equal(stepOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_CLOSE_STEP).if, "steps.probe.outputs.exit_code == '0'");

	withTempDir("pff-model-close-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_CLOSE_STEP), dir, {
			...gh.env,
			GH_STUB_LIST: "7",
		});
		assert.equal(run.status, 0, run.output);
		const calls = ghCalls(gh.bin);
		const comment = calls.find((call) => call[0] === "issue" && call[1] === "comment");
		assert.ok(comment, `expected an issue comment call: ${JSON.stringify(calls)}`);
		assert.match(comment[comment.indexOf("--body") + 1], /No OpenCode free-tier model is dead/);
		const close = calls.find((call) => call[0] === "issue" && call[1] === "close");
		assert.ok(close, `expected an issue close call: ${JSON.stringify(calls)}`);
		assert.deepEqual(close.slice(2), ["7", "--reason", "completed"]);
	});

	withTempDir("pff-model-close-touched-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_CLOSE_STEP), dir, {
			...gh.env,
			GH_STUB_LIST: "7",
			ALERT_ISSUE_TOUCHED: "true",
		});
		assert.equal(run.status, 0, run.output);
		assert.match(run.output, /a later healthy run owns the close/);
		assert.deepEqual(ghCalls(gh.bin), [], "a run that edited the alert must not close it");
	});

	withTempDir("pff-model-close-none-", (dir) => {
		const gh = makeStub(dir, "gh", GH_STUB, "GH_STUB_DIR");
		const run = runStep(scriptOf(MODEL_CHECK, MODEL_CHECK_JOB, MODEL_CHECK_CLOSE_STEP), dir, {
			...gh.env,
			GH_STUB_LIST: "",
		});
		assert.equal(run.status, 0, run.output);
		assert.equal(ghCalls(gh.bin).filter((call) => call[1] === "close").length, 0);
	});
});
