/**
 * Global and host package-manager selection for the /freeflow update command.
 *
 * The update flow tries the host plugin managers first and only then falls
 * back to a global package install. npm is preferred among global managers
 * when present; on machines where only bun is installed (npm missing from
 * PATH) the same update runs through the equivalent bun command instead of
 * failing with a manual-install note.
 *
 * Every install runs through the asynchronous step runner in update-core.ts:
 * auto-update is triggered from extension activation, so a blocking
 * spawnSync install (minutes on npm/bun) would freeze the host TUI.
 */

import { spawn, spawnSync } from "node:child_process";

import { getClientPort } from "./client.ts";
import {
 compareVersions,
 fetchLatestVersion,
 getLocalVersion,
 runUpdateStep,
} from "./update-core.ts";
import { PORT } from "./config.ts";

interface GlobalUpdatePlan {
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

interface HostUpdateStep {
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
 * the real update spawn; direct exec elsewhere. Bounded at 10s per probe: the
 * install steps (the long part) are asynchronous.
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

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Non-blocking variant of isCommandAvailable for the background auto-update:
 * all four probes run concurrently on the event loop instead of blocking it
 * for up to 10s each in sequence. The sync version stays for the foreground
 * /freeflow update command path.
 */
export function probeCommandsAvailable(cmds: string[]): Promise<boolean[]> {
 return Promise.all(
  cmds.map(
   (cmd) =>
    new Promise<boolean>((resolve) => {
     if (!/^[A-Za-z0-9_.-]+$/.test(cmd)) {
      resolve(false);
      return;
     }
     const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
     try {
      const child = spawn(cmd, ["--version"], {
       stdio: "ignore",
       windowsHide: true,
       shell: process.platform === "win32",
      });
      child.on("error", () => {
       clearTimeout(timer);
       resolve(false);
      });
      child.on("close", (code: number | null) => {
       clearTimeout(timer);
       resolve(code === 0);
      });
     } catch {
      clearTimeout(timer);
      resolve(false);
     }
    }),
  ),
 );
}

/**
 * Automatically perform an update to the latest published version and
 * restart the local proxy daemon.
 *
 * Never blocks the event loop: each install is awaited asynchronously, and
 * only the last few lines of its output are kept for a failure message —
 * a background update must not stream installer noise into the host TUI.
 */
export async function performAutoUpdate(
 onProgress?: (message: string) => void,
): Promise<{ ok: boolean; version?: string; error?: string }> {
 const latest = await fetchLatestVersion();
 if (!latest) return { ok: false, error: "could not fetch latest version" };
 const local = getLocalVersion();
 if (local !== null && compareVersions(latest, local) <= 0) {
  return { ok: true, version: local };
 }
 onProgress?.(
  local === null
   ? `Auto-updating pi-freeflow to v${latest} (local version unreadable)…`
   : `Auto-updating pi-freeflow: v${local} → v${latest}…`,
 );

 const runStep = async (
  cmd: string,
  args: string[],
  manual: string,
 ): Promise<{ code: number; tail: string }> => {
  onProgress?.(`Running ${manual}…`);
  let tail = "";
  const code = await runUpdateStep(cmd, args, {
   timeoutMs: 120_000,
   onOutput: (line) => {
    // Keep only the tail of installer output for a failure message;
    // a background update must not stream it into the host TUI.
    const joined = tail ? `${tail}\n${line}` : line;
    tail = joined.length > 800 ? joined.slice(-800) : joined;
   },
   onWarning: (message) => onProgress?.(message),
  });
  return { code, tail };
 };

 // Probe concurrently and off the event loop: four sequential 10s spawnSync
 // probes could stall activation for the better part of a minute.
 const [ompAvailable, piAvailable, npmAvailable, bunAvailable] = await probeCommandsAvailable([
  "omp",
  "pi",
  "npm",
  "bun",
 ]);
 const manuals: string[] = [];
 let outcome = { code: 1, tail: "" };
 for (const step of selectHostUpdateSteps({ ompAvailable, piAvailable })) {
  manuals.push(step.manual);
  outcome = await runStep(step.cmd, step.args, step.manual);
  if (outcome.code === 0) break;
 }
 if (outcome.code !== 0) {
  const plan = selectGlobalUpdatePlan({ npmAvailable, bunAvailable });
  if (plan) {
   manuals.push(plan.manual);
   outcome = await runStep(plan.cmd, plan.args, plan.manual);
  }
 }
 if (outcome.code === 0) {
  onProgress?.(`pi-freeflow auto-updated to v${latest} — restarting proxy daemon…`);
  // Restart the proxy that is actually attached: a walked port (base busy)
  // must not leave the live daemon serving the old build.
  const port = getClientPort() || PORT;
  // Lazy edge: proxy.ts is the heavy serving sibling and the updater only
  // needs its port killer after a successful install.
  const { killPortHolder } = await import("./proxy.ts");
  await killPortHolder(port);
  return { ok: true, version: latest };
 }
 const detail = outcome.tail.trim() ? `: ${outcome.tail.trim()}` : "";
 if (manuals.length === 0) {
  return {
   ok: false,
   error: `no update manager found (omp, pi, npm, bun) — install manually: npm i -g pi-freeflow@latest${detail}`,
  };
 }
 return { ok: false, error: `update command failed (exit code ${outcome.code}) — tried: ${manuals.join(", ")}${detail}` };
}
