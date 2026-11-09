/**
 * Interactive CLI slash command handlers and UI workflows for relay pool management.
 */

import fs from "node:fs";
import path from "node:path";
import type { DeployPlatform } from "./deploy.ts";
import {
 buildRelayExport,
 EXPORT_DEFAULT_FILENAME,
 EXPORT_MAX_BYTES,
 parseRelayImport,
 planRelayImport,
 type RelayImportFragment,
} from "./relay-codec.ts";
import {
 ensureRelay,
 ewmaBadge,
 findRelay,
 formatRelayFlash,
 formatRelayPickerItem,
 getActiveRelayState,
 getRelayHealth,
 loadRelayState,
 removeRelay,
 setRelayLabel,
 setStatusUi,
 shortRelayLabel,
 withRelayState,
} from "./relay-state.ts";
import type { ExtensionContext, ExtensionUIContext, KnownRelay, RelayState } from "./types.ts";

export interface RelayCommandDeps {
 readonly rest: string;
 readonly updateStatusBar?: (ui?: ExtensionUIContext) => void;
 readonly doDeploy?: (platform: DeployPlatform) => Promise<void>;
}

export function classifyImportFailure(filePath: string, raw: string): string {
 let parsed: unknown = null;
 try {
  parsed = JSON.parse(raw);
 } catch (e) {
  return `Relay file ${filePath} is not valid JSON (${(e as Error).message}). Nothing changed.`;
 }
 const version = parsed !== null && typeof parsed === "object" && "version" in parsed
  ? (parsed as Record<string, unknown>).version
  : undefined;
 if (typeof version !== "undefined" && version !== 1) {
  return `Relay file ${filePath} uses version ${String(version)}, this version understands version 1. Update then try again. Nothing changed.`;
 }
 return `Relay file ${filePath} is not a relay export (missing relay list). Nothing changed.`;
}

interface RelayActionContext {
 applyRelayState: (updater: (s: RelayState) => RelayState) => RelayState;
 persist: () => void;
 flash: () => void;
 getRelayState: () => RelayState;
}

export async function addRelayInteractive(ctx: ExtensionContext, act: RelayActionContext): Promise<void> {
 const relayState = act.getRelayState();
 const inputUrl = (
  await ctx.ui.input(
   "Custom relay URL (e.g. https://my-relay.workers.dev):",
   "",
  )
 )?.trim();
 if (!inputUrl) {
  ctx.ui.notify("Cancelled — no URL provided", "warning");
  return;
 }
 const defaultLabel = shortRelayLabel(inputUrl, relayState.relays);
 const inputLabel = (
  await ctx.ui.input(
   "Short name / alias for TUI (e.g. cf-sg, vercel-1):",
   defaultLabel,
  )
 )?.trim() || defaultLabel;

 try {
  act.applyRelayState((s) => {
   const added = ensureRelay(s, inputUrl, inputLabel);
   s.enabled = true;
   s.url = added.url;
   return s;
  });
 } catch (e) {
  ctx.ui.notify((e as Error).message, "warning");
  return;
 }
 act.persist();
 act.flash();
 const fresh = act.getRelayState();
 ctx.ui.notify(
  `✓ Added & activated relay [${shortRelayLabel(fresh.url, fresh.relays)}]: ${fresh.url}`,
  "info",
 );
}

export async function editRelayLabelMenu(ctx: ExtensionContext, act: RelayActionContext): Promise<void> {
 const relayState = act.getRelayState();
 if (!relayState.relays.length) {
  ctx.ui.notify("No saved relays to rename", "warning");
  return;
 }
 const fmt = (r: KnownRelay, idx: number): string =>
  `[${idx + 1}] ${r.label ? `[${r.label}] ` : ""}${r.url}`;
 const opts = relayState.relays.map(fmt);
 const choice = await ctx.ui.select("Select relay to rename / set short name", opts);
 if (!choice) return;
 const match = relayState.relays.find((r, idx) => fmt(r, idx) === choice);
 if (!match) return;

 const curLabel = match.label || shortRelayLabel(match.url, relayState.relays);
 const newLabel = (
  await ctx.ui.input(
   `New short name for ${match.url}:`,
   curLabel,
  )
 )?.trim();
 if (!newLabel) {
  ctx.ui.notify("Cancelled — short name not changed", "warning");
  return;
 }
 act.applyRelayState((s) => {
  setRelayLabel(s, match.url, newLabel);
  return s;
 });
 act.persist();
 act.flash();
 ctx.ui.notify(
  `✓ Relay short name updated to [${newLabel}] for ${match.url}`,
  "info",
 );
}

