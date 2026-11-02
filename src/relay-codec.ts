/**
 * Pure in-memory relay pool export/import codec for pi-freeflow
 */

import type { KnownRelay, RelayMode, RelayState } from "./types.ts";
import { ensureRelay, validateRelayUrl } from "./relay-state.ts";

/** Envelope marker identifying a pi-freeflow relay export file. */
export const EXPORT_KIND = "pi-freeflow/relay-export" as const;
/** Current relay export file version. Bump on any envelope breaking change. */
export const EXPORT_VERSION = 1;
/** Default file name used by `/freeflow export` when no path is given. */
export const EXPORT_DEFAULT_FILENAME = "freeflow-relays.json";
/** Hard cap on accepted import file size (1 MiB). */
export const EXPORT_MAX_BYTES = 1_048_576;

/** A parsed relay export file envelope. */
export interface RelayExportArtifact {
 kind: "pi-freeflow/relay-export";
 version: 1;
 exportedAt: string;
 state: {
  mode?: RelayMode;
  enabled: boolean;
  url: string;
  relays: KnownRelay[];
  hideWidget?: boolean;
 };
}

/** One import candidate entry that was skipped instead of aborting the file. */
export interface RelayImportSkipped {
 index: number;
 url: string;
 reason: string;
}

/** RelayState subset carried by an import file (pool scope only). */
export type RelayImportFragment = Pick<
 RelayState,
 "mode" | "enabled" | "url" | "relays" | "hideWidget"
>;

/** Result of planning an import against the current pool. */
export interface RelayImportPlanResult {
 next: RelayState;
 added: number;
 updated: number;
 removed: number;
 skipped: RelayImportSkipped[];
}

/** Alias kept for the cross-slice contract name. */
export type PlanResult = RelayImportPlanResult;

/**
 * Build an export artifact from live relay state. Passwords are stripped by
 * default (the key is absent, not null); pass `{ includeSecrets: true }` to
 * carry them verbatim.
 */
export function buildRelayExport(
 state: RelayState,
 opts?: { includeSecrets?: boolean },
): RelayExportArtifact {
 const includeSecrets = opts?.includeSecrets === true;
 return {
  kind: EXPORT_KIND,
  version: EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  state: {
   mode: state.mode,
   enabled: state.enabled,
   url: state.url,
   relays: state.relays.map((r) => {
    const out: KnownRelay = { url: r.url };
    if (r.label !== undefined) out.label = r.label;
    if (r.addedAt !== undefined) out.addedAt = r.addedAt;
    if (
     includeSecrets &&
     typeof r.auth === "string" &&
     r.auth.length > 0
    ) {
     out.auth = r.auth;
    }
    return out;
   }),
   hideWidget: state.hideWidget,
  },
 };
}

/**
 * Parse raw import file text into a relay fragment. Throws on envelope
 * failure (oversize, bad JSON, wrong kind/version, missing pool); per-entry
 * problems fail closed to `skipped` so one bad relay never wipes the pool.
 */
