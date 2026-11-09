/**
 * Watchdog recovery, backoff, and circuit-breaker logic for pi-freeflow daemon.
 *
 * Implements exponential backoff, stuck-busy heuristics, and automatic
 * circuit-breaker halting when repeated recovery attempts fail.
 */

import {
 BREAKER_FAILURES,
 BREAKER_HALT_MS,
 BREAKER_WINDOW_MS,
 BUSY_BYPASS_CONTINUOUS_MS,
 BUSY_BYPASS_QUIET_MS,
 PKG_VERSION,
 RECOVERY_BACKOFF_BASE_MS,
 RECOVERY_BACKOFF_CAP_MS,
} from "./config.ts";
import type { DaemonHealthSnapshot } from "./health.ts";
import { logInfo, logWarn } from "./logger.ts";
import { compareVersions } from "./update-core.ts";

/** First tick (Date.now()) the daemon has looked continuously busy; 0 = idle. */
let busySince = 0;
/** Consecutive recovery attempts (backoff exponent n). Reset on healthy watchdog tick. */
let backoffAttempt = 0;
/** Timestamps of recent recovery failures (breaker window). */
let recoveryFailures: number[] = [];
/** Watchdog respawns halted until this time (breaker open). */
let breakerOpenUntil = 0;

/**
 * Respawn backoff: min(2s * 2^n, 60s) + jitter. n is the consecutive-failure
 * count; pass jitterMs = 0 in tests for a deterministic base.
 */
export function computeRecoveryBackoffMs(attempt: number, jitterMs = Math.random() * 500): number {
 const n = Math.max(0, Math.floor(attempt));
 const base = Math.min(RECOVERY_BACKOFF_BASE_MS * 2 ** n, RECOVERY_BACKOFF_CAP_MS);
 return base + Math.max(0, jitterMs);
}

/**
 * Stuck-busy check (pure, testable): a busy daemon may only be replaced after
 * 5min of continuous busy AND zero forwarded stream bytes for 60s+. Anything
 * else must be left untouched mid-request.
 */
export function isStuckBusy(busySinceMs: number, lastBytesAt: number, now = Date.now()): boolean {
 if (!busySinceMs) return false;
 if (now - busySinceMs < BUSY_BYPASS_CONTINUOUS_MS) return false;
 if (lastBytesAt && now - lastBytesAt < BUSY_BYPASS_QUIET_MS) return false;
 return true;
}

/** Track the busy/idle edge from a health snapshot; returns the updated busySince. */
export function trackBusyEdge(activeRequests: number, lastBytesAt: number, now = Date.now()): number {
 if (activeRequests > 0) {
  if (!busySince) busySince = now;
 } else {
  busySince = 0;
 }
 return busySince;
}

export function getBusySince(): number {
 return busySince;
}

export function resetBusySince(): void {
 busySince = 0;
}

/** True while the breaker halt is in effect (respawns paused, fallback serves). */
export function isBreakerHalted(now = Date.now()): boolean {
 return now < breakerOpenUntil;
}

/** Record a recovery failure; opens the breaker after 5 straight failures in 5min. */
export function recordRecoveryFailure(now = Date.now()): boolean {
 recoveryFailures.push(now);
 recoveryFailures = recoveryFailures.filter((t) => now - t <= BREAKER_WINDOW_MS);
 backoffAttempt += 1;
 if (recoveryFailures.length >= BREAKER_FAILURES) {
  breakerOpenUntil = now + BREAKER_HALT_MS;
  logWarn("recovery breaker open — 5 straight failures in 5min, halting respawn for 10min (in-process fallback meanwhile)");
  return true;
 }
 return false;
}

/** Record a healthy watchdog tick: clears the straight-failure run and backoff. */
export function recordRecoverySuccess(): void {
 recoveryFailures = [];
 backoffAttempt = 0;
 breakerOpenUntil = 0;
}

/** Test seam: snapshot of the recovery counters. */
export function _getRecoveryStateForTest(): {
 backoffAttempt: number;
 failures: number[];
 breakerOpenUntil: number;
 busySince: number;
} {
 return { backoffAttempt, failures: [...recoveryFailures], breakerOpenUntil, busySince };
}

/** Test seam: reset recovery counters without touching timers. */
export function _resetRecoveryForTest(): void {
 backoffAttempt = 0;
 recoveryFailures = [];
 breakerOpenUntil = 0;
 busySince = 0;
}

/** Recovery-decision shape; canonical definition lives in health.ts. */
export type HealthForRecovery = DaemonHealthSnapshot;

/**
 * Older-version guard: only a daemon strictly older than this build is worth
 * recovering. shouldReplaceDaemon deliberately leaves a NEWER daemon running,
 * so recovering from one could never succeed (watchdog → recover → refused →
 * reattach → watchdog, until the breaker parks into the in-process fallback).
 * Null/undefined version (pre-version daemon) is not older on its own.
 */
