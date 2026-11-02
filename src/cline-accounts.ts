/**
 * Per-user Cline API key pool and version coordination for pi-freeflow.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import type { FetchImpl } from "./cline-device-auth.ts";
import { refreshClineToken, toApiKey } from "./cline-device-auth.ts";
import { fetchWithSystemCA } from "./system-ca-fetch.ts";
import {
 CLINE_POOL_FILE,
 loadPool,
} from "./cline-pool.ts";
import {
 isClineTokenStale,
 refreshAccountInPlace,
 type ClineRefresher,
 type ClineRefreshResult,
} from "./cline-roll.ts";

/** Bundled fallback version if dynamic fetch and disk cache are absent. */
export const BUNDLED_CLINE_VERSION = "4.1.25";

const CLINE_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
let liveClineVersion: string | null = null;

function clineVersionCachePath(): string {
 return path.join(path.dirname(CLINE_POOL_FILE), "pi-freeflow-cline-version.json");
}

export function _resetLiveClineVersionForTest(): void {
 liveClineVersion = null;
}

/**
 * Resolve effective Cline client version. Precedence:
 * env override (PI_FREEFLOW_CLINE_VERSION) > in-memory version > fresh disk cache > BUNDLED_CLINE_VERSION.
 */
export function getClineVersion(): string {
 const override = process.env.PI_FREEFLOW_CLINE_VERSION?.trim();
 if (override) return override;
 if (liveClineVersion) return liveClineVersion;
 try {
  const cachePath = clineVersionCachePath();
  if (fs.existsSync(cachePath)) {
   const data = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { version?: string; checkedAt?: number };
   if (typeof data.version === "string" && data.version.trim() && typeof data.checkedAt === "number" && Date.now() - data.checkedAt < CLINE_VERSION_TTL_MS) {
    liveClineVersion = data.version.trim();
    return liveClineVersion;
   }
  }
 } catch { }
 return BUNDLED_CLINE_VERSION;
}

/**
 * Client headers the Cline API expects, evaluated dynamically with the current version.
 */
export function getClineClientHeaders(): Record<string, string> {
 const ver = getClineVersion();
 return {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
  "X-IS-MULTIROOT": "false",
  "X-CLIENT-TYPE": "cline-desktop",
  "X-CLIENT-VERSION": ver,
  "User-Agent": `Cline/${ver}`,
 };
}

/**
 * Proxy object for CLINE_CLIENT_HEADERS providing full backward compatibility.
 */
export const CLINE_CLIENT_HEADERS: Record<string, string> = new Proxy({} as Record<string, string>, {
 get(_target, prop) {
  return getClineClientHeaders()[prop as string];
 },
 has(_target, prop) {
  return prop in getClineClientHeaders();
 },
 ownKeys(_target) {
  return Object.keys(getClineClientHeaders());
 },
 getOwnPropertyDescriptor(_target, prop) {
  const val = getClineClientHeaders()[prop as string];
  return val !== undefined ? { value: val, writable: false, enumerable: true, configurable: true } : undefined;
 },
});

const CLINE_SEMVER_RE = /^\d+\.\d+\.\d+/;

/**
 * Refresh the live Cline version from open-vsx or GitHub releases and persist to disk.
 */
export async function refreshClineVersion(fetchImpl: FetchImpl = fetchWithSystemCA): Promise<string> {
 try {
  const res = await fetchImpl("https://open-vsx.org/api/saoudrizwan/claude-dev", {
   headers: { "User-Agent": "pi-freeflow" },
   signal: AbortSignal.timeout(5000),
  });
  if (res.ok) {
   const data = (await res.json()) as { version?: string };
   if (typeof data.version === "string" && CLINE_SEMVER_RE.test(data.version)) {
    liveClineVersion = data.version.trim();
    try {
     const cachePath = clineVersionCachePath();
     writeFileAtomic(cachePath, JSON.stringify({ version: liveClineVersion, checkedAt: Date.now() }));
    } catch { }
    return liveClineVersion;
   }
  }
 } catch { }
 return getClineVersion();
}

async function defaultClineRefresher(refreshToken: string): Promise<ClineRefreshResult | null> {
 try {
  const creds = await refreshClineToken(undefined, refreshToken);
  return { token: toApiKey(creds.access), refreshToken: creds.refresh, expiresAt: creds.expires };
 } catch {
  return null;
 }
}

/**
 * Background auto-probing & keep-alive for Cline account tokens.
 * Proactively refreshes tokens nearing expiry (<30 min remaining or expired)
 * so that saved accounts never lapse into unrecoverable dead grants.
 * Also performs a lightweight ping to verify the account is active.
 */
export async function keepClineTokensAlive(
 opts: {
  fetchImpl?: FetchImpl;
  refreshImpl?: ClineRefresher;
 } = {},
): Promise<{ refreshed: number; probed: number }> {
 const pool = loadPool();
 if (pool.accounts.length === 0) return { refreshed: 0, probed: 0 };
 const fetchImpl = opts.fetchImpl ?? fetchWithSystemCA;
 const refreshImpl = opts.refreshImpl ?? defaultClineRefresher;
 const now = Date.now();
 const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;
 let refreshed = 0;
 let probed = 0;

 for (const account of pool.accounts) {
  if (!account.refreshToken) continue;
  const isExpiringSoon = typeof account.expiresAt === "number" && (account.expiresAt - now < REFRESH_THRESHOLD_MS);
  const isExpired = typeof account.expiresAt === "number" && account.expiresAt <= now;
  const needsRefresh = isExpiringSoon || isExpired || isClineTokenStale(account);

  if (needsRefresh) {
   try {
    const outcome = await refreshAccountInPlace(account, refreshImpl);
    if (outcome === true) {
     refreshed += 1;
    }
   } catch {
    continue;
   }
  }

  // Light probe: ping models endpoint with light timeout to keep the session warm
  try {
   const token = account.token;
   const probeRes = await fetchImpl("https://api.cline.bot/api/v1/models", {
    method: "GET",
    headers: {
     ...getClineClientHeaders(),
     authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(6000),
   });
   if (probeRes.ok) {
    probed += 1;
   }
  } catch { }
 }

 return { refreshed, probed };
}

// ── Re-exports from split modules for complete backward compatibility ─
export * from "./cline-pool.ts";
export * from "./cline-roll.ts";
