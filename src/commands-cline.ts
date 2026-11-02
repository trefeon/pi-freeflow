/**
 * Interactive CLI slash command handlers for Cline account management and OAuth.
 */

import { addAccount, findClineAccountSlot, loadPool, redactedToken, removeAccount } from "./cline-accounts.ts";
import type { ClinePoolState } from "./cline-accounts.ts";
import { CLINE_BROWSER_SIGNOUT_URL, pollDeviceToken, registerClineToken, startDeviceAuth, toApiKey } from "./cline-device-auth.ts";
import { isCertError } from "./system-ca-fetch.ts";
import type { ExtensionContext } from "./types.ts";

/**
 * Deterministic next-slot picker: "default" if absent (the single-account
 * login, then the smallest free "slot-2", "slot-3", … — never overwriting
 * a saved login. Pure — takes the pool, returns a name.
 */
export function nextClineSlot(pool: ClinePoolState): string {
 if (!pool.accounts.some((a) => a.slot === "default")) return "default";
 let n = 2;
 while (pool.accounts.some((a) => a.slot === `slot-${n}`)) n += 1;
 return `slot-${n}`;
}

/**
 * Per-slot usage row as persisted under pool.usage. Read defensively: pools
 * saved before usage tracking existed carry no such field, so every property
 * is narrowed at use. Never carries identity — callers map slot to identity.
 */
export interface ClineUsageRow {
 served: number;
 lastAt: number;
 lastModel: string;
}

/** Usage map off the pool without depending on the tracking lane's types. */
export function clineUsageRows(pool: ClinePoolState): Record<string, ClineUsageRow> {
 const raw = (pool as unknown as { usage?: unknown }).usage;
 if (!raw || typeof raw !== "object") return {};
 const out: Record<string, ClineUsageRow> = {};
 for (const [slot, entry] of Object.entries(raw as Record<string, unknown>)) {
  if (!entry || typeof entry !== "object") continue;
  const rec = entry as Record<string, unknown>;
  if (typeof rec.served !== "number" || !(rec.served >= 0)) continue;
  out[slot] = {
   served: rec.served,
   lastAt: typeof rec.lastAt === "number" ? rec.lastAt : 0,
   lastModel: typeof rec.lastModel === "string" ? rec.lastModel : "",
  };
 }
 return out;
}

/** Masked identity for NEW display text — the raw email never appears there. */
export function maskClineEmail(email: string): string {
 const at = email.indexOf("@");
 if (at <= 0) return "***";
 const domain = email.slice(at + 1);
 if (!domain) return "***";
 return `${email[0]}***@${domain}`;
}

/** Relative age for a usage timestamp, ISO fallback for old/future values. */
export function clineUsageAge(lastAt: number, now = Date.now()): string {
 if (!(lastAt > 0)) return "";
 const diff = now - lastAt;
 if (diff < 0) return new Date(lastAt).toISOString();
 if (diff < 60_000) return "just now";
 if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
 if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
 if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
 return new Date(lastAt).toISOString();
}

/** Usage suffix for one account line; zero-state reads `served 0 · never used`. */
export function formatClineUsageSuffix(slot: string, usage: Record<string, ClineUsageRow>, now = Date.now()): string {
 const row = usage[slot];
 if (!row || row.served <= 0) return " · served 0 · never used";
 const age = clineUsageAge(row.lastAt, now);
 const last = row.lastModel ? ` · last ${row.lastModel}${age ? ` ${age}` : ""}` : "";
 return ` · served ${row.served}${last}`;
}

/**
 * Compact Cline block for the status banner. Masked identity only — the raw
 * email never appears here even though account lines still show it.
 */
export function formatClineStatusSnippet(pool: ClinePoolState, now = Date.now()): string {
 const n = pool.accounts.length;
 if (!n) return "Cline: no logins";
 const usage = clineUsageRows(pool);
 let best: { slot: string; row: ClineUsageRow } | null = null;
 for (const a of pool.accounts) {
  const row = usage[a.slot];
  if (!row || row.served <= 0) continue;
  if (!best || row.lastAt > best.row.lastAt) best = { slot: a.slot, row };
 }
 if (!best) return `Cline: ${n} login(s) · never used`;
 const account = pool.accounts.find((a) => a.slot === best.slot);
 const who = account?.email ? maskClineEmail(account.email) : (account?.accountId || best.slot);
 const model = best.row.lastModel ? ` (${best.row.lastModel})` : "";
 return `Cline: ${n} login(s) · last used: [${best.slot}] ${who}${model}`;
}

