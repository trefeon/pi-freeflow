/**
 * System login startup hook installer/uninstaller for pi-freeflow daemon.
 *
 * Windows: Scheduled Task (schtasks /sc onlogon)
 * Linux/macOS: User systemd unit (~/.config/systemd/user/pi-freeflow.service)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isJsRuntimeExecutable, materializeDaemonSources, resolveDaemonRuntime } from "./client-staging.ts";
import { DAEMON_SPAWN_ENV } from "./config.ts";
import type { ExtensionContext } from "./types.ts";

export const STARTUP_TASK_NAME = "pi-freeflow-daemon";
export const STARTUP_SERVICE_NAME = "pi-freeflow.service";

/**
 * How the POSIX startup hook talks to the user systemd manager. A seam
 * because CI (and this Windows dev box) has no user bus: tests must be able to
 * prove both the enabled and the systemd-less outcome deterministically.
 */
let startupHookRunner: (cmd: string) => void = (cmd: string): void => {
 execSync(cmd, { timeout: 10_000, stdio: "ignore" });
};

/** Test-only: replace the user-systemd runner (null restores execSync). */
export function _setStartupHookRunnerForTest(runner: ((cmd: string) => void) | null): void {
 startupHookRunner =
  runner ??
  ((cmd: string): void => {
   execSync(cmd, { timeout: 10_000, stdio: "ignore" });
  });
}

export interface StartupPlan {
 platform: string;
 taskName: string;
 command: string;
 filePath: string;
 fileContent: string;
 undo: string;
}

function daemonEntryForStartup(scriptOverride?: string): string {
 if (scriptOverride) return scriptOverride;
 try {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts");
 } catch {
  return path.join("src", "daemon.ts");
 }
}

/**
 * The `/tr` payload for a Windows scheduled task action.
 *
 * A task action is launched by CreateProcess, which has no single-quote
 * syntax: the old `'…'` substitution handed it a first token carrying a
 * literal `'` ("The filename, directory name, or volume label syntax is
 * incorrect"), so the startup task could never start. Double quotes are the
 * only grouping CreateProcess understands, so keep them and escape them for
 * cmd.exe (`\"`); schtasks stores the resulting action verbatim, which is
 * exactly the quoted runtime command the task must run.
 */