export async function switchRelay(ctx: ExtensionContext, act: RelayActionContext): Promise<void> {
 const relayState = act.getRelayState();
 if (!relayState.relays.length) {
  ctx.ui.notify("No saved relays yet", "warning");
  return;
 }
 const fmt = (r: KnownRelay, idx: number): string => formatRelayPickerItem(r, idx, relayState.url);
 const opts = relayState.relays.map(fmt);
 const choice = await ctx.ui.select("Switch active relay", opts);
 if (!choice) return;
 const match = relayState.relays.find((r, idx) => fmt(r, idx) === choice);
 if (!match) return;
 act.applyRelayState((s) => {
  const fresh = s.relays.find((r) => r.url === match.url);
  if (!fresh) return s;
  s.enabled = true;
  s.url = fresh.url;
  return s;
 });
 act.persist();
 act.flash();
}

export function showList(ctx: ExtensionContext, getRelayState: () => RelayState): void {
 const relayState = getRelayState();
 if (!relayState.relays.length) {
  ctx.ui.notify("No saved relays (direct upstream mode)", "info");
  return;
 }
 const isDeadParked = (url: string): boolean => {
  const h = getRelayHealth(url);
  return h != null && h.lastStatus === 402 && Date.now() < h.cooldownUntil;
 };
 const lines = relayState.relays.map((r, idx) => {
  const star = r.url === relayState.url ? "★" : " ";
  const shortName = r.label ? `[${r.label}]` : `[${shortRelayLabel(r.url, relayState.relays)}]`;
  const paddedName = shortName.padEnd(16, " ");
  const health = getRelayHealth(r.url);
  const isCooling = health && Date.now() < health.cooldownUntil;
  const remainingSec = isCooling ? Math.ceil((health.cooldownUntil - Date.now()) / 1000) : 0;
  const healthBadge = isDeadParked(r.url)
   ? ` ✖ [dead — HTTP 402 disabled deployment, parked ${remainingSec}s]`
   : isCooling
    ? ` ⚠️ [cooling ${remainingSec}s: ${health.lastStatus ? `HTTP ${health.lastStatus}` : "error"}]`
    : health?.lastLatencyMs != null && Number.isFinite(health.lastLatencyMs)
     ? ` ✓ [${health.lastLatencyMs}ms]${ewmaBadge(health)}`
     : " ✓";
  const counterText = health && (health.successCount != null || health.failureCount != null)
   ? ` ${health.successCount ?? 0} ok / ${health.failureCount ?? 0} fail`
   : "";
  return `${star} [${idx + 1}] ${paddedName} → ${r.url}${healthBadge}${counterText}`;
 });
 const activeLabel = shortRelayLabel(relayState.url, relayState.relays);
 const activeIdx = Math.max(
  1,
  relayState.relays.findIndex((r) => r.url === relayState.url) + 1,
 );
 const modeStr = (relayState.mode || "auto").toUpperCase();
 const header = `Saved Relays (${relayState.relays.length}):\n${lines.join("\n")}\n\nActive: [${activeIdx}] ${activeLabel} | Mode: ${modeStr} (${relayState.enabled ? "ON" : "OFF"})`;
 ctx.ui.notify(header, "info");
}

export async function removeRelayMenu(ctx: ExtensionContext, act: Pick<RelayActionContext, "applyRelayState" | "persist" | "getRelayState">): Promise<void> {
 const relayState = act.getRelayState();
 const removable = relayState.relays.filter(
  (r) => relayState.relays.length === 1 || r.url !== relayState.url,
 );
 if (!removable.length) {
  ctx.ui.notify(
   "Nothing to remove — the active relay cannot be removed (switch first)",
   "warning",
  );
  return;
 }
 const fmt = (r: KnownRelay, idx: number): string => formatRelayPickerItem(r, idx);
 const choice = await ctx.ui.select(
  "Remove relay",
  removable.map(fmt),
 );
 if (!choice) return;
 const match = removable.find((r, idx) => fmt(r, idx) === choice);
 if (!match) return;
 act.applyRelayState((s) => {
  removeRelay(s, match.url);
  return s;
 });
 act.persist();
 ctx.ui.notify(`Removed: [${shortRelayLabel(match.url, relayState.relays)}] ${match.url}`, "info");
}

