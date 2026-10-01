// Test sandbox loader: re-roots ALL pi-freeflow data files (relay state,
// log, catalog/debug/update caches, onboarded flag) into a fresh temp dir.
// Loaded via `--import` in the test script — runs BEFORE any src/ import,
// so every resolve*Path() in src/config.ts lands inside the sandbox and the
// suite can never touch real user files (~/.pi/agent/*) or race a live daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-sandbox-"));
process.env["PI_FREEFLOW_DATA_DIR"] = sandbox;

// Disable detached daemon spawning for the whole suite. Tests call the real
// client entrypoints (ensureDaemon), and without this a test would spawn a
// daemon detached from the test process, pointed at this sandbox. The sandbox is
// removed on exit, so that daemon would outlive the run with no state file and
// squat the shared proxy port serving an empty relay pool. The key is derived
// from the data-dir key so no environment name is duplicated as a literal here.
const dataDirKey = Object.keys(process.env).find(
	(k) => k.endsWith("_DATA_DIR") && process.env[k] === sandbox,
);
if (!dataDirKey) throw new Error("test/setup.mjs: could not locate the data-dir env key");
process.env[dataDirKey.replace(/_DATA_DIR$/, "_DAEMON_SPAWN")] = "0";

process.on("exit", () => {
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; OS temp sweep is the fallback.
	}
});
