/**
 * Interactive CLI slash commands and status bar manager for pi-freeflow
 *
 * log viewing, debug level configuration, and live catalog refreshing.
 */

import path from "node:path";
import { ensureDaemon as ensureClientDaemon, getClientPort, stopHeartbeat } from "./client.ts";
import { refreshCatalog, setAliveCatalog } from "./catalog.ts";
import { DATA_DIR_ENV, DEBUG_STATE_FILE, HOST, LOG_FILE, PORT, RELAY_STATE_FILE, ZEN_TRANSPORT_ENV } from "./config.ts";
import { getCachedUpdate, isLinkedInstall } from "./update-checker.ts";
import {
 compareVersions,
 fetchLatestVersion,
 formatVersionDetail,
 formatVersionLine,
 getLocalVersion,
 runUpdateStep,
} from "./update-core.ts";
import { isCommandAvailable, selectGlobalUpdatePlan, selectHostUpdateSteps } from "./updater.ts";
import { tokenAuthHeaders } from "./token.ts";
import {
 deployCloudflareWorker,
 deployDenoRelay,
 deployVercelRelay,
 type DeployPlatform,
} from "./deploy.ts";
import {
 createLogFollower,
 LOG_LEVEL_ORDER,
 getMinLogLevel,
 isDebugEnabled,
 isEmittedLogLevel,
 loadDebugState,
 readRecentLogs,
 saveDebugState,
} from "./logger.ts";
import { probeRelay } from "./probe.ts";
import { resolveZenTransport } from "./zen-transport.ts";
import { killPortHolder } from "./proxy.ts";
import { getUpstreamHealth, resetUpstreamGate } from "./upstream-health.ts";
import {
 ensureRelay,
 findRelay,
 getActiveRelayState,
 ewmaBadge,
 getRelayHealth,
 loadRelayState,
 setActiveRelayState,
 setStatusUi,
 shortRelayLabel,
 withRelayState,
 formatRelayFlash,
 formatRelayStatusLabel,
} from "./relay-state.ts";
import { loadPool } from "./cline-accounts.ts";
import type {
 ExtensionAPI,
 ExtensionContext,
 ExtensionUIContext,
 KnownRelay,
 LogLevel,
 RegisteredCommand,
 RegisteredModel,
} from "./types.ts";
import {
 STARTUP_SERVICE_NAME,
 STARTUP_TASK_NAME,
 escapeSchTasksAction,
 getStartupPlan,
 handleStartupSubcommand,
 installStartupHook,
 uninstallStartupHook,
 _setStartupHookRunnerForTest,
 type StartupPlan,
} from "./commands-startup.ts";
import {
 addRelayInteractive,
 classifyImportFailure,
 editRelayLabelMenu,
 handleRelaySubcommand,
 removeRelayMenu,
 runExport,
 runImport,
 showList,
 showRelayInteractiveMenu,
 switchRelay,
 type RelayCommandDeps,
} from "./commands-relay.ts";
import {
 clineErrorMessage,
 clineUsageRows,
 formatClineAccountLines,
 formatClineStatusSnippet,
 formatClineUsageSuffix,
 handleClineSubcommand,
 maskClineEmail,
 nextClineSlot,
 type ClineCommandDeps,
 type ClineUsageRow,
} from "./commands-cline.ts";

export {
 STARTUP_SERVICE_NAME,
 STARTUP_TASK_NAME,
 escapeSchTasksAction,
 getStartupPlan,
 handleStartupSubcommand,
 installStartupHook,
 uninstallStartupHook,
 _setStartupHookRunnerForTest,
 type StartupPlan,
};

export {
 addRelayInteractive,
 classifyImportFailure,
 editRelayLabelMenu,
 handleRelaySubcommand,
 removeRelayMenu,
 runExport,
 runImport,
 showList,
 showRelayInteractiveMenu,
 switchRelay,
 type RelayCommandDeps,
};

export {
 clineErrorMessage,
 clineUsageRows,
 formatClineAccountLines,
 formatClineStatusSnippet,
 formatClineUsageSuffix,
 handleClineSubcommand,
 maskClineEmail,
 nextClineSlot,
 type ClineCommandDeps,
 type ClineUsageRow,
};

/**
 * Update the TUI status bar widget with active relay state.
 */
export function updateStatusBar(ui?: ExtensionUIContext): void {
 if (!ui) return;
 ui.setStatus?.("freeflow", formatRelayStatusLabel(getActiveRelayState()) ?? undefined);
}

let deployProbeRetries = 5;
let deployProbeRetryDelayMs: number | null = null;

/** Test-only: override post-deploy probe retry count and delay. */
export function _setDeployProbeOptionsForTest(
 opts: { retries?: number; retryDelayMs?: number } | null,
): void {
 deployProbeRetries = opts?.retries ?? 5;
 deployProbeRetryDelayMs = opts?.retryDelayMs ?? null;
}