export function escapeSchTasksAction(quotedCommand: string): string {
 return quotedCommand.replace(/"/g, '\\"');
}

/**
 * Build the single-shot login-startup plan without touching the system.
 * Windows → logon Scheduled Task (schtasks /sc onlogon, single run at logon).
 * Linux/macOS → user systemd unit (Type=oneshot, WantedBy=default.target).
 * Pure (testable): all paths/commands are derived from the overrides.
 */
export function getStartupPlan(opts?: {
 platform?: string;
 homeDir?: string;
 execPath?: string;
 scriptPath?: string;
}): StartupPlan {
 const platform = opts?.platform ?? process.platform;
 const home = opts?.homeDir ?? os.homedir();
 const script = daemonEntryForStartup(opts?.scriptPath);
 // A Node runtime cannot strip types for files under node_modules, so the
 // hook must point at staged sources when the package is installed (issue #52).
 // Bun runs TypeScript anywhere — keep its command side-effect free.
 const nodeEntry = (): string => materializeDaemonSources(script);
 let quoted: string;
 if (opts?.execPath) {
  const type = isJsRuntimeExecutable(opts.execPath);
  if (type === "bun") {
   quoted = `"${opts.execPath}" "${script}"`;
  } else {
   quoted = `"${opts.execPath}" --experimental-strip-types "${nodeEntry()}"`;
  }
 } else {
  const runtime = resolveDaemonRuntime({ scriptPath: script });
  if (runtime) {
   if (runtime.runtimeType === "bun") {
    quoted = `"${runtime.execPath}" "${script}"`;
   } else {
    quoted = `"${runtime.execPath}" --experimental-strip-types "${nodeEntry()}"`;
   }
  } else {
   quoted = `"node" --experimental-strip-types "${nodeEntry()}"`;
  }
 }
 if (platform === "win32") {
  const command = `schtasks /create /tn "${STARTUP_TASK_NAME}" /tr "${escapeSchTasksAction(quoted)}" /sc onlogon /rl limited /f`;
  return {
   platform,
   taskName: STARTUP_TASK_NAME,
   command,
   filePath: `Scheduled Task \\${STARTUP_TASK_NAME} (logon trigger, single-shot)`,
   fileContent: command,
   undo: `schtasks /delete /tn "${STARTUP_TASK_NAME}" /f`,
  };
 }
 const filePath = path.join(home, ".config", "systemd", "user", STARTUP_SERVICE_NAME);
 const fileContent = [
  "[Unit]",
  "Description=pi-freeflow proxy daemon (single-shot at login)",
  "After=default.target",
  "",
  "[Service]",
  "Type=oneshot",
  `ExecStart=${quoted}`,
  "RemainAfterExit=yes",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
 ].join("\n");
 return {
  platform,
  taskName: STARTUP_SERVICE_NAME,
  command: `systemctl --user enable ${STARTUP_SERVICE_NAME}`,
  filePath,
  fileContent,
  undo: `systemctl --user disable ${STARTUP_SERVICE_NAME} && rm "${filePath}"`,
 };
}

/**
 * Install the login-startup hook (single-shot, idempotent). Returns whether a
 * change was made plus the exact undo text for the caller to display.
 * Refuses when DAEMON_SPAWN=0. Never throws — failures are returned.
 */
export function installStartupHook(opts?: {
 platform?: string;
 homeDir?: string;
 execPath?: string;
 scriptPath?: string;
}): { ok: boolean; changed: boolean; undo: string; detail: string } {
 if (process.env[DAEMON_SPAWN_ENV] === "0") {
  return { ok: false, changed: false, undo: "", detail: "refused: daemon spawn is disabled (DAEMON_SPAWN=0)" };
 }
 const plan = getStartupPlan(opts);
 try {
  if (plan.platform === "win32") {
   try {
    const q = execSync(`schtasks /query /tn "${STARTUP_TASK_NAME}"`, { encoding: "utf8", timeout: 5000, windowsHide: true }) as string;
    if (q && q.includes(STARTUP_TASK_NAME)) {
     execSync(plan.command, { timeout: 10_000, stdio: "ignore", windowsHide: true });
     return { ok: true, changed: false, undo: plan.undo, detail: `already installed — refreshed logon task "${STARTUP_TASK_NAME}" (undo: ${plan.undo})` };
    }
   } catch { }
   execSync(plan.command, { timeout: 10_000, stdio: "ignore", windowsHide: true });
   return { ok: true, changed: true, undo: plan.undo, detail: `installed logon task "${STARTUP_TASK_NAME}" (undo: ${plan.undo})` };
  }
  const dir = path.dirname(plan.filePath);
  fs.mkdirSync(dir, { recursive: true });
  let existing = "";
  try {
   existing = fs.readFileSync(plan.filePath, "utf8");
  } catch { }
  if (existing === plan.fileContent) {
   return { ok: true, changed: false, undo: plan.undo, detail: `already installed — ${plan.filePath} up to date (undo: ${plan.undo})` };
  }
  fs.writeFileSync(plan.filePath, plan.fileContent, "utf8");
  // Writing the unit file arms nothing by itself: `systemctl --user enable`
  // creates the login symlink. WSL, containers and hosts without a user
  // manager fail here, and reporting ok:true left the hook silently dead.
  let enableError = "";
  for (const cmd of ["systemctl --user daemon-reload", plan.command]) {
   try {
    startupHookRunner(cmd);
   } catch (e) {
    enableError = enableError || String(e);
   }
  }
  if (enableError !== "") {
   return {
    ok: false,
    changed: true,
    undo: plan.undo,
    detail: `installed ${plan.filePath} but could not enable it at login: ${enableError} — enable by hand: "${plan.command}" (undo: ${plan.undo})`,
   };
  }
  return { ok: true, changed: true, undo: plan.undo, detail: `installed ${plan.filePath} (undo: ${plan.undo})` };
 } catch (e) {
  return { ok: false, changed: false, undo: plan.undo, detail: `install failed: ${String(e)} (undo: ${plan.undo})` };
 }
}

/**
 * Remove the login-startup hook (idempotent). Returns the undo/redo text.
 * Refuses when DAEMON_SPAWN=0, matching install.
 */
export function uninstallStartupHook(opts?: {
 platform?: string;
 homeDir?: string;
 execPath?: string;
 scriptPath?: string;
}): { ok: boolean; changed: boolean; undo: string; detail: string } {
 if (process.env[DAEMON_SPAWN_ENV] === "0") {
  return { ok: false, changed: false, undo: "", detail: "refused: daemon spawn is disabled (DAEMON_SPAWN=0)" };
 }
 const plan = getStartupPlan(opts);
 try {
  if (plan.platform === "win32") {
   try {
    execSync(plan.undo, { timeout: 10_000, stdio: "ignore", windowsHide: true });
    return { ok: true, changed: true, undo: plan.command, detail: `removed logon task "${STARTUP_TASK_NAME}" (re-install: ${plan.command})` };
   } catch {
    return { ok: true, changed: false, undo: plan.command, detail: `already removed — no logon task "${STARTUP_TASK_NAME}" found` };
   }
  }
  let existed = false;
  try {
   fs.accessSync(plan.filePath, fs.constants.F_OK);
   existed = true;
  } catch { }
  if (!existed) {
   return { ok: true, changed: false, undo: plan.command, detail: `already removed — no unit file at ${plan.filePath}` };
  }
  try {
   execSync(`systemctl --user disable ${STARTUP_SERVICE_NAME}`, { timeout: 10_000, stdio: "ignore" });
  } catch { }
  fs.rmSync(plan.filePath, { force: true });
  return { ok: true, changed: true, undo: plan.command, detail: `removed ${plan.filePath} (re-install: ${plan.command})` };
 } catch (e) {
  return { ok: false, changed: false, undo: plan.undo, detail: `uninstall failed: ${String(e)}` };
 }
}

export function handleStartupSubcommand(sub: string, ctx: ExtensionContext): boolean {
 if (sub === "install-startup") {
  const r = installStartupHook();
  ctx.ui.notify(r.detail, r.ok ? "info" : "warning");
  return true;
 }
 if (sub === "uninstall-startup") {
  const r = uninstallStartupHook();
  ctx.ui.notify(r.detail, r.ok ? "info" : "warning");
  return true;
 }
 return false;
}