export function parseRelayImport(raw: string): {
 fragment: RelayImportFragment;
 skipped: RelayImportSkipped[];
 warnings: string[];
} {
 if (raw.length > EXPORT_MAX_BYTES) {
  throw new Error(
   `Relay import file too large (${raw.length} bytes, limit ${EXPORT_MAX_BYTES})`,
  );
 }
 let doc: unknown;
 try {
  doc = JSON.parse(raw);
 } catch {
  throw new Error("Relay import file is not valid JSON");
 }
 const envelope =
  typeof doc === "object" && doc !== null
   ? (doc as Record<string, unknown>)
   : null;
 if (envelope?.kind !== EXPORT_KIND) {
  throw new Error("File is not a relay export (bad kind marker)");
 }
 if (
  typeof envelope.version !== "number" ||
  !Number.isInteger(envelope.version) ||
  envelope.version !== EXPORT_VERSION
 ) {
  throw new Error(
   `Unsupported relay export version (${String(envelope.version)}); this build reads version ${EXPORT_VERSION}`,
  );
 }
 const rawState =
  typeof envelope.state === "object" && envelope.state !== null
   ? (envelope.state as Record<string, unknown>)
   : null;
 if (!rawState || !Array.isArray(rawState.relays)) {
  throw new Error("File is not a relay export (state pool is missing)");
 }

 const warnings: string[] = [];
 const skipped: RelayImportSkipped[] = [];

 const rawMode = rawState.mode;
 const mode: RelayMode =
  rawMode === "on" || rawMode === "off" || rawMode === "auto" || rawMode === "spread"
   ? rawMode
   : "auto";
 if (rawMode !== "on" && rawMode !== "off" && rawMode !== "auto" && rawMode !== "spread") {
  warnings.push("Unknown relay mode in file; using automatic mode.");
 }

 const rawEnabled = rawState.enabled;
 const enabled =
  typeof rawEnabled === "boolean"
   ? rawEnabled
   : mode === "on"
    ? true
    : mode === "off"
     ? false
     : (rawState.relays as unknown[]).length > 0;

 const rawUrl = rawState.url;
 let url = "";
 if (typeof rawUrl === "string" && rawUrl.trim()) {
  const trimmed = rawUrl.trim();
  if (validateRelayUrl(trimmed).ok) {
   url = trimmed;
  } else {
   warnings.push("Active relay address in file is not usable; ignoring it.");
  }
 }

 const hideWidget = rawState.hideWidget === true;
 const relays: KnownRelay[] = [];
 const seen = new Set<string>();
 const entries = rawState.relays as unknown[];
 for (let index = 0; index < entries.length; index++) {
  const entry = entries[index];
  if (typeof entry !== "object" || entry === null) {
   skipped.push({ index, url: "", reason: "entry is not an object" });
   continue;
  }
  const record = entry as Record<string, unknown>;
  const trimmedUrl =
   typeof record.url === "string" ? record.url.trim() : "";
  if (!trimmedUrl) {
   skipped.push({ index, url: "", reason: "missing relay address" });
   continue;
  }
  const check = validateRelayUrl(trimmedUrl);
  if (!check.ok) {
   skipped.push({ index, url: trimmedUrl, reason: check.reason });
   continue;
  }
  // Exact trimmed-address dedupe (first wins), mirroring ensureRelay.
  if (seen.has(trimmedUrl)) {
   skipped.push({ index, url: trimmedUrl, reason: "duplicate relay address" });
   continue;
  }
  seen.add(trimmedUrl);
  const candidate: KnownRelay = { url: trimmedUrl };
  if (typeof record.label === "string") {
   const cleanLabel = record.label.trim();
   if (cleanLabel && cleanLabel !== "manual") {
    if (cleanLabel.length > 64) {
     candidate.label = cleanLabel.slice(0, 64);
     warnings.push(
      `Short name for ${trimmedUrl} truncated to 64 characters.`,
     );
    } else {
     candidate.label = cleanLabel;
    }
   }
  }
  if (
   typeof record.addedAt === "string" &&
   Number.isNaN(Date.parse(record.addedAt)) === false
  ) {
   candidate.addedAt = record.addedAt;
  }
  if (
   typeof record.auth === "string" &&
   record.auth.length > 0
  ) {
   candidate.auth = record.auth;
  } else if (record.auth !== undefined) {
   warnings.push(`Password for ${trimmedUrl} is not usable; ignoring it.`);
  }
  relays.push(candidate);
 }

 return {
  fragment: { mode, enabled, url, relays, hideWidget },
  skipped,
  warnings,
 };
}

function copyRelayEntry(r: KnownRelay): KnownRelay {
 const out: KnownRelay = { url: r.url };
 if (r.label !== undefined) out.label = r.label;
 if (r.addedAt !== undefined) out.addedAt = r.addedAt;
 if (r.auth !== undefined) out.auth = r.auth;
 return out;
}

