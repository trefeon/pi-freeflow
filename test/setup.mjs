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

// Point the suite at a dedicated proxy port. A test that spawns a daemon must
// never be able to occupy the real default port: such a daemon outlives the run
// still holding this sandbox as its data directory, and would then serve an
// empty relay pool to the user's live sessions. Mirrors test/user-flow-env.ts —
// the key name is read from src/config.ts source text so no environment name is
// duplicated here.
const configSrc = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const portMatch = /process\.env\.([A-Z0-9_]+)_PORT/.exec(configSrc);
if (!portMatch) throw new Error("test/setup.mjs: src/config.ts must read a *_PORT env var");
process.env[`${portMatch[1]}_PORT`] = "29752";

process.on("exit", () => {
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; OS temp sweep is the fallback.
	}
});
