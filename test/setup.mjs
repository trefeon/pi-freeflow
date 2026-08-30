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

process.on("exit", () => {
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; OS temp sweep is the fallback.
	}
});