/**
 * Plan an import against the current pool without touching disk or prompting.
 * Merge folds the file pool into the current one via ensureRelay semantics and
 * keeps the current mode/switch/widget; replace installs the file pool fresh.
 */
export function planRelayImport(
 current: RelayState,
 fragment: RelayImportFragment,
 opts: { mode: "merge" | "replace" },
): RelayImportPlanResult {
 if (opts.mode === "replace") {
  const installed: KnownRelay[] = [];
  const seen = new Set<string>();
  const skipped: RelayImportSkipped[] = [];
  const source = fragment.relays ?? [];
  for (let index = 0; index < source.length; index++) {
   const entry = source[index];
   const trimmedUrl =
    typeof entry?.url === "string" ? entry.url.trim() : "";
   if (!trimmedUrl || !validateRelayUrl(trimmedUrl).ok) {
    skipped.push({
     index,
     url: trimmedUrl,
     reason: "relay address is not usable",
    });
    continue;
   }
   if (seen.has(trimmedUrl)) {
    skipped.push({
     index,
     url: trimmedUrl,
     reason: "duplicate relay address",
    });
    continue;
   }
   seen.add(trimmedUrl);
   installed.push(copyRelayEntry({ ...entry, url: trimmedUrl }));
  }
  // Empty file pool installs nothing: fail closed here (not just in the
  // command handler) so no caller can turn zero usable addresses into a wipe.
  if (installed.length === 0) {
   return {
    next: { ...current, relays: current.relays.map(copyRelayEntry) },
    added: 0,
    updated: 0,
    removed: 0,
    skipped,
   };
  }
  const installedUrls = new Set(installed.map((r) => r.url));
  const active =
   fragment.url && installedUrls.has(fragment.url)
    ? fragment.url
    : (installed[0]?.url ?? "");
  return {
   next: {
    mode: fragment.mode ?? "auto",
    enabled: fragment.enabled,
    url: active,
    relays: installed,
    hideWidget: fragment.hideWidget === true,
   },
   added: installed.length,
   updated: 0,
   removed: Math.max(0, current.relays.length - installed.length),
   skipped,
  };
 }

 const next: RelayState = {
  ...current,
  relays: current.relays.map(copyRelayEntry),
 };
 let added = 0;
 let updated = 0;
 const skipped: RelayImportSkipped[] = [];
 const source = fragment.relays ?? [];
 for (let index = 0; index < source.length; index++) {
  const entry = source[index];
  const trimmedUrl =
   typeof entry?.url === "string" ? entry.url.trim() : "";
  if (!trimmedUrl) {
   skipped.push({ index, url: "", reason: "missing relay address" });
   continue;
  }
  let relay: KnownRelay | undefined;
  try {
   const already = next.relays.some((r) => r.url === trimmedUrl);
   relay = ensureRelay(next, trimmedUrl, entry.label);
   if (already) {
    updated += 1;
   } else {
    added += 1;
   }
  } catch (err) {
   skipped.push({
    index,
    url: trimmedUrl,
    reason: err instanceof Error ? err.message : "relay address rejected",
   });
   continue;
  }
  // File password overwrites; an absent file password keeps the stored one.
  if (typeof entry.auth === "string" && entry.auth.length > 0) {
   relay.auth = entry.auth;
  }
  if (
   typeof entry.addedAt === "string" &&
   Number.isNaN(Date.parse(entry.addedAt)) === false
  ) {
   relay.addedAt = entry.addedAt;
  }
 }
 const mergedUrls = new Set(next.relays.map((r) => r.url));
 if (!mergedUrls.has(next.url)) {
  next.url =
   fragment.url && mergedUrls.has(fragment.url)
    ? fragment.url
    : (next.relays[0]?.url ?? "");
 }
 return { next, added, updated, removed: 0, skipped };
}