function spawnWithProgress(
 cmd: string,
 args: string[],
 ctx: ExtensionContext,
 timeoutMs = 120_000,
): Promise<number> {
 return runUpdateStep(cmd, args, {
  timeoutMs,
  onOutput: (line) => ctx.ui.notify(line, "info"),
  onWarning: (message) => ctx.ui.notify(message, "warning"),
 });
}

/**
 * Follow-mode log poller: one stateful byte-offset follower over the live log
 * file (createLogFollower), so each tick reads only the bytes appended since
 * the previous tick instead of re-reading the log file and every rotated
 * archive. Existing content is the one-shot tail's job — it is printed before
 * this poller starts, and the follower never re-reports it. One poller at a
 * time: a re-run clears the previous interval.
 * Stop with stopLogsFollow (session shutdown / non-follow commands).
 */
let logsFollowTimer: NodeJS.Timeout | null = null;
export function stopLogsFollow(): void {
 if (logsFollowTimer) {
  clearInterval(logsFollowTimer);
  logsFollowTimer = null;
 }
}
function startLogsFollow(
 ctx: ExtensionContext,
 filterLevel: LogLevel | null,
 filterReqId: string | null,
 filterText: string | null,
): void {
 stopLogsFollow();
 const follower = createLogFollower({
  level: filterLevel,
  reqId: filterReqId,
  text: filterText,
 });
 logsFollowTimer = setInterval(() => {
  try {
   const newLines = follower.next();
   if (newLines.length > 0) {
    ctx.ui.notify(newLines.join("\n"), "info");
   }
  } catch { }
 }, 1000);
 // @ts-ignore allow unref to not block process exit in CLI
 logsFollowTimer.unref?.();
}

/**
 * Validate a user-supplied deploy project name before any network call.
 * Mirrors the cleanup the deploy builders apply (lowercase, runs of
 * non-[a-z0-9-] become one dash, edge dashes trimmed): a name with no usable
 * characters would silently fall back to a generic worker name and likely
 * collide, and an over-long Cloudflare/Deno name would silently truncate to
 * something the user did not ask for. Pure: never touches disk or network.
 */
export function validateDeployProjectName(
 raw: string,
 platform: DeployPlatform,
): { ok: true; name: string } | { ok: false; reason: string } {
 const clean = (raw || "")
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-")
  .replace(/-{2,}/g, "-")
  .replace(/^-+|-+$/g, "");
 if (!clean) {
  return {
   ok: false,
   reason: `Project name '${(raw || "").trim()}' has no usable letters or numbers — use characters a-z, 0-9, '-'`,
  };
 }
 const max = platform === "cloudflare" ? 58 : platform === "deno" ? 32 : 0;
 if (max > 0 && clean.length > max) {
  return {
   ok: false,
   reason: `Project name '${clean}' is ${clean.length} chars — ${platform === "cloudflare" ? "Cloudflare" : "Deno Deploy"} allows max ${max}. Shorten it and retry`,
  };
 }
 return { ok: true, name: clean };
}
/**
 * /freeflow update restarts the daemon the session is actually attached to: a
 * walked port must not keep serving the old build after a successful update.
 * Three indirections keep that contract testable without module mocking — the
 * update-step runner, the attached-port lookup and the killer. Production never
 * calls the setter; the defaults are the real spawnWithProgress, the real
 * getClientPort() || PORT and the real killPortHolder.
 */
let updateStepRunner = spawnWithProgress;
let attachedPortResolver = (): number => getClientPort() || PORT;
let attachedPortKiller: (port: number) => Promise<unknown> = killPortHolder;
let daemonEnsurer: () => Promise<unknown> = ensureClientDaemon;

/** Test seam for the /freeflow update restart path (null restores the real deps). */
export function _setUpdateRestartDepsForTest(
 opts: {
  runUpdateStep?: (cmd: string, args: string[], ctx: ExtensionContext) => Promise<number>;
  resolveAttachedPort?: () => number;
  killAttachedPort?: (port: number) => Promise<unknown>;
  ensureDaemon?: () => Promise<unknown>;
 } | null,
): void {
 updateStepRunner = opts?.runUpdateStep ?? spawnWithProgress;
 attachedPortResolver = opts?.resolveAttachedPort ?? ((): number => getClientPort() || PORT);
 attachedPortKiller = opts?.killAttachedPort ?? killPortHolder;
 daemonEnsurer = opts?.ensureDaemon ?? ensureClientDaemon;
}

