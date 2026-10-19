/**
 * Test helper: local-proxy authorization for every HTTP call the suite makes.
 *
 * The proxy writes a per-installation bearer token to `<data dir>/token` at
 * startup and requires it on `/v1/*` and the `/_*` routes. test/setup.mjs
 * re-roots the data dir into a fresh sandbox, so the token read here is the
 * sandbox daemon's own. Self-contained on purpose: test files use it before
 * any src/ module initializes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Data dir resolved the way src/config.ts does it, without importing it. */
export function testDataDir(): string {
	const override = process.env["PI_FREEFLOW_DATA_DIR"];
	if (typeof override === "string" && override.trim() !== "") return override;
	const agentDir = process.env["PI_CODING_AGENT_DIR"];
	if (typeof agentDir === "string" && agentDir.trim() !== "") return agentDir;
	return path.join(os.homedir(), ".pi", "agent");
}

/** Authorization header for local-proxy requests (spread into request headers).
 *  Empty object while the sandbox daemon has not written its token yet. */
export function authHeaders(dir: string = testDataDir()): Record<string, string> {
	let token = "";
	try {
		token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
	} catch { }
	return token ? { authorization: `Bearer ${token}` } : {};
}
