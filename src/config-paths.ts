/**
 * Data directory and persistent path resolution for pi-freeflow.
 */

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Env override that re-roots ALL pi-freeflow data files (tests/CI sandbox).
 *  Unset → pi's agent dir (PI_CODING_AGENT_DIR, else ~/.pi/agent). */
export const DATA_DIR_ENV = "PI_FREEFLOW_DATA_DIR";

/** Env var pi itself uses to re-root its config dir: pi names it
 *  `<APP_NAME>_CODING_AGENT_DIR` (stock pi → PI_CODING_AGENT_DIR, else
 *  ~/.pi/agent). Freeflow data files follow it so CI/containers only need to
 *  relocate one root instead of granting write access to a hardcoded home
 *  path; when another host (e.g. the omp plugin loader) does not set it, the
 *  ~/.pi/agent default keeps the shared daemon/log location. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Expand a leading ~ the way pi expands its own agent-dir value. */
function expandHome(value: string): string {
 if (value === "~") return homedir();
 if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
 return value;
}

function dataDirOverride(): string | null {
 const d = process.env[DATA_DIR_ENV];
 return typeof d === "string" && d.trim() !== "" ? expandHome(d) : null;
}

function defaultAgentDir(): string {
 const d = process.env[AGENT_DIR_ENV];
 if (typeof d === "string" && d.trim() !== "") return expandHome(d);
 return path.join(homedir(), ".pi", "agent");
}

function dataFilePath(name: string): string {
 const override = dataDirOverride();
 if (override) return path.join(override, name);
 return path.join(defaultAgentDir(), name);
}

/**
 * Per-installation proxy token file (src/token.ts reads/creates it at 0600).
 * Sits with the other data files so a sandboxed data dir relocates it too.
 */
export function resolveTokenPath(): string {
 try {
  return dataFilePath("token");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".pi-freeflow-token",
  );
 }
}

export function resolveRelayStatePath(): string {
 try {
  return dataFilePath("pi-freeflow-relay-state.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".relay-state.json",
  );
 }
}

export function resolveLogFilePath(): string {
 try {
  return dataFilePath("pi-freeflow.log");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   "pi-freeflow.log",
  );
 }
}

/**
 * Root directory for staged daemon sources — copies taken outside
 * node_modules because Node's type stripping refuses files under a
 * node_modules path (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, issue #52).
 * Version subdirectories live inside it.
 */
export function resolveDaemonSrcCacheDir(): string {
 try {
  return dataFilePath("pi-freeflow-daemon-src");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".pi-freeflow-daemon-src",
  );
 }
}

export function resolveCatalogCachePath(): string {
 try {
  return dataFilePath("pi-freeflow-catalog-cache.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".catalog-cache.json",
  );
 }
}

export function resolveDebugStatePath(): string {
 try {
  return dataFilePath("pi-freeflow-debug.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".debug-state.json",
  );
 }
}

export function resolveUpdateCachePath(): string {
 try {
  return dataFilePath("pi-freeflow-update.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".update-cache.json",
  );
 }
}

export function resolveOnboardedFlagPath(): string {
 try {
  return dataFilePath("pi-freeflow-onboarded");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".onboarded",
  );
 }
}

export function resolveUpstreamHealthPath(): string {
 try {
  return dataFilePath("pi-freeflow-upstream-health.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".upstream-health.json",
  );
 }
}

/** JSONL audit of tool-call turns that failed or needed repair (src/toolcall-audit.ts). */
export function resolveToolcallAuditPath(): string {
 try {
  return dataFilePath("toolcall-audit.jsonl");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".toolcall-audit.jsonl",
  );
 }
}

export function resolveSessionPinPath(): string {
 try {
  return dataFilePath("pi-freeflow-session-pins.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".session-pins.json",
  );
 }
}

export const RELAY_STATE_FILE = resolveRelayStatePath();
export const LOG_FILE = resolveLogFilePath();
export const CATALOG_CACHE_FILE = resolveCatalogCachePath();
export const DEBUG_STATE_FILE = resolveDebugStatePath();
export const UPDATE_CACHE_FILE = resolveUpdateCachePath();
export const ONBOARDED_FLAG_FILE = resolveOnboardedFlagPath();
export const UPDATE_CHECK_TTL_MS = 86_400_000;

