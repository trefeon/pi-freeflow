/**
 * Data-file paths must follow pi's agent-dir global (PI_CODING_AGENT_DIR)
 * instead of hardcoding ~/.pi/agent, so CI/containers can relocate writes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import {
	AGENT_DIR_ENV,
	DATA_DIR_ENV,
	resolveCatalogCachePath,
	resolveDaemonSrcCacheDir,
	resolveDebugStatePath,
	resolveLogFilePath,
	resolveOnboardedFlagPath,
	resolveRelayStatePath,
	resolveSessionPinPath,
	resolveUpdateCachePath,
	resolveUpstreamHealthPath,
} from "../src/config.ts";

/** Run fn with both path-root overrides controlled by the test. */
function withRoots(
	agentDir: string | undefined,
	dataDir: string | undefined,
	fn: () => void,
): void {
	const savedAgent = process.env[AGENT_DIR_ENV];
	const savedData = process.env[DATA_DIR_ENV];
	try {
		if (agentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = agentDir;
		if (dataDir === undefined) delete process.env[DATA_DIR_ENV];
		else process.env[DATA_DIR_ENV] = dataDir;
		fn();
	} finally {
		if (savedAgent === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = savedAgent;
		if (savedData === undefined) delete process.env[DATA_DIR_ENV];
		else process.env[DATA_DIR_ENV] = savedData;
	}
}

test("PI_CODING_AGENT_DIR re-roots data files", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-agent-"));
	try {
		withRoots(agentDir, undefined, () => {
			assert.equal(
				resolveRelayStatePath(),
				path.join(agentDir, "pi-freeflow-relay-state.json"),
			);
			assert.equal(
				resolveLogFilePath(),
				path.join(agentDir, "pi-freeflow.log"),
			);
			assert.equal(
				resolveUpstreamHealthPath(),
				path.join(agentDir, "pi-freeflow-upstream-health.json"),
			);
			assert.equal(
				resolveSessionPinPath(),
				path.join(agentDir, "pi-freeflow-session-pins.json"),
			);
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("PI_FREEFLOW_DATA_DIR still wins over PI_CODING_AGENT_DIR", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-agent-"));
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-data-"));
	try {
		withRoots(agentDir, dataDir, () => {
			assert.equal(
				resolveRelayStatePath(),
				path.join(dataDir, "pi-freeflow-relay-state.json"),
			);
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
});

test("unset overrides fall back to ~/.pi/agent", () => {
	withRoots(undefined, undefined, () => {
		assert.equal(
			resolveRelayStatePath(),
			path.join(homedir(), ".pi", "agent", "pi-freeflow-relay-state.json"),
		);
	});
});

test("every data file resolves under PI_CODING_AGENT_DIR", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-agent-"));
	try {
		withRoots(agentDir, undefined, () => {
			const files = [
				resolveRelayStatePath(),
				resolveLogFilePath(),
				resolveCatalogCachePath(),
				resolveDebugStatePath(),
				resolveUpdateCachePath(),
				resolveOnboardedFlagPath(),
				resolveUpstreamHealthPath(),
				resolveSessionPinPath(),
			];
			for (const file of files) {
				assert.equal(path.dirname(file), agentDir, file);
			}
			assert.equal(
				resolveDaemonSrcCacheDir(),
				path.join(agentDir, "pi-freeflow-daemon-src"),
			);
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("~ in an override root expands to the home dir", () => {
	withRoots("~/pi-agent-tilde", undefined, () => {
		assert.equal(
			resolveLogFilePath(),
			path.join(homedir(), "pi-agent-tilde", "pi-freeflow.log"),
		);
	});
});
