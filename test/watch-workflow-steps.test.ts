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

const MODEL_CHECK = "opencode-model-check.yml";
const MODEL_CHECK_JOB = "check-models";
const MODEL_CHECK_PROBE_STEP = "Probe All OpenCode Free Tier Models";
const MODEL_CHECK_CLOSE_STEP = "Close Recovered Alert Issue";

// ── drift watcher: exit-code classification ─────────────────────────────────

test("opencode-watch.yml maps the watcher exit code onto the drift/infra flags", { skip: SKIP }, () => {
	const expectations: Array<[number, string, string, string]> = [
		// [node exit code, DRIFT_DETECTED, INFRA_FAILURE, drift output]
		[0, "false", "false", "false"],
		[1, "true", "false", "true"],
		[2, "false", "true", "false"],
	];
	for (const [code, drift, infra, driftOutput] of expectations) {
		withTempDir(`pff-watch-${code}-`, (dir) => {
			const node = makeStub(dir, "node", NODE_STUB, "NODE_STUB_DIR");
			const run = runStep(scriptOf(WATCH, WATCH_JOB, WATCH_CHECK_STEP), dir, {
				...node.env,
				NODE_STUB_EXIT: String(code),
			});
			assert.equal(run.status, 0, `exit ${code}: the classifying step itself must succeed: ${run.output}`);
			assert.match(run.envFile, new RegExp(`^DRIFT_DETECTED=${drift}$`, "m"), `exit ${code} env`);
			assert.match(run.envFile, new RegExp(`^INFRA_FAILURE=${infra}$`, "m"), `exit ${code} env`);
			assert.match(run.outFile, new RegExp(`^exit_code=${code}$`, "m"), `exit ${code} output`);
			assert.match(run.outFile, new RegExp(`^drift=${driftOutput}$`, "m"), `exit ${code} output`);

			const args = fs.readFileSync(path.join(node.bin, "node.log"), "utf8").trim();
			assert.equal(args, "scripts/opencode-watch.mjs --check --output drift-report.md");
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

// ── model health check: exit-code classification and close ──────────────────

test("opencode-model-check.yml maps the probe exit code onto the alert/infra flags", { skip: SKIP }, () => {
	const expectations: Array<[number, string, string]> = [
		// [node exit code, AFFECTED_MODELS, INFRA_FAILURE]
		[0, "false", "false"],
		[1, "true", "false"],
		[2, "false", "true"],
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
			assert.equal(args, "--experimental-strip-types scripts/check-opencode-models.ts --output model-health-report.md");
		});
	}
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
		assert.match(comment[comment.indexOf("--body") + 1], /healthy again/);
		const close = calls.find((call) => call[0] === "issue" && call[1] === "close");
		assert.ok(close, `expected an issue close call: ${JSON.stringify(calls)}`);
		assert.deepEqual(close.slice(2), ["7", "--reason", "completed"]);
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