export async function runExport(
 ctx: ExtensionContext,
 pathArg: string | undefined,
 includeSecrets: boolean,
 act: { flash: () => void; updateStatusBar?: (ui?: ExtensionUIContext) => void },
): Promise<void> {
 let state: RelayState;
 try {
  state = getActiveRelayState();
 } catch {
  state = loadRelayState();
 }
 const artifact = buildRelayExport(state, { includeSecrets });
 const count = artifact.state.relays.length;
 let target = pathArg ? path.resolve(pathArg) : path.resolve(EXPORT_DEFAULT_FILENAME);
 if (!pathArg) {
  const choice = await ctx.ui.select("Share relays (export file)", [
   `Export to ${target}`,
   "Choose another path…",
   "Cancel",
  ]);
  if (!choice || choice === "Cancel") return;
  if (choice === "Choose another path…") {
   const picked = (await ctx.ui.input("Export path:", target))?.trim();
   if (!picked) return;
   target = path.resolve(picked);
  }
 }
 if (fs.existsSync(target)) {
  if (typeof ctx.ui.confirm === "function") {
   const ok = await ctx.ui.confirm(
    "Export relays",
    `File already exists: ${target}\nOverwrite it?`,
   );
   if (!ok) {
    ctx.ui.notify("Export cancelled — existing file left alone", "warning");
    return;
   }
  }
 }
 try {
  fs.writeFileSync(target, JSON.stringify(artifact, null, 2));
 } catch (e) {
  ctx.ui.notify(`Could not write relay file ${target}: ${(e as Error).message}.`, "error");
  return;
 }
 act.updateStatusBar?.(ctx.ui);
 act.flash();
 ctx.ui.notify(
  includeSecrets
   ? `Exported ${count} relay(s) to ${target} WITH passwords included — keep this file private.`
   : `Exported ${count} relay(s) to ${target} (passwords stripped — file is safe to share).`,
  "info",
 );
}

