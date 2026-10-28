import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_CACHE_FILE, UPDATE_CHECK_TTL_MS } from "./config.ts";
import { logInfo } from "./logger.ts";
import { logWarn } from "./logger.ts";
import { getActiveRelayState, getStatusUi } from "./relay-state.ts";
import type { ExtensionUIContext } from "./types.ts";
import { SEMVER_PATTERN, compareVersions, fetchLatestVersion, getLocalVersion } from "./update-core.ts";
import { performAutoUpdate } from "./updater.ts";

interface UpdateCacheData {
 latest: string;
 checkedAt: number;
}

/**
 * Detect a LINK install. A linked dev checkout must never be replaced by the
 * registry build, so both shapes `omp plugin link` produces are checked:
 *
 *  - the package ROOT is a symlink (verified on this machine:
 *    ~/.omp/plugins/node_modules/pi-freeflow -> the checkout), in which case
 *    every file below it — including extensions/index.ts — is a regular file;
 *  - the published extension entry itself is a symlink.
 *
 * `packageRoot` is for tests; production derives it from this module's path.
 */
export function isLinkedInstall(packageRoot?: string): boolean {
 try {
  const root =
   packageRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  // lstat (never stat): a link is what we are looking for, not its target.
  if (lstatSync(root).isSymbolicLink()) return true;
  const entry = path.join(root, "extensions", "index.ts");
  return lstatSync(entry).isSymbolicLink();
 } catch {
  return false;
 }
}

export function getCachedUpdate(): UpdateCacheData | null {
 try {
  if (!existsSync(UPDATE_CACHE_FILE)) return null;
  const raw = readFileSync(UPDATE_CACHE_FILE, "utf8");
  const data = JSON.parse(raw) as UpdateCacheData;
  if (!data || typeof data.latest !== "string" || typeof data.checkedAt !== "number") {
   return null;
  }
  return data;
 } catch {
  return null;
 }
}

export function setCachedUpdate(latest: string): void {
 if (!SEMVER_PATTERN.test(latest)) {
  logWarn(`ignoring invalid latest version for cache: ${latest}`);
  return;
 }
 try {
  const dir = path.dirname(UPDATE_CACHE_FILE);
  mkdirSync(dir, { recursive: true });
  const data: UpdateCacheData = { latest, checkedAt: Date.now() };
  writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
 } catch {
  // swallow — cache is best-effort
 }
}

export function checkForUpdateInBackground(ui?: ExtensionUIContext | null): void {
 try {
  if (isLinkedInstall()) return;

  const cached = getCachedUpdate();
  if (
   cached &&
   typeof cached.checkedAt === "number" &&
   Date.now() - cached.checkedAt < UPDATE_CHECK_TTL_MS
  ) {
   return;
  }

  void fetchLatestVersion()
   .then((latest) => {
    if (!latest) return;
    try {
     setCachedUpdate(latest);
    } catch {
     // swallow
    }
    try {
     const local = getLocalVersion();
     if (local && compareVersions(latest, local) > 0) {
      logInfo(`pi-freeflow update available: ${local} -> ${latest}`);
      if (getActiveRelayState().autoUpdate) {
       void performAutoUpdate((msg) => {
        logInfo(msg);
        const targetUi = ui ?? getStatusUi();
        if (targetUi?.notify) targetUi.notify(msg, "info");
       });
       return;
      }
      try {
       if (getActiveRelayState().hideWidget) return;
      } catch {}
      const targetUi = ui ?? null;
      if (targetUi?.setStatus) {
       try { targetUi.setStatus("freeflow", `update: ${local} → ${latest}`); } catch {}
      } else {
       try {
        const fallback = getStatusUi();
        if (fallback?.setStatus) fallback.setStatus("freeflow", `update: ${local} → ${latest}`);
       } catch {}
      }
     }
    } catch {
     // swallow
    }
   })
   .catch(() => {
    // swallow — offline / transient network error
   });
 } catch {
  // swallow — never throw from background check
 }
}