/** One notify-ready line per saved login, in pool order, with usage. */
export function formatClineAccountLines(pool: ClinePoolState): string[] {
 const usage = clineUsageRows(pool);
 return pool.accounts.map((a, idx) => {
  const star = a.slot === pool.activeSlot ? "*" : " ";
  const who = a.email || a.accountId;
  const whoPart = who ? ` ${who}` : "";
  // Two slots on one account share one quota, so rotation between them buys
  // nothing. Mark the later one against the earlier slot it duplicates.
  const earlier = { accounts: pool.accounts.slice(0, idx) };
  const dup = findClineAccountSlot(earlier, a);
  const dupPart = dup ? ` — same account as [${dup}]` : "";
  return `${star} [${idx + 1}] [${a.slot}]${whoPart} key ending ${redactedToken(a.token)}${dupPart}${formatClineUsageSuffix(a.slot, usage)}`;
 });
}

/** User-safe one-line message for caught values (never echoes secrets). */
export function clineErrorMessage(e: unknown): string {
 if (e instanceof Error && e.message) return e.message;
 if (typeof e === "string" && e) return e;
 return "unknown error";
}

export interface ClineCommandDeps {
 readonly [key: string]: unknown;
}

export async function handleClineSubcommand(
 sub: string,
 args: string,
 ctx: ExtensionContext,
 _deps?: ClineCommandDeps,
): Promise<boolean> {
 if (sub !== "cline") return false;

 const tokens = args.trim() ? args.trim().split(/\s+/) : [];
 const action = (tokens[0] || "accounts").toLowerCase();
 const arg = tokens.slice(1).join(" ").trim();
 if (action === "login") {
  const raw = tokens.slice(1);
  const pasteMode = raw.some((t) => t === "--key");
  const slotArg = raw.filter((t) => t !== "--key").join(" ").trim();
  if (pasteMode) {
   // Manual fallback: paste a workos: API key (never shown back).
   const slot = slotArg || ((await ctx.ui.input("Cline slot name (empty = default):", "default"))?.trim() || "default");
   const token = ((await ctx.ui.input(`Paste the API key for Cline slot [${slot}]:`, ""))?.trim() || "");
   if (!token) {
    ctx.ui.notify("Cancelled — no API key provided", "warning");
   } else {
    try {
     addAccount(slot, token);
     ctx.ui.notify(`Saved Cline login [${slot}] (key ending ${redactedToken(token)}) — free Cline models are ready to use`, "info");
    } catch (e) {
     ctx.ui.notify((e as Error).message, "warning");
    }
   }
   return true;
  }
  // Device login inside the extension: approve in the browser, no paste.
  const slot = slotArg || nextClineSlot(loadPool());
  let started;
  try {
   started = await startDeviceAuth();
  } catch (e) {
   if (isCertError(e)) {
    ctx.ui.notify("Could not reach Cline: your antivirus or network proxy intercepts TLS and Node does not trust it. The login retries with your OS certificates automatically — if this persists, restart the host with NODE_USE_SYSTEM_CA=1 set, or point NODE_EXTRA_CA_CERTS at your proxy CA file.", "error");
    return true;
   }
   ctx.ui.notify(`Could not reach Cline to start login: ${clineErrorMessage(e)}`, "error");
   return true;
  }
  const link = started.verificationUriComplete ?? started.verificationUri;
  const minutes = Math.max(1, Math.round(started.expiresIn / 60));
  const loginLine = `Cline login [${slot}]\nOpen this link in your browser:\n${link}\nEnter code: ${started.userCode} (expires in ~${minutes} min)\nWaiting for approval — approve or cancel in the browser; this finishes on its own.\nDifferent account? Sign out first: ${CLINE_BROWSER_SIGNOUT_URL} (or use a private window)`;
  ctx.ui.notify(loginLine, "info");
  try { ctx.ui.setStatus("cline-login", `Cline login [${slot}] code ${started.userCode}`); } catch { }
  const progress = setInterval(() => {
   ctx.ui.notify(loginLine, "info");
  }, 45000);
  // @ts-ignore allow unref to not block process exit in CLI
  progress.unref?.();
  try {
   const deviceTokens = await pollDeviceToken(undefined, started.deviceCode, started.interval, { maxWaitMs: Math.max(60_000, started.expiresIn * 1000) });
   const creds = await registerClineToken(undefined, deviceTokens.accessToken, deviceTokens.refreshToken);
   const apiKey = toApiKey(creds.access);
   const dup = findClineAccountSlot(loadPool(), { token: apiKey, accountId: creds.accountId, email: creds.email }, slot);
   if (dup) {
    // Same account twice shares one free quota, so it would never add capacity.
    ctx.ui.notify(
     `That Cline account${creds.email ? ` (${creds.email})` : ""} is already saved as [${dup}] — nothing added.\nUse a different account: /freeflow cline signout shows the sign-out link. Or drop the existing one first: /freeflow cline logout ${dup}`,
     "warning",
    );
    return true;
   }
   addAccount(slot, apiKey, {
    refreshToken: creds.refresh,
    expiresAt: creds.expires,
    ...(creds.accountId ? { accountId: creds.accountId } : {}),
    ...(creds.email ? { email: creds.email } : {}),
   });
   ctx.ui.notify(`Saved Cline login [${slot}] (key ending ${redactedToken(apiKey)}) — free Cline models are ready to use`, "info");
   const pool = loadPool();
   ctx.ui.notify(`Cline logins (${pool.accounts.length}):\n${formatClineAccountLines(pool).join("\n")}`, "info");
  } catch (e) {
   let code: string | undefined;
   if (e && typeof e === "object" && "errorCode" in e && typeof e.errorCode === "string") {
    code = e.errorCode;
   }
   if (code === "access_denied") {
    ctx.ui.notify("Cline login cancelled.", "warning");
   } else if (code === "expired_token") {
    ctx.ui.notify("Cline login code expired — run /freeflow cline login again for a fresh code.", "warning");
   } else {
    ctx.ui.notify(`Cline login did not finish: ${clineErrorMessage(e)}`, "warning");
   }
  } finally {
   clearInterval(progress);
   try { ctx.ui.setStatus("cline-login", undefined); } catch { }
  }
 } else if (action === "accounts" || action === "list") {
  const pool = loadPool();
  if (!pool.accounts.length) {
   ctx.ui.notify("No Cline logins saved — add one with /freeflow cline login", "info");
  } else {
   ctx.ui.notify(`Cline logins (${pool.accounts.length}):\n${formatClineAccountLines(pool).join("\n")}`, "info");
  }
 } else if (action === "logout" || action === "remove") {
  const pool = loadPool();
  if (!pool.accounts.length) {
   ctx.ui.notify("No Cline logins saved — nothing to remove", "info");
  } else {
   const resolveSlot = (raw: string): string | null => {
    const clean = (raw || "").trim();
    if (!clean) return null;
    const byIndex = Number.parseInt(clean, 10);
    if (String(byIndex) === clean && byIndex >= 1 && byIndex <= pool.accounts.length) return pool.accounts[byIndex - 1].slot;
    const exact = pool.accounts.find((a) => a.slot === clean);
    if (exact) return exact.slot;
    const folded = pool.accounts.find((a) => a.slot.toLowerCase() === clean.toLowerCase());
    return folded ? folded.slot : null;
   };
   let slot = resolveSlot(arg);
   if (arg && !slot) {
    const saved = pool.accounts.map((a, idx) => `${idx + 1}=${a.slot}`).join(", ");
    ctx.ui.notify(`Cline slot '${arg}' not found. Saved: ${saved}`, "warning");
   } else {
    if (!slot) {
     if (pool.accounts.length === 1) {
      slot = pool.accounts[0].slot;
     } else {
      const opts = formatClineAccountLines(pool);
      const choice = await ctx.ui.select("Remove Cline login", [...opts, "Cancel"]);
      if (!choice || choice === "Cancel") {
       ctx.ui.notify("Cancelled — no slot removed", "warning");
       return true;
      }
      const hit = pool.accounts.find((a, idx) => opts[idx] === choice);
      slot = hit ? hit.slot : null;
     }
    }
    if (!slot) {
     ctx.ui.notify("Cancelled — no slot removed", "warning");
    } else if (!removeAccount(slot)) {
     ctx.ui.notify(`Cline slot '${slot}' not found`, "warning");
    } else {
     ctx.ui.notify(`Removed Cline login [${slot}]`, "info");
    }
   }
  }
 } else if (action === "signout" || action === "sign-out" || action === "switch") {
  // Signing out is a browser action; it never touches saved logins here.
  const saved = loadPool().accounts.length;
  ctx.ui.notify(
   `Sign out of Cline in your browser to use a different account:\n${CLINE_BROWSER_SIGNOUT_URL}\nA private window works too, and keeps your current session.\nThen run /freeflow cline login again — each login gets its own slot (${saved ? `you have ${saved}; next is ` : "next is "}${nextClineSlot(loadPool())}).`,
   "info",
  );
 } else {
  ctx.ui.notify("Usage: /freeflow cline login [--key] [slot] | /freeflow cline accounts | /freeflow cline logout [slot] | /freeflow cline signout", "warning");
 }
 return true;
}