export async function runImport(
 ctx: ExtensionContext,
 pathArg: string | undefined,
 mode: "merge" | "replace",
 dryRun: boolean,
 act: RelayActionContext,
): Promise<void> {
 const filePath = (pathArg || "").trim();
 if (!filePath) {
  ctx.ui.notify("Usage: /freeflow import <path> [--merge|--replace] [--dry-run] — path is required.", "warning");
  return;
 }
 let byteSize = 0;
 try {
  const st = fs.statSync(filePath);
  if (!st.isFile()) {
   ctx.ui.notify(`Could not read relay file ${filePath}: not a regular file.`, "error");
   return;
  }
  byteSize = st.size;
 } catch (e) {
  const code = e !== null && typeof e === "object" && "code" in e ? (e as Record<string, unknown>).code : undefined;
  if (code === "ENOENT") {
   ctx.ui.notify(`Relay file not found: ${filePath} — check the path and try again.`, "warning");
  } else {
   ctx.ui.notify(`Could not read relay file ${filePath}: ${(e as Error).message}.`, "error");
  }
  return;
 }
 if (byteSize > EXPORT_MAX_BYTES) {
  ctx.ui.notify(`Relay file ${filePath} is too large (${byteSize} bytes; limit ${EXPORT_MAX_BYTES} bytes). Nothing changed.`, "warning");
  return;
 }
 let raw: string;
 try {
  raw = fs.readFileSync(filePath, "utf8");
 } catch (e) {
  ctx.ui.notify(`Could not read relay file ${filePath}: ${(e as Error).message}.`, "error");
  return;
 }
 let fragment: RelayImportFragment;
 let parseSkipped: Array<{ index: number; url: string; reason: string }> = [];
 try {
  const parsed = parseRelayImport(raw);
  fragment = parsed.fragment;
  parseSkipped = parsed.skipped;
 } catch {
  ctx.ui.notify(classifyImportFailure(filePath, raw), "warning");
  return;
 }
 if (!fragment || !Array.isArray(fragment.relays) || fragment.relays.length === 0) {
  if (parseSkipped.length > 0) {
   ctx.ui.notify(`Relay file ${filePath} holds no usable relay addresses (${parseSkipped.length} skipped: ${parseSkipped[0].reason}). Nothing changed.`, "warning");
  } else {
   ctx.ui.notify(`Relay file ${filePath} holds no usable relay addresses (0 skipped). Nothing changed.`, "warning");
  }
  return;
 }
 const plan = planRelayImport(loadRelayState(), fragment, { mode });
 const skipped = [...parseSkipped];
 for (const s of plan.skipped) {
  if (!skipped.some((x) => x.index === s.index && x.url === s.url)) skipped.push(s);
 }
 const skippedCount = skipped.length;
 const reasons = skippedCount > 0
  ? skipped.map((s) => s.reason).filter((r, i, arr) => arr.indexOf(r) === i).join("; ")
  : "none";
 const plannedActive = plan.next.url
  ? `[${shortRelayLabel(plan.next.url, plan.next.relays)}]`
  : "none";
 if (dryRun) {
  if (mode === "replace") {
   ctx.ui.notify(`DRY RUN — replace from ${filePath}: would install ${plan.added}, would remove ${plan.removed}, would skip ${skippedCount} (${reasons}). Active relay would be ${plannedActive}. Nothing changed.`, "info");
  } else {
   ctx.ui.notify(`DRY RUN — merge from ${filePath}: would add ${plan.added}, would update short name on ${plan.updated}, would skip ${skippedCount} (${reasons}). Active and mode unchanged. Nothing changed.`, "info");
  }
  return;
 }
 if (mode === "replace") {
  ctx.ui.notify(`Replace from ${filePath}: will install ${plan.added}, remove ${plan.removed}, skip ${skippedCount} (${reasons}). Active relay will be ${plannedActive}.`, "info");
  if (typeof ctx.ui.confirm === "function") {
   const ok = await ctx.ui.confirm(
    "Replace all relays?",
    `Install ${plan.added} relay(s) from ${filePath} and remove ${plan.removed} existing? This cannot be undone.`,
   );
   if (!ok) {
    ctx.ui.notify("Replace cancelled — relay list unchanged.", "warning");
    return;
   }
  }
 }
 act.applyRelayState((s) => planRelayImport(s, fragment, { mode }).next);
 act.persist();
 act.flash();
 const currentRelayState = act.getRelayState();
 if (mode === "replace") {
  const activeName = currentRelayState.url
   ? `[${shortRelayLabel(currentRelayState.url, currentRelayState.relays)}]`
   : "none";
  ctx.ui.notify(`Replaced relay list from ${filePath}: installed ${plan.added}, skipped ${skippedCount}. Active relay is now ${activeName}.`, "info");
 } else {
  ctx.ui.notify(`Merge from ${filePath}: added ${plan.added}, updated short name on ${plan.updated}, skipped ${skippedCount}. Relay list now holds ${currentRelayState.relays.length}.`, "info");
 }
 const withoutPassword = currentRelayState.relays.filter((r) => !r.auth).length;
 if (withoutPassword > 0) {
  ctx.ui.notify(`${withoutPassword} relay(s) have no password — reconnect each one before use.`, "warning");
 }
 for (const s of skipped) {
  const shown = s.url || `#${s.index + 1}`;
  const reason = s.reason.endsWith(".") ? s.reason : `${s.reason}.`;
  ctx.ui.notify(`Skipped ${shown}: ${reason}`, "warning");
 }
}

