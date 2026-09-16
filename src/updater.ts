/**
 * Global package-manager selection for the /freeflow update command.
 *
 * The update flow first tries the host plugin manager. When that is not
 * available it falls back to a global package install. npm is preferred when
 * present; on machines where only bun is installed (npm missing from PATH)
 * the same update runs through the equivalent bun command instead of failing
 * with a manual-install note.
 */

import { spawnSync } from "node:child_process";

export interface GlobalUpdatePlan {
	/** Binary to run. */
	cmd: string;
	/** Arguments to run it with. */
	args: string[];
	/** Exact command the user can run by hand if the automated step fails. */
	manual: string;
}

const NPM_MANUAL = "npm i -g pi-freeflow@latest";
const BUN_MANUAL = "bun add -g pi-freeflow@latest";

/**
 * Pick the global update step. npm wins when present; bun covers machines
 * where npm is missing. Returns null when neither manager is on PATH, in
 * which case the caller keeps the previous manual-install hint.
 */
export function selectGlobalUpdatePlan(opts: {
	npmAvailable: boolean;
	bunAvailable: boolean;
}): GlobalUpdatePlan | null {
	if (opts.npmAvailable)
		return { cmd: "npm", args: ["i", "-g", "pi-freeflow@latest"], manual: NPM_MANUAL };
	if (opts.bunAvailable)
		return { cmd: "bun", args: ["add", "-g", "pi-freeflow@latest"], manual: BUN_MANUAL };
	return null;
}

/**
 * True when `cmd --version` runs cleanly, i.e. the binary resolves from PATH.
 * Uses a shell on Windows so *.cmd shims resolve the same way they do for
 * the real update spawn; direct exec elsewhere.
 */
export function isCommandAvailable(cmd: string): boolean {
	if (!/^[A-Za-z0-9_.-]+$/.test(cmd)) return false;
	try {
		// Single-string form under a Windows shell: avoids the args+shell
		// concat warning and resolves *.cmd shims like the update spawn does.
		const res =
			process.platform === "win32"
				? spawnSync(cmd + " --version", { stdio: "ignore", timeout: 10_000, windowsHide: true, shell: true })
				: spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 10_000, windowsHide: true });
		return res.error === undefined && res.status === 0;
	} catch {
		return false;
	}
}
