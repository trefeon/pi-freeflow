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
 *
 * Every step installs the tarball attached to the latest GitHub release
 * (releaseTarballUrl), so an update never depends on the npm registry.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { getClientPort } from "./client.ts";
import {
 RELEASES_PAGE_URL,
 compareVersions,
 downloadReleaseTarball,
 fetchLatestVersion,
 getLocalVersion,
 removeReleaseTarball,
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

const npmManual = (spec: string): string => `npm i -g ${spec}`;
const bunManual = (spec: string): string => `bun add -g ${spec}`;

/**
 * Pick the global update step. npm wins when present; bun covers machines
 * where npm is missing. Returns null when neither manager is on PATH, in
 * which case the caller keeps the previous manual-install hint.
 *
 * `spec` is the release tarball URL (see releaseTarballUrl): installs read
 * the GitHub release asset, never the npm registry.
 */
export function selectGlobalUpdatePlan(opts: {
 npmAvailable: boolean;
 bunAvailable: boolean;
 spec: string;
}): GlobalUpdatePlan | null {
 if (opts.npmAvailable)
  return { cmd: "npm", args: ["i", "-g", opts.spec], manual: npmManual(opts.spec) };
 if (opts.bunAvailable)
  return { cmd: "bun", args: ["add", "-g", opts.spec], manual: bunManual(opts.spec) };
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
     let child: ChildProcess | undefined;
     const timer = setTimeout(() => {
      try { child?.kill(); } catch { }
      resolve(false);
     }, PROBE_TIMEOUT_MS);
     timer.unref?.();
     try {
      child = spawn(cmd, ["--version"], {
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

 // The release tarball is downloaded first: npm 12 refuses remote and git
 // specifiers by default, so only a local file installs everywhere.
 const tarball = await downloadReleaseTarball(latest);
 if (tarball === null) {
  return {
   ok: false,
   error: `could not download the v${latest} release tarball — see ${RELEASES_PAGE_URL}`,
  };
 }

 // Probe concurrently and off the event loop: two sequential 10s spawnSync
 // probes would stall activation for the better part of a minute.
 const [npmAvailable, bunAvailable] = await probeCommandsAvailable(["npm", "bun"]);
 const plan = selectGlobalUpdatePlan({ npmAvailable, bunAvailable, spec: tarball });
 if (plan === null) {
  return {
   ok: false,
   error: `no package manager found (npm, bun) — install ${tarball} by hand or see ${RELEASES_PAGE_URL}`,
  };
 }
 const outcome = await runStep(plan.cmd, plan.args, plan.manual);
 if (outcome.code === 0) {
  await removeReleaseTarball(tarball);
 } else {
  return {
   ok: false,
   error: `update command failed (exit code ${outcome.code}) — ${plan.manual}${outcome.tail.trim() ? `: ${outcome.tail.trim()}` : ""}`,
  };
 }
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