export async function showRelayInteractiveMenu(
 ctx: ExtensionContext,
 deps: RelayCommandDeps,
): Promise<void> {
 let relayState = getActiveRelayState();
 const flash = (): void => {
  ctx.ui.notify(formatRelayFlash(relayState), "info");
 };
 const persist = (): void => {
  setStatusUi(ctx.ui);
  deps.updateStatusBar?.(ctx.ui);
 };
 const applyRelayState = (
  updater: (s: RelayState) => RelayState,
 ): RelayState => {
  relayState = withRelayState(updater);
  return relayState;
 };
 const act: RelayActionContext = {
  applyRelayState,
  persist,
  flash,
  getRelayState: () => relayState,
 };

 const currentMode = (relayState.mode || "auto").toUpperCase();
 const activeLabel = shortRelayLabel(relayState.url, relayState.relays);
 const choice = await ctx.ui.select("freeflow relay", [
  `Mode: ${currentMode} (${relayState.enabled ? "ON" : "OFF"}) → ${activeLabel}`,
  "Add custom relay (URL + Short name)…",
  "Switch active relay…",
  "Rename / Set relay short name…",
  "Remove relay…",
  "Share relays (export file)…",
  "Load relays from file (import)…",
  "List saved relays",
  "Deploy Cloudflare relay…",
  "Deploy Deno relay…",
  "Deploy Vercel relay (last resort)…",
  "Mode: AUTO (sticky primary, auto-detect on model select)",
  "Mode: ON (always relay, sticky primary)",
  "Mode: OFF (always direct)",
  "Mode: SPREAD (rotate across healthy relays)",
 ]);
 if (choice === `Mode: ${currentMode} (${relayState.enabled ? "ON" : "OFF"}) → ${activeLabel}`) {
  flash();
 } else if (choice === "Add custom relay (URL + Short name)…") {
  await addRelayInteractive(ctx, act);
 } else if (choice === "Switch active relay…") {
  await switchRelay(ctx, act);
 } else if (choice === "Rename / Set relay short name…") {
  await editRelayLabelMenu(ctx, act);
 } else if (choice === "Remove relay…") {
  await removeRelayMenu(ctx, act);
 } else if (choice === "Share relays (export file)…") {
  await runExport(ctx, undefined, false, { flash, updateStatusBar: deps.updateStatusBar });
 } else if (choice === "Load relays from file (import)…") {
  const picked = (await ctx.ui.input("Relay file path:", EXPORT_DEFAULT_FILENAME))?.trim();
  if (!picked) return;
  await runImport(ctx, picked, "merge", false, act);
 } else if (choice === "List saved relays") {
  showList(ctx, () => relayState);
 } else if (choice === "Deploy Vercel relay (last resort)…") {
  if (deps.doDeploy) await deps.doDeploy("vercel");
 } else if (choice === "Deploy Cloudflare relay…") {
  if (deps.doDeploy) await deps.doDeploy("cloudflare");
 } else if (choice === "Deploy Deno relay…") {
  if (deps.doDeploy) await deps.doDeploy("deno");
 } else if (choice === "Mode: AUTO (sticky primary, auto-detect on model select)") {
  applyRelayState((s) => {
   s.mode = "auto";
   s.enabled = true;
   s.url = s.url || "";
   if (s.url) {
    ensureRelay(s, s.url);
   }
   return s;
  });
  persist();
  flash();
 } else if (choice === "Mode: ON (always relay, sticky primary)") {
  applyRelayState((s) => {
   s.mode = "on";
   s.enabled = true;
   s.url = s.url || "";
   if (s.url) {
    ensureRelay(s, s.url);
   }
   return s;
  });
  persist();
  flash();
 } else if (choice === "Mode: OFF (always direct)") {
  applyRelayState((s) => {
   s.mode = "off";
   s.enabled = false;
   return s;
  });
  persist();
  flash();
 } else if (choice === "Mode: SPREAD (rotate across healthy relays)") {
  applyRelayState((s) => {
   s.mode = "spread";
   s.enabled = true;
   s.url = s.url || "";
   if (s.url) {
    ensureRelay(s, s.url);
   }
   return s;
  });
  persist();
  flash();
 }
}