export function createCommandSpec(
 _pi: ExtensionAPI,
 onCatalogRefreshed?: (models: RegisteredModel[]) => void,
): Omit<RegisteredCommand, "name"> {
 return {
  description:
   "Relay egress: auto | sticky | spread | on | off | hide | show | widget hide/show | status | version|ver | kill|stop|shutdown | add <URL> [name] | list | use <URL|name|index> [name] | label <target> <name> | remove <target> | url [value] | test [target|opencode] [--chat] | export [path] [--include-secrets] | import <path> [--merge|--replace] [--dry-run] | logs [level] [n] | trace [reqId] | debug on|off|level <level> | refresh | models|reload | update [auto on|off] | autoupdate [on|off] | deploy cloudflare | deploy deno | deploy vercel | install-startup | uninstall-startup | cline login [--key] [slot] | cline accounts | cline logout [slot] | cline signout|switch",
  getArgumentCompletions: (prefix: string) =>
   [
    "auto",
    "sticky",
    "spread",
    "on",
    "off",
    "hide",
    "widget hide",
    "widget show",
    "status",
    "version",
    "ver",
    "kill",
    "stop",
    "shutdown",
    "add",
    "list",
    "use",
    "label",
    "rename",
    "remove",
    "export",
    "import",
    "test",
    "test opencode",
    "url",
    "autoupdate",
    "autoupdate on",
    "autoupdate off",
    "update auto",
    "update auto on",
    "update auto off",
    "deploy",
    "deploy cloudflare",
    "deploy deno",
    "deploy vercel",
    "install-startup",
    "uninstall-startup",
    "cline",
    "cline login",
    "cline login --key",
    "cline accounts",
    "cline logout",
    "cline signout",
    "cline switch",
    "refresh",
    "models",
    "reload",
    "logs",
    "debug",
    "debug on",
    "debug off",
    "debug level debug",
    "debug level info",
    "debug level warn",
    "debug level error",
    "trace",
   ]
    .filter((s) => s.startsWith(prefix))
    .map((s) => ({ value: s, label: s })),
  handler: async (args: string, ctx: ExtensionContext) => {
   const parts = String(args || "")
    .trim()
    .split(/\s+/);
   const sub = parts[0] || "";
   const rest = parts.slice(1).join(" ");
   let relayState = getActiveRelayState();

   const flash = () => {
    ctx.ui.notify(formatRelayFlash(relayState), "info");
   };

   // UI refresh only — every disk write flows through CAS
   // (withRelayState) so the operation is re-applied to the freshest
   // on-disk state at write time instead of a stale snapshot.
   const persist = () => {
    setStatusUi(ctx.ui);
    updateStatusBar(ctx.ui);
   };
   const DEPLOY_OPTIONS: Record<string, DeployPlatform> = {
    "Cloudflare (100k req/day — recommended)": "cloudflare",
    "Deno Deploy (100k req/day)": "deno",
    "Vercel (last resort — Hobby 10GB origin cap)": "vercel",
   };

   const parseDeployPlatform = (raw?: string): DeployPlatform | null => {
    const v = (raw || "").trim().toLowerCase();
    if (!v || v === "cloudflare" || v === "cf") return "cloudflare";
    if (v === "deno") return "deno";
    if (v === "vercel") return "vercel";
    return null;
   };

   const doDeploy = async (platform: DeployPlatform = "cloudflare") => {
    const defaultName = `relay-${Date.now().toString(36)}`;
    const label =
     platform === "cloudflare"
      ? "Cloudflare"
      : platform === "deno"
       ? "Deno Deploy"
       : "Vercel";
    const tokenHint =
     platform === "cloudflare"
      ? "Cloudflare relay — token: dash.cloudflare.com → API Tokens (Workers Scripts: Edit)"
      : platform === "deno"
       ? "Deno Deploy relay — token: dash.deno.com → Access Tokens"
       : "Vercel relay — token: vercel.com/account/tokens";
    ctx.ui.notify(tokenHint, "info");
    if (platform === "deno") {
     // Verified 2026-10-17: Deno Deploy rewrites the outbound User-Agent at the
     // platform layer, so OpenCode Zen's free tier rejects every request that
     // rides this relay. Warn before spending a token on a Zen-only deployment.
     ctx.ui.notify(
      "⚠ Deno Deploy rewrites outbound User-Agent: OpenCode Zen free-tier requests through this relay are rejected (403 FreeTierError). It can still serve Kilo models — prefer Cloudflare for Zen.",
      "warning",
     );
    }
    const token = (
     await ctx.ui.input(`${label} API token:`, "")
    )?.trim();
    if (!token) {
     ctx.ui.notify("Deploy cancelled: no token", "warning");
     return;
    }
    const entered =
     (
      await ctx.ui.input(
       "Project name (empty = auto):",
       defaultName,
      )
     )?.trim() || defaultName;
    const nameCheck = validateDeployProjectName(entered, platform);
    if (!nameCheck.ok) {
     ctx.ui.notify(`Deploy cancelled: ${nameCheck.reason}`, "warning");
     return;
    }
    const name = entered;
    const cleanName = nameCheck.name;
    // Never display a short token in full: its "last 4" would be the secret.
    const tokenTail = token.length > 8 ? token.slice(-4) : "***";

    if (typeof ctx.ui.confirm === "function") {
     const ok = await ctx.ui.confirm(
      "Deploy relay",
      cleanName === name
       ? `Deploy ${label} relay '${name}' using token ending ${tokenTail}?`
       : `Deploy ${label} relay '${name}' (as '${cleanName}') using token ending ${tokenTail}?`,
     );
     if (!ok) {
      ctx.ui.notify("Deploy cancelled", "warning");
      return;
     }
    }

 ctx.ui.setStatus?.("freeflow", `deploying ${platform} relay…`);
    try {
     const deployer =
      platform === "cloudflare"
       ? deployCloudflareWorker
       : platform === "deno"
        ? deployDenoRelay
        : deployVercelRelay;
     const { url, auth } = await deployer(token, name, (m) =>
      ctx.ui.notify(m, "info"),
     );
     const finalUrl = url.trim().replace(/\/+$/, "");
     // Probe BEFORE writing anything: a deployment that cannot answer must not
     // become the sticky, enabled pool entry (nor evict a working relay).
     let probeNote = "";
     let reachable = false;
     try {
      const retryDelay =
       deployProbeRetryDelayMs ?? (process.env[DATA_DIR_ENV] ? 10 : 2000);
      const probe = await probeRelay(finalUrl, auth, {
       retries: deployProbeRetries,
       retryDelayMs: retryDelay,
       onRetry: (attempt, total) => {
        ctx.ui.notify(
         `Waiting for edge routing to propagate (${attempt}/${total})…`,
         "info",
        );
       },
      });
      reachable = probe.ok;
      if (!probe.ok) {
       probeNote = `unreachable (${probe.error || `HTTP ${probe.status}`})`;
      } else {
       // Reachability is not enough: a relay can answer /v1/models while its
       // egress is transformed in flight (Deno Deploy rewrites the outbound
       // User-Agent), and OpenCode Zen then rejects the real traffic. The chat
       // probe carries the full free-tier fingerprint + tools + stream, so it
       // fails exactly when Zen inference through this relay would.
       const chat = await probeRelay(finalUrl, auth, {
        endpoint: "chat",
        retries: 1,
        retryDelayMs: retryDelay,
       });
       if (chat.ok) {
        probeNote = ` ✓ reachable + free-tier inference verified (HTTP ${chat.status}, ${chat.latencyMs}ms)`;
       } else {
        // The Deno User-Agent rewrite only explains the free-tier gate; a
        // timeout or a 5xx must report what was actually observed instead.
        const denoGate = platform === "deno" && chat.status === 403;
        const reason = denoGate
         ? "— Deno Deploy rewrites the outbound User-Agent, which OpenCode Zen rejects; Kilo models still work through this relay"
         : `(${chat.error || `HTTP ${chat.status}`}) — this relay cannot serve OpenCode Zen traffic (its egress is transformed in flight)`;
        probeNote = ` ⚠ reachable, but the free-tier inference probe failed ${reason}. Run /freeflow test ${finalUrl} --chat to re-check, or /freeflow remove ${finalUrl} to drop it`;
       }
      }
     } catch {
      // probeRelay never throws, but keep the notify safe regardless
     }
     if (!reachable) {
      updateStatusBar(ctx.ui);
      ctx.ui.notify(
       `⚠ Deployed ${finalUrl} but the probe failed: ${probeNote} — NOT added to the pool or activated, so the existing pool is unchanged. Run /freeflow test ${finalUrl} to retry, or /freeflow add ${finalUrl} to keep it anyway`,
       "error",
      );
      return;
     }
     relayState = withRelayState((s) => {
      const prevLabel = s.relays.find((r) => r.url === finalUrl)?.label;
      const r = ensureRelay(s, finalUrl, `deployed ${cleanName}`);
      if (auth) r.auth = auth;
      else delete r.auth;
      // A re-deploy at an existing address refreshes the secret but keeps a
      // user-chosen short name; only stock `deployed …` labels roll forward.
      if (prevLabel && !prevLabel.startsWith("deployed ")) r.label = prevLabel;
      s.enabled = true;
      s.url = finalUrl;
      return s;
     });
     persist();
     // saveRelayState swallows disk errors, so confirm the pool entry landed:
     // otherwise a live deployment would silently vanish on the next restart.
     let poolSaved = false;
     try {
      poolSaved = loadRelayState().relays.some((r) => r.url === finalUrl);
     } catch {
      poolSaved = false;
     }
     if (!poolSaved) {
      const secretNote = auth
       ? " Note: this relay uses a shared secret, so prefer redeploying if the re-added copy fails its probe."
       : "";
      ctx.ui.notify(`⚠ Relay is live at ${finalUrl} but NOT saved to the pool (disk write failed)${probeNote} — restore it with: /freeflow add ${finalUrl}.${secretNote}`, "error");
      return;
     }
     ctx.ui.notify(`✓ Deployed & active: ${finalUrl}${probeNote}`, "info");
    } catch (e) {
     updateStatusBar(ctx.ui);
     // Deploy errors echo upstream detail; never let the platform API token
     // leak through a message that repeats what the server (or network) said.
     const rawMsg = (e as Error).message;
     const safeMsg = token.length >= 8 ? rawMsg.split(token).join("[redacted]") : rawMsg;
     ctx.ui.notify(
      `Deploy failed: ${safeMsg}`,
      "error",
     );
    }
   };

   // 1. Delegate relay subcommands
   if (await handleRelaySubcommand(sub, ctx, { rest, updateStatusBar, doDeploy })) {
    return;
   }
   // 2. Delegate cline subcommands
   if (await handleClineSubcommand(sub, rest, ctx)) {
    return;
   }
   // 3. Delegate startup subcommands
   if (handleStartupSubcommand(sub, ctx)) {
    return;
   }

   if (sub === "status") {
    flash();
    const local = getLocalVersion();
    const versionLine = formatVersionLine(local);
    try {
     let latest: string | null = null;
     const cached = getCachedUpdate();
     if (cached && typeof cached.latest === "string") {
      latest = cached.latest;
     }
     if (latest && local && compareVersions(latest, local) > 0) {
      ctx.ui.notify(
       `Update available: ${local} -> ${latest} - run /freeflow update`,
       "info",
      );
     } else if (latest && local) {
      ctx.ui.notify(`Up to date (v${local})`, "info");
     }
    } catch {
     // swallow — status banner is best-effort
    }

    const modeLine =
     relayState.mode === "off"
      ? "Mode: off (always direct)"
      : relayState.mode === "on"
       ? "Mode: on (always relay, sticky primary)"
       : relayState.mode === "spread"
        ? "Mode: spread (rotates across healthy relays, auto-rolls on 429/5xx)"
        : "Mode: auto (sticky primary, auto-rolls on 429/5xx)";
    const poolLine = `${relayState.relays.length} relay(s)${relayState.relays.length > 0
     ? ` | active: ${shortRelayLabel(relayState.url, relayState.relays)}`
     : ""
     }`;
    const stateFileLine = `State file: ${RELAY_STATE_FILE}`;
    const upstreamLine = (["zen", "kilo"] as const)
     .map((u) => {
      const h = getUpstreamHealth(u);
      return h.gated
       ? `${u} gated (${h.consecutiveFreeTier403} fails) — new sessions degraded`
       : `${u} open`;
     })
     .join(" | ");
    const clineLine = formatClineStatusSnippet(loadPool());
    const zenTransportLine =
     typeof process.env[ZEN_TRANSPORT_ENV] === "string" && process.env[ZEN_TRANSPORT_ENV].trim() !== ""
      ? (() => {
       const zt = resolveZenTransport();
       return `\nZen transport: ${zt.mode} (${zt.mode === "bun-sidecar" && zt.bunVersion ? `bun v${zt.bunVersion}` : zt.reason})`;
      })()
      : "";
    const deadParked = relayState.relays.filter((r) => {
     const h = getRelayHealth(r.url);
     return h != null && h.lastStatus === 402 && Date.now() < h.cooldownUntil;
    });
    const deadLine = deadParked.length
     ? `\nDead relays (HTTP 402 disabled deployment, parked): ${deadParked.map((r) => r.url).join(", ")} — delete the Vercel project, run /freeflow remove <url>, then deploy Cloudflare`
     : "";
    ctx.ui.notify(`${versionLine}\n${modeLine} | ${poolLine} | auto-update: ${relayState.autoUpdate ? "on" : "off"}\n${stateFileLine}\nUpstream: ${upstreamLine}${zenTransportLine}\n${clineLine}${deadLine}`, "info");
   } else if (sub === "version" || sub === "ver") {
    // Offline by design: cached-latest only, never a live fetch.
    const local = getLocalVersion();
    try {
     const cached = getCachedUpdate();
     const latest = cached && typeof cached.latest === "string" ? cached.latest : null;
     ctx.ui.notify(formatVersionDetail(local, latest), "info");
    } catch {
     // swallow — version reply is best-effort
     ctx.ui.notify(formatVersionLine(local), "info");
    }
   } else if (sub === "kill" || sub === "stop" || sub === "shutdown") {
    const port = getClientPort() || PORT;
    try {
     // /_shutdown is token-gated like every other /_* route: without the
     // bearer header this is an unauthorized request, not a stopped daemon.
     const res = await fetch(`http://${HOST}:${port}/_shutdown`, {
      method: "POST",
      headers: tokenAuthHeaders(),
      signal: AbortSignal.timeout(1500),
     });
     if (res.ok) {
      ctx.ui.notify("Proxy daemon stopped — next freeflow use restarts it", "info");
     } else {
      ctx.ui.notify(`Daemon kill got HTTP ${res.status}`, "warning");
     }
    } catch {
     ctx.ui.notify("Daemon not running or not reachable", "warning");
    }
    try { await stopHeartbeat(); } catch { }
   } else if (sub === "restart") {
    const port = getClientPort() || PORT;
    try {
     await fetch(`http://${HOST}:${port}/_shutdown`, {
      method: "POST",
      headers: tokenAuthHeaders(),
      signal: AbortSignal.timeout(1500),
     });
    } catch { }
    try {
     await ensureClientDaemon();
     ctx.ui.notify("Proxy daemon restarted", "info");
    } catch (e) {
     ctx.ui.notify(`Restart failed: ${(e as Error).message}`, "error");
    }
   } else if (sub === "autoupdate" || (sub === "update" && rest.trim().toLowerCase().startsWith("auto"))) {
    const arg = sub === "autoupdate"
     ? rest.trim().toLowerCase()
     : rest.trim().slice(4).trim().toLowerCase();
    if (arg === "on" || arg === "enable" || arg === "true" || arg === "1") {
     withRelayState((s) => { s.autoUpdate = true; return s; });
     ctx.ui.notify("Auto-update enabled (new versions will be installed automatically).", "info");
    } else if (arg === "off" || arg === "disable" || arg === "false" || arg === "0") {
     withRelayState((s) => { s.autoUpdate = false; return s; });
     ctx.ui.notify("Auto-update disabled.", "info");
    } else {
     const current = loadRelayState().autoUpdate ? "ON" : "OFF";
     ctx.ui.notify(`Auto-update is currently ${current}. Use '/freeflow autoupdate on|off'`, "info");
    }
   } else if (sub === "update") {
    if (isLinkedInstall()) {
     ctx.ui.notify(
      "Linked install detected — restart your host app to pick up changes (no update needed).",
      "info",
     );
    } else {
     try {
      ctx.ui.notify("Checking for updates…", "info");
      let latest: string | null = null;
      try {
       latest = await fetchLatestVersion();
      } catch {
       latest = null;
      }
      if (!latest) {
       const cached = getCachedUpdate();
       if (cached && typeof cached.latest === "string") {
        latest = cached.latest;
       }
      }
      if (!latest) {
       ctx.ui.notify("Could not check latest version (offline?)", "warning");
      } else {
       const local = getLocalVersion();
       // Null local (unreadable package.json) can never prove up-to-date: run.
       const cmp = local === null ? 1 : compareVersions(latest, local);
       if (cmp <= 0) {
        ctx.ui.notify(`Already on latest (v${local})`, "info");
       } else {
        ctx.ui.notify(`Update available: v${local ?? "unknown"} → v${latest} — updating…`, "info");
        // Host plugin managers first (neither host has an `update` action for
        // registry plugins: omp updates by reinstall, pi updates the named
        // package). Global npm/bun is the last resort, not the default.
        let code = 1;
        let manual = "npm i -g pi-freeflow@latest";
        let lastStep = "";
        for (const step of selectHostUpdateSteps({
         ompAvailable: isCommandAvailable("omp"),
         piAvailable: isCommandAvailable("pi"),
        })) {
         if (lastStep !== "") ctx.ui.notify(`${lastStep} exited ${code} — trying ${step.manual}…`, "info");
         code = await updateStepRunner(step.cmd, step.args, ctx);
         manual = step.manual;
         lastStep = step.manual;
         if (code === 0) break;
        }
        if (code !== 0) {
         const plan = selectGlobalUpdatePlan({
          npmAvailable: isCommandAvailable("npm"),
          bunAvailable: isCommandAvailable("bun"),
         });
         if (plan !== null) {
          ctx.ui.notify(
           `${lastStep === "" ? "no host plugin manager found" : `${lastStep} exited ${code}`} — trying ${plan.manual}…`,
           "info",
          );
          manual = plan.manual;
          code = await updateStepRunner(plan.cmd, plan.args, ctx);
         }
        }
        if (code === 0) {
         // Restart the daemon that is actually attached — a walked port must
         // not leave the old build serving after a successful update.
         try { await attachedPortKiller(attachedPortResolver()); } catch { }
         try { await daemonEnsurer(); } catch { }
         ctx.ui.notify(`Updated to ${latest} and restarted proxy daemon`, "info");
        } else {
         ctx.ui.notify(
          `Update failed (exit ${code}) — try manually: ${manual}`,
          "warning",
         );
        }
       }
      }
     } catch (e) {
      ctx.ui.notify(`Update failed: ${(e as Error).message} — try manually: npm i -g pi-freeflow@latest`, "warning");
     }
    }
   } else if (sub === "debug") {
    const arg = rest.trim().toLowerCase();
    if (arg === "on" || arg === "enable" || arg === "true") {
     saveDebugState({ debug: true });
     ctx.ui.notify(
      "🔍 Debug ON — verbose trace enabled (level=debug). Logs now include request IDs, thinking sniffing, and payload normalize details.",
      "info",
     );
    } else if (
     arg === "off" ||
     arg === "disable" ||
     arg === "false"
    ) {
     saveDebugState({ debug: false });
     ctx.ui.notify(
      `🔇 Debug OFF — level restored to info. File: ${DEBUG_STATE_FILE}`,
      "info",
     );
    } else if (arg.startsWith("level")) {
     const lvl = arg.split(/\s+/)[1];
     // Allowlist only levels that actually have emitters (isEmittedLogLevel).
     // 'audit' exists in LOG_LEVEL_ORDER but nothing ever logs at it, so
     // accepting it here silently suppressed ALL log output until reset.
     if (lvl && isEmittedLogLevel(lvl)) {
      saveDebugState({ debug: false, level: lvl });
      ctx.ui.notify(
       `Log level set to ${lvl} (persisted to ${DEBUG_STATE_FILE})`,
       "info",
      );
     } else {
      ctx.ui.notify(
       `Unknown level: ${lvl} (use debug/info/warn/error)`,
       "warning",
      );
     }
    } else {
     const st = loadDebugState();
     const minLevel = getMinLogLevel();
     // Report the level the logger actually filters at, not the raw fields: a
     // fresh install (no state file) and FREEFLOW_DEBUG=1 both run at debug
     // without either being persisted anywhere.
     const effective =
      (Object.keys(LOG_LEVEL_ORDER) as LogLevel[]).find(
       (level) => LOG_LEVEL_ORDER[level] === minLevel,
      ) ?? "info";
     const cur = st?.debug ? "debug (ON)" : effective;
     ctx.ui.notify(
      `Debug status: ${cur}\nFile: ${DEBUG_STATE_FILE}\nMinLevel: ${minLevel} | isDebug=${isDebugEnabled()}\nUsage: /freeflow debug on|off | /freeflow debug level debug`,
      "info",
     );
    }
   } else if (sub === "logs" || sub === "log" || sub === "trace") {
    try {
     const rawRest = rest.trim();
     let filterLevel: LogLevel | null = null;
     let filterReqId: string | null = null;
     let filterText: string | null = null;
     let expectRelay = false;
     let count = 25;
     const rawTokens = rawRest ? rawRest.split(/\s+/) : [];
     const isFollow = rawTokens.includes("--follow") || rawTokens.includes("-f");
     if (!isFollow) {
      stopLogsFollow();
     }
     if (sub === "trace" && rawRest) {
      filterReqId = rawTokens.filter((t) => t !== "--follow" && t !== "-f")[0] || null;
     } else if (rawRest) {
      for (const t of rawTokens) {
       if (t === "--follow" || t === "-f") continue;
       const lower = t.toLowerCase();
       if (expectRelay) {
        filterText = t;
        expectRelay = false;
        continue;
       }
       if (t === "relay") {
        expectRelay = true;
        continue;
       }
       // `lower in LOG_LEVEL_ORDER` also matches Object.prototype keys
       // (toString, constructor…), so a text token walked the prototype chain
       // and became an unknown level filter. Only emitted levels are levels.
       if (isEmittedLogLevel(lower)) {
        filterLevel = lower;
       } else if (/^\d+$/.test(t)) {
        count = Math.min(
         200,
         Math.max(5, Number.parseInt(t, 10)),
        );
       } else if (
        /^[a-f0-9]{6,8}$/i.test(t) ||
        t.startsWith("req=")
       ) {
        filterReqId = t.replace(/^req=/, "");
       } else if (lower === "trace" || lower === "req") {
        continue;
       } else {
        // Unrecognized token: an invalid level must default to info,
        // not silently become a request-id filter.
        filterLevel = filterLevel ?? "info";
       }
      }
     }

     const result = readRecentLogs(
      filterLevel,
      filterReqId,
      count,
      filterText,
     );
     if (result.lines.length === 0) {
      if (result.totalLines === 0) {
       ctx.ui.notify(
        "Log file is empty (no logs yet)",
        "info",
       );
      } else {
       ctx.ui.notify(
        `No logs matched (level=${filterLevel || "any"} reqId=${filterReqId || "any"} text=${filterText || "any"} count=${count})`,
        "warning",
       );
      }
      if (isFollow) {
       startLogsFollow(
        ctx,
        filterLevel,
        filterReqId,
        filterText,
       );
      }
      return;
     }

     const header = `pi-freeflow logs (last ${result.lines.length}/${result.totalMatched} matched, total ${result.totalLines} lines, file: ${LOG_FILE}${filterLevel ? ` level=${filterLevel}` : ""}${filterReqId ? ` req=${filterReqId}` : ""}${filterText ? ` text=${filterText}` : ""}):`;
     ctx.ui.notify(
      `${header}\n\n${result.lines.join("\n")}`,
      "info",
     );
     if (isFollow) {
      startLogsFollow(
       ctx,
       filterLevel,
       filterReqId,
       filterText,
      );
     }
    } catch (e) {
     ctx.ui.notify(
      `Could not read log file: ${(e as Error).message}`,
      "error",
     );
    }
   } else if (
    sub === "refresh" ||
    sub === "reload" ||
    sub === "models"
   ) {
    ctx.ui.notify(
     "Refreshing model catalog from live upstreams…",
     "info",
    );
    const updated = await refreshCatalog(true);
    setAliveCatalog(updated);
    resetUpstreamGate("zen");
    persist();
    onCatalogRefreshed?.(updated);
    ctx.ui.notify(
     `✓ Refreshed ${updated.length} models with full-spec metadata (upstream health reset)!`,
     "info",
    );
   } else if (sub === "test") {
    const tokens = rest.trim() ? rest.trim().split(/\s+/) : [];
    let target: string | undefined;
    let chatMode = false;
    for (const t of tokens) {
     if (t === "--chat") {
      chatMode = true;
     } else if (t.startsWith("--")) {
      ctx.ui.notify(`Unknown flag ${t} — usage: /freeflow test [target|opencode] [--chat]`, "warning");
      return;
     } else if (target === undefined) {
      target = t;
     }
    }

    const isDirect = target !== undefined && (target.toLowerCase() === "opencode" || target.toLowerCase() === "direct");
    if (isDirect) {
     ctx.ui.notify(`Testing OpenCode upstream endpoint${chatMode ? " (chat probe)" : ""}…`, "info");
     const probe = await probeRelay("https://opencode.ai", undefined, {
      endpoint: chatMode ? "chat" : "models",
     });
     if (probe.ok) {
      ctx.ui.notify(`✓ OpenCode endpoint ok (HTTP ${probe.status}, ${probe.latencyMs}ms)`, "info");
     } else {
      ctx.ui.notify(`✗ OpenCode endpoint failed: ${probe.error || `HTTP ${probe.status}`}`, "error");
     }
     return;
    }

    if (!target) {
     if (relayState.url) {
      target = relayState.url;
     } else if (relayState.relays && relayState.relays.length > 0) {
      target = relayState.relays[0].url;
     } else {
      ctx.ui.notify(`Testing OpenCode upstream endpoint${chatMode ? " (chat probe)" : ""}…`, "info");
      const probe = await probeRelay("https://opencode.ai", undefined, {
       endpoint: chatMode ? "chat" : "models",
      });
      if (probe.ok) {
       ctx.ui.notify(`✓ OpenCode endpoint ok (HTTP ${probe.status}, ${probe.latencyMs}ms)`, "info");
      } else {
       ctx.ui.notify(`✗ OpenCode endpoint failed: ${probe.error || `HTTP ${probe.status}`}`, "error");
      }
      return;
     }
    }

    const matched = findRelay(relayState, target);
    if (!matched) {
     ctx.ui.notify(`Relay '${target}' not in saved list`, "warning");
     return;
    }
    ctx.ui.notify(`Testing ${matched.url}${chatMode ? " (chat probe)" : ""}…`, "info");
    const probe = await probeRelay(matched.url, matched.auth, {
     endpoint: chatMode ? "chat" : "models",
    });
    if (probe.ok) {
     ctx.ui.notify(`✓ ${shortRelayLabel(matched.url, relayState.relays)} ok (HTTP ${probe.status}, ${probe.latencyMs}ms)`, "info");
    } else {
     ctx.ui.notify(`✗ ${shortRelayLabel(matched.url, relayState.relays)} failed: ${probe.error || `HTTP ${probe.status}`}`, "error");
    }
   } else if (sub === "deploy") {
    if (!rest.trim()) {
     const choice = await ctx.ui.select(
      "Deploy relay on",
      Object.keys(DEPLOY_OPTIONS),
     );
     if (choice) await doDeploy(DEPLOY_OPTIONS[choice]);
    } else {
     const pf = parseDeployPlatform(rest);
     if (!pf) {
      ctx.ui.notify(
       "Unknown platform. Use: cloudflare | deno | vercel (for self-hosted VPS, see https://github.com/trefeon/warp-relay-pool)",
       "warning",
      );
     } else {
      await doDeploy(pf);
     }
    }
   } else {
    await showRelayInteractiveMenu(ctx, { rest, updateStatusBar, doDeploy });
   }
  },
 };
}