// ── Security & Relay Validation ─────────────────────────────────────
/** Opt-out for tests/dev: when set to "1", relay URLs on http:// and private hosts are allowed. */
export const ALLOW_UNSAFE_RELAY_ENV = "PI_FREEFLOW_ALLOW_UNSAFE_RELAY";
/** Opt-out for the stale-daemon replace: when "1", a version-mismatched daemon is never killed. */
export const NO_KILL_ENV = ALLOW_UNSAFE_RELAY_ENV.replace("_ALLOW_UNSAFE_RELAY", "_NO_KILL");
/** When "0", the extension never spawns a detached proxy daemon (tests/CI). */
export const DAEMON_SPAWN_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_SPAWN");
/** Explicit runtime executable path for daemon.ts (overrides process.execPath and PATH search). */
export const DAEMON_RUNTIME_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_RUNTIME");
/** Lease TTL for attached clients (ms); expired leases are dropped by the daemon GC. */
export const DAEMON_TTL_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_TTL_MS");
/** Client heartbeat interval (ms) — must stay well under the lease TTL. */
export const DAEMON_HEARTBEAT_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_HEARTBEAT_MS");
/** Daemon GC sweep interval (ms). */
export const DAEMON_GC_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_GC_MS");
/** Zero-lease persistence window before a lease-less daemon exits (ms). */
export const DAEMON_GRACE_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_GRACE_MS");
/** Max time a client waits for a freshly spawned daemon to answer /_health (ms). */
export const DAEMON_READY_TIMEOUT_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_READY_TIMEOUT_MS");
/** Timeout for a single loopback control call (attach/heartbeat/detach) (ms). */
export const DAEMON_CONTROL_TIMEOUT_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_CONTROL_TIMEOUT_MS");
/** Client watchdog tick: how often /_health is polled for version + failed-SSE rate (ms). */
export const DAEMON_WATCHDOG_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_WATCHDOG_MS");

function envMs(name: string, fallback: number): number {
 const raw = process.env[name];
 if (raw) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
 }
 return fallback;
}

const IS_WINDOWS_HOST = process.platform === "win32";
export const DAEMON_SPAWN_ENABLED = process.env[DAEMON_SPAWN_ENV] !== "0";
export const DAEMON_TTL_MS = envMs(DAEMON_TTL_MS_ENV, 30_000);
export const DAEMON_HEARTBEAT_MS = envMs(DAEMON_HEARTBEAT_MS_ENV, IS_WINDOWS_HOST ? 8_000 : 10_000);
export const DAEMON_GC_MS = envMs(DAEMON_GC_MS_ENV, 5_000);
export const DAEMON_GRACE_MS = envMs(DAEMON_GRACE_MS_ENV, IS_WINDOWS_HOST ? 15_000 : 10_000);
export const DAEMON_READY_TIMEOUT_MS = envMs(DAEMON_READY_TIMEOUT_MS_ENV, 5_000);
export const DAEMON_CONTROL_TIMEOUT_MS = envMs(DAEMON_CONTROL_TIMEOUT_MS_ENV, IS_WINDOWS_HOST ? 3_000 : 1_500);
export const DAEMON_WATCHDOG_MS = envMs(DAEMON_WATCHDOG_MS_ENV, 5_000);
/** Failed-SSE rolling window (streams) and the failure rate that marks a daemon degraded. */
export const WATCHDOG_SSE_WINDOW = 20;
export const WATCHDOG_SSE_FAIL_RATE = 0.5;
/** Minimum samples before the failed-SSE rate can trigger recovery (avoids single-sample flapping). */
export const WATCHDOG_SSE_MIN_SAMPLES = 5;
/** Respawn backoff: min(2s * 2^n, 60s) + jitter. */
export const RECOVERY_BACKOFF_BASE_MS = 2_000;
export const RECOVERY_BACKOFF_CAP_MS = 60_000;
/** Breaker: 5 straight failures inside 5min halts respawn for 10min (in-process fallback meanwhile). */
export const BREAKER_FAILURES = 5;
export const BREAKER_WINDOW_MS = 5 * 60_000;
export const BREAKER_HALT_MS = 10 * 60_000;
/** Busy bypass: a busy daemon is replaced only after 5min continuous busy with zero forwarded bytes for 60s+. */
export const BUSY_BYPASS_CONTINUOUS_MS = 5 * 60_000;
export const BUSY_BYPASS_QUIET_MS = 60_000;
/** Re-probe of the base port before accepting a walked port (ms). */
export const BASE_PORT_REPROBE_MS = 3_000;