export async function handleRelaySubcommand(
 sub: string,
 ctx: ExtensionContext,
 deps: RelayCommandDeps,
): Promise<boolean> {
 const rest = deps.rest;
 let relayState = getActiveRelayState();

 const flash = (): void => {
  ctx.ui.notify(formatRelayFlash(relayState), "info");
 };

 const persist = (): void => {
  setStatusUi(ctx.ui);
  deps.updateStatusBar?.(ctx.ui);
 };

 const applyRelayState = (
  updater: (s: RelayState) => RelayState,
 ): RelayState => {
  relayState = withRelayState(updater);
  return relayState;
 };

 const act: RelayActionContext = {
  applyRelayState,
  persist,
  flash,
  getRelayState: () => relayState,
 };

 if (sub === "auto" || sub === "sticky") {
  applyRelayState((s) => {
   s.mode = "auto";
   s.enabled = true;
   s.url = s.url || "";
   if (s.url) {
    ensureRelay(s, s.url);
   }
   return s;
  });
  persist();
  flash();
  return true;
 } else if (sub === "spread") {
  applyRelayState((s) => {
   s.mode = "spread";
   s.enabled = true;
   s.url = s.url || "";
   if (s.url) {
    ensureRelay(s, s.url);
   }
   return s;
  });
  persist();
  flash();
  return true;
 } else if (sub === "on") {
  applyRelayState((s) => {
   s.mode = "on";
   s.enabled = true;
   s.url = s.url || "";
   if (s.url) {
    ensureRelay(s, s.url);
   }
   return s;
  });
  persist();
  flash();
  return true;
 } else if (sub === "off") {
  applyRelayState((s) => {
   s.mode = "off";
   s.enabled = false;
   return s;
  });
  persist();
  flash();
  return true;
 } else if (sub === "hide" || (sub === "widget" && rest === "hide")) {
  applyRelayState((s) => ({ ...s, hideWidget: true }));
  persist();
  deps.updateStatusBar?.(ctx.ui);
  ctx.ui.notify("Widget hidden — use /freeflow show or /freeflow widget show to restore", "info");
  return true;
 } else if (sub === "show" || (sub === "widget" && rest === "show")) {
  applyRelayState((s) => ({ ...s, hideWidget: false }));
  persist();
  flash();
  ctx.ui.notify("Widget shown", "info");
  return true;
 } else if (sub === "list") {
  showList(ctx, () => relayState);
  return true;
 } else if (sub === "add") {
  if (!rest.trim()) {
   await addRelayInteractive(ctx, act);
  } else {
   const tokens = rest.trim().split(/\s+/);
   const targetUrl = tokens[0];
   const customLabel = tokens.slice(1).join(" ").trim() || undefined;
   try {
    applyRelayState((s) => {
     const added = ensureRelay(s, targetUrl, customLabel);
     s.enabled = true;
     s.url = added.url;
     return s;
    });
   } catch (e) {
    ctx.ui.notify((e as Error).message, "warning");
    return true;
   }
   persist();
   flash();
   ctx.ui.notify(
    `✓ Added & activated relay [${shortRelayLabel(relayState.url, relayState.relays)}]: ${relayState.url}`,
    "info",
   );
  }
  return true;
 } else if (sub === "use") {
  if (!rest.trim()) {
   await switchRelay(ctx, act);
  } else {
   const tokens = rest.trim().split(/\s+/);
   const targetToken = tokens[0];
   const customLabel = tokens.slice(1).join(" ").trim() || undefined;
   const matched = findRelay(relayState, targetToken);
   if (matched) {
    applyRelayState((s) => {
     const fresh = s.relays.find((r) => r.url === matched.url);
     if (!fresh) return s;
     s.enabled = true;
     s.url = fresh.url;
     if (customLabel) {
      fresh.label = customLabel;
     }
     return s;
    });
    persist();
    flash();
   } else {
    // Only treat unmatched tokens as new relays when they are absolute
    // http(s) URLs — typos or bad indices must not become saved junk relays.
    let parsedUrl = null;
    try {
     parsedUrl = new URL(targetToken);
    } catch { }
    const looksLikeUrl = parsedUrl && (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:");
    if (looksLikeUrl) {
     try {
      applyRelayState((s) => {
       const added = ensureRelay(s, targetToken, customLabel);
       s.enabled = true;
       s.url = added.url;
       return s;
      });
     } catch (e) {
      ctx.ui.notify((e as Error).message, "warning");
      return true;
     }
     persist();
     flash();
    } else {
     ctx.ui.notify(`Relay '${targetToken}' not found in saved list`, "warning");
    }
   }
  }
  return true;
 } else if (sub === "label" || sub === "rename") {
  if (!rest.trim()) {
   await editRelayLabelMenu(ctx, act);
  } else {
   const tokens = rest.trim().split(/\s+/);
   const targetToken = tokens[0];
   const newLabel = tokens.slice(1).join(" ").trim();
   const matched = findRelay(relayState, targetToken);
   if (!matched) {
    ctx.ui.notify(`Relay '${targetToken}' not found in saved list`, "warning");
    return true;
   }
   if (!newLabel) {
    ctx.ui.notify("Usage: /freeflow label <target> <new-name>", "warning");
    return true;
   }
   applyRelayState((s) => {
    setRelayLabel(s, matched.url, newLabel);
    return s;
   });
   persist();
   flash();
   ctx.ui.notify(
    `✓ Relay short name updated to [${newLabel}] for ${matched.url}`,
    "info",
   );
  }
  return true;
 } else if (sub === "remove") {
  if (!rest.trim()) {
   await removeRelayMenu(ctx, act);
  } else {
   const target = rest.trim();
   const matched = findRelay(relayState, target);
   if (!matched) {
    ctx.ui.notify(`Relay '${target}' not in saved list`, "warning");
    return true;
   }
   if (matched.url === relayState.url && relayState.relays.length > 1) {
    ctx.ui.notify(
     "Cannot remove the active relay — switch to another relay first",
     "warning",
    );
    return true;
   }
   applyRelayState((s) => {
    removeRelay(s, matched.url);
    return s;
   });
   persist();
   ctx.ui.notify(`Removed: [${shortRelayLabel(matched.url, relayState.relays)}] ${matched.url}`, "info");
  }
  return true;
 } else if (sub === "export") {
  const tokens = rest.trim() ? rest.trim().split(/\s+/) : [];
  let target: string | undefined;
  let includeSecrets = false;
  for (const t of tokens) {
   if (t === "--include-secrets") {
    includeSecrets = true;
   } else if (t.startsWith("--")) {
    ctx.ui.notify(`Unknown flag ${t} — usage: /freeflow export [path] [--include-secrets].`, "warning");
    return true;
   } else if (target === undefined) {
    target = t;
   }
  }
  await runExport(ctx, target, includeSecrets, { flash, updateStatusBar: deps.updateStatusBar });
  return true;
 } else if (sub === "import") {
  const tokens = rest.trim() ? rest.trim().split(/\s+/) : [];
  let target: string | undefined;
  let sawMerge = false;
  let sawReplace = false;
  let dryRun = false;
  for (const t of tokens) {
   if (t === "--merge") {
    sawMerge = true;
   } else if (t === "--replace") {
    sawReplace = true;
   } else if (t === "--dry-run") {
    dryRun = true;
   } else if (t.startsWith("--")) {
    ctx.ui.notify(`Unknown flag ${t} — usage: /freeflow import <path> [--merge|--replace] [--dry-run].`, "warning");
    return true;
   } else if (target === undefined) {
    target = t;
   }
  }
  if (sawMerge && sawReplace) {
   ctx.ui.notify("Both --merge and --replace given — showing a merge preview. Nothing changed.", "info");
   await runImport(ctx, target, "merge", true, act);
   return true;
  }
  await runImport(ctx, target, sawReplace ? "replace" : "merge", dryRun, act);
  return true;
 } else if (sub === "url") {
  const input =
   rest ||
   (await ctx.ui.input(
    "Relay URL (empty = default):",
    relayState.url || "",
   ));
  const cleanInput = (input || "").trim() || "";
  try {
   applyRelayState((s) => {
    s.url = cleanInput;
    if (cleanInput) {
     ensureRelay(s, cleanInput, shortRelayLabel(cleanInput, s.relays));
    }
    return s;
   });
  } catch (e) {
   ctx.ui.notify((e as Error).message, "warning");
   return true;
  }
  persist();
  flash();
  return true;
 } else if (!sub) {
  await showRelayInteractiveMenu(ctx, deps);
  return true;
 }

 return false;
}