export function isOlderDaemonVersion(version: string | null | undefined): boolean {
 return version != null && compareVersions(version, PKG_VERSION) < 0;
}

/**
 * Watchdog decision matrix (pure, testable). Recover when the daemon is gone,
 * serves an older version, or reports a degraded failed-SSE window. Missing
 * sseDegraded (pre-window daemon) never triggers on its own.
 */
export function shouldRecoverOnHealth(health: HealthForRecovery): boolean {
 if (health === null) return true;
 if (isOlderDaemonVersion(health.version)) return true;
 if (health.sseDegraded === true) return true;
 return false;
}

export interface RecoveryDeps {
 readonly isEnsuring: () => boolean;
 readonly setEnsuring: (val: boolean) => void;
 readonly ensureInProcessFallback: () => Promise<number>;
 readonly stopHeartbeatInternal: () => void;
 readonly resetHeartbeatPort: () => void;
 readonly attachTo: (port: number) => Promise<void>;
 readonly killStaleDaemon: (port: number, ver: string, what: string) => Promise<boolean>;
 readonly ensureDaemon: () => Promise<number>;
 readonly getDaemonHealth?: (port: number) => Promise<DaemonHealthSnapshot>;
}

export async function triggerRecovery(port: number, why: string, deps: RecoveryDeps): Promise<void> {
 if (deps.isEnsuring()) return;
 deps.setEnsuring(true);
 try {
  const now = Date.now();
  if (isBreakerHalted(now)) {
   logWarn(`recovery breaker halted — serving in-process fallback meanwhile (${why})`);
   void deps.ensureInProcessFallback();
   return;
  }
  const opened = recordRecoveryFailure(now);
  if (opened) {
   void deps.ensureInProcessFallback();
   return;
  }
  const delay = computeRecoveryBackoffMs(backoffAttempt - 1);
  logWarn(`watchdog recovery (${why}) — backing off ${Math.round(delay)}ms before respawn`);
  deps.stopHeartbeatInternal();
  deps.resetHeartbeatPort();
  const { promise: backoffDone, resolve: resolveBackoff } = Promise.withResolvers<void>();
  const backoffTimer = setTimeout(resolveBackoff, delay);
  try { backoffTimer.unref(); } catch { }
  await backoffDone;
  try {
   const health = deps.getDaemonHealth ? await deps.getDaemonHealth(port) : null;
   if (health && (health.activeRequests ?? 0) > 0) {
    trackBusyEdge(health.activeRequests ?? 0, health.lastBytesAt ?? 0, Date.now());
    if (!isStuckBusy(busySince, health.lastBytesAt ?? 0, Date.now())) {
     logInfo(`watchdog recovery deferred — daemon busy (${health.activeRequests} active, waiting for 5min-stuck + 60s-quiet)`);
     await deps.attachTo(port);
     return;
    }
   }
   const ver = health?.version ?? PKG_VERSION;
   await deps.killStaleDaemon(port, ver, "proxy daemon");
  } catch (e) {
   logWarn("watchdog pre-respawn probe failed", { error: String(e) });
  }
  // Release before delegating: ensureDaemon owns the flag from here (it
  // early-returns while ensuring is true). The handoff is synchronous up
  // to ensureDaemon's own ensuring=true, so no tick slips between.
  deps.setEnsuring(false);
  await deps.ensureDaemon();
 } finally {
  deps.setEnsuring(false);
 }
}

/**
 * 5s watchdog tick: polls /_health for version + failed-SSE rate and drives
 * stopHeartbeat → busy-ruled kill → ensureDaemon when the daemon is stale or
 * degraded. Healthy ticks reset backoff/breaker and track the busy edge.
 */
export async function watchdogCheck(port: number, deps: RecoveryDeps): Promise<void> {
 if (deps.isEnsuring()) return;
 if (isBreakerHalted()) return;
 if (!deps.getDaemonHealth) return;
 let health: DaemonHealthSnapshot;
 try {
  health = await deps.getDaemonHealth(port);
 } catch {
  return;
 }
 if (health === null) {
  await new Promise<void>((r) => setTimeout(r, 200));
  try {
   health = await deps.getDaemonHealth(port);
  } catch {
   return;
  }
 }
 if (health && (health.activeRequests ?? 0) > 0) {
  trackBusyEdge(health.activeRequests ?? 0, health.lastBytesAt ?? 0);
 } else {
  trackBusyEdge(0, 0);
 }
 if (!shouldRecoverOnHealth(health)) {
  recordRecoverySuccess();
  return;
 }
 if (health && (health.activeRequests ?? 0) > 0 && !isStuckBusy(busySince, health.lastBytesAt ?? 0)) return;
 void triggerRecovery(
  port,
  health === null ? "daemon gone" : isOlderDaemonVersion(health.version) ? `stale v${health.version}` : "failed-SSE degraded",
  deps,
 ).catch((e) => logWarn("watchdog recovery failed", { error: String(e) }));
}
