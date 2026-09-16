/**
 * Global and host package-manager selection for the /freeflow update command.
 *
 * The update flow tries the host plugin managers first and only then falls
 * back to a global package install. npm is preferred among global managers
 * when present; on machines where only bun is installed (npm missing from
 * PATH) the same update runs through the equivalent bun command instead of
 * failing with a manual-install note.
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

export interface HostUpdateStep {
	/** Binary to run. */
	cmd: string;
	/** Arguments to run it with. */
	args: string[];
	/** Exact command the user can run by hand if the automated step fails. */
	manual: string;
}

/**
 * Host plugin-manager steps in try-order; the caller runs them and stops at
 * the first exit 0. Neither host offers an `update` action for registry
 * plugins — omp updates by reinstall (`plugin install pkg@latest`) and pi
 * updates the named package (`update <source>`) — so those are the steps.
 * No reliable signal names the host running this extension, hence the fixed
 * omp → pi order.
 */
export function selectHostUpdateSteps(opts: {
	ompAvailable: boolean;
	piAvailable: boolean;
}): HostUpdateStep[] {
	const steps: HostUpdateStep[] = [];
	if (opts.ompAvailable)
		steps.push({
			cmd: "omp",
			args: ["plugin", "install", "pi-freeflow@latest"],
			manual: "omp plugin install pi-freeflow@latest",
		});
	if (opts.piAvailable)
		steps.push({ cmd: "pi", args: ["update", "pi-freeflow"], manual: "pi update pi-freeflow" });
	return steps;
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
