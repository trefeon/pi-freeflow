/**
 * Interactive CLI slash commands and status bar manager for pi-freeflow
 *
 * log viewing, debug level configuration, and live catalog refreshing.
 */

import { spawn } from "node:child_process";
import { getClientPort } from "./client.ts";
import { refreshCatalog, setAliveCatalog } from "./catalog.ts";
import { DEBUG_STATE_FILE, HOST, LOG_FILE, PORT, RELAY_STATE_FILE } from "./config.ts";
import {
	compareVersions,
	fetchLatestVersion,
	getCachedUpdate,
	isLinkedInstall,
	getLocalVersion,
} from "./update-checker.ts";
import {
	deployCloudflareWorker,
	deployDenoRelay,
	deployVercelRelay,
	type DeployPlatform,
} from "./deploy.ts";
import {
	LOG_LEVEL_ORDER,
	getMinLogLevel,
	isDebugEnabled,
	loadDebugState,
	readRecentLogs,
	saveDebugState,
} from "./logger.ts";
import { probeRelay } from "./probe.ts";
import {
	ensureRelay,
	findRelay,
	getActiveRelayState,
	getRelayHealth,
	removeRelay,
	setActiveRelayState,
	setRelayLabel,
	setStatusUi,
	shortRelayLabel,
	withRelayState,
	formatRelayFlash,
	formatRelayPickerItem,
	formatRelayStatusLabel,
} from "./relay-state.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	KnownRelay,
	LogLevel,
	RegisteredCommand,
	RegisteredModel,
	RelayState,
} from "./types.ts";

/**
 * Update the TUI status bar widget with active relay state.
 */
export function updateStatusBar(ui?: ExtensionUIContext): void {
	if (!ui) return;
	ui.setStatus("freeflow", formatRelayStatusLabel(getActiveRelayState()) ?? undefined);
}

function spawnWithProgress(
	cmd: string,
	args: string[],
	ctx: ExtensionContext,
): Promise<number> {
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, {
				shell: process.platform === "win32",
				stdio: "pipe",
			});
			child.stdout?.on("data", (d: Buffer) => {
				const s = String(d).trim();
				if (s) ctx.ui.notify(s, "info");
			});
			child.stderr?.on("data", (d: Buffer) => {
				const s = String(d).trim();
				if (s) ctx.ui.notify(s, "info");
			});
			child.on("error", (err: Error) => {
				ctx.ui.notify(`spawn ${cmd} failed: ${err.message}`, "warning");
				resolve(1);
			});
			child.on("close", (code: number | null) => resolve(code ?? 0));
		} catch (e) {
			ctx.ui.notify(`spawn ${cmd} failed: ${(e as Error).message}`, "warning");
			resolve(1);
		}
	});
}

/**
 * Follow-mode log poller: tracks the count of matched lines already printed
 * and notifies only lines beyond it, so repeated ticks never re-notify the
 * same tail. One poller at a time — a re-run clears the previous interval.
 */
let logsFollowTimer: NodeJS.Timeout | null = null;
function startLogsFollow(
	ctx: ExtensionContext,
	filterLevel: LogLevel | null,
	filterReqId: string | null,
	count: number,
	filterText: string | null,
	baselineMatched: number,
): void {
	if (logsFollowTimer) {
		clearInterval(logsFollowTimer);
		logsFollowTimer = null;
	}
	let lastPrinted = baselineMatched;
	logsFollowTimer = setInterval(() => {
		try {
			const tail = readRecentLogs(filterLevel, filterReqId, count, filterText);
			if (tail.totalMatched < lastPrinted) {
				// Log rotated/rewritten below the baseline — re-baseline silently.
				lastPrinted = tail.totalMatched;
				return;
			}
			const newCount = tail.totalMatched - lastPrinted;
			if (newCount <= 0) return;
			const newLines = tail.lines.slice(
				tail.lines.length - Math.min(newCount, tail.lines.length),
			);
			if (newLines.length > 0) {
				ctx.ui.notify(newLines.join("\n"), "info");
			}
			lastPrinted = tail.totalMatched;
		} catch {}
	}, 1000);
	// @ts-ignore allow unref to not block process exit in CLI
	logsFollowTimer.unref?.();
}

export function createCommandSpec(
	_pi: ExtensionAPI,
	onCatalogRefreshed?: (models: RegisteredModel[]) => void,
): Omit<RegisteredCommand, "name"> {
	return {
		description:
			"Relay egress: auto | on | off | hide | show | widget hide/show | status | add <URL> [name] | list | use <URL|name|index> [name] | label <target> <name> | remove <target> | test <target> | logs [level] [n] | debug on|off | refresh | update | deploy vercel | deploy cloudflare | deploy deno",
		getArgumentCompletions: (prefix: string) =>
			[
				"auto",
				"on",
				"off",
				"hide",
				"show",
				"widget hide",
				"widget show",
				"status",
				"add",
				"list",
				"use",
				"label",
				"rename",
				"remove",
				"test",
				"url",
				"deploy",
				"deploy vercel",
				"deploy cloudflare",
				"deploy deno",
				"refresh",
				"models",
				"logs",
				"debug",
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
			/** Re-apply an operation to the freshest on-disk state and persist it. */
			const applyRelayState = (
				updater: (s: RelayState) => RelayState,
			): RelayState => {
				relayState = withRelayState(updater);
				return relayState;
			};
			const setRelay = (
				enabled: boolean,
				url: string,
				addLabel?: string,
			) => {
				applyRelayState((s) => {
					s.enabled = enabled;
					const cleanUrl = (url || "").trim() || "";
					s.url = cleanUrl;
					if (cleanUrl) {
						ensureRelay(s, cleanUrl, addLabel);
					}
					return s;
				});
			};

			const addRelayInteractive = async () => {
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

				applyRelayState((s) => {
					const added = ensureRelay(s, inputUrl, inputLabel);
					s.enabled = true;
					s.url = added.url;
					return s;
				});
				persist();
				flash();
				ctx.ui.notify(
					`✓ Added & activated relay [${shortRelayLabel(relayState.url, relayState.relays)}]: ${relayState.url}`,
					"info",
				);
			};

			const editRelayLabelMenu = async () => {
				if (!relayState.relays.length) {
					ctx.ui.notify("No saved relays to rename", "warning");
					return;
				}
				const fmt = (r: KnownRelay, idx: number) =>
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
				applyRelayState((s) => {
					setRelayLabel(s, match.url, newLabel);
					return s;
				});
				persist();
				flash();
				ctx.ui.notify(
					`✓ Relay short name updated to [${newLabel}] for ${match.url}`,
					"info",
				);
			};

			const DEPLOY_OPTIONS: Record<string, DeployPlatform> = {
				"Vercel (1M req/mo — recommended)": "vercel",
				"Cloudflare (100k req/day)": "cloudflare",
				"Deno Deploy (100k req/day)": "deno",
			};

			const parseDeployPlatform = (raw?: string): DeployPlatform | null => {
				const v = (raw || "").trim().toLowerCase();
				if (!v || v === "vercel") return "vercel";
				if (v === "cloudflare" || v === "cf") return "cloudflare";
				if (v === "deno") return "deno";
				return null;
			};

			const doDeploy = async (platform: DeployPlatform = "vercel") => {
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
				const token = (
					await ctx.ui.input(`${label} API token:`, "")
				)?.trim();
				if (!token) {
					ctx.ui.notify("Deploy cancelled: no token", "warning");
					return;
				}
				const name =
					(
						await ctx.ui.input(
							"Project name (empty = auto):",
							defaultName,
						)
					)?.trim() || defaultName;

				if (typeof ctx.ui.confirm === "function") {
					const ok = await ctx.ui.confirm(
						"Deploy relay",
						`Deploy ${label} relay '${name}' using token ending ${token.slice(-4)}?`,
					);
					if (!ok) {
						ctx.ui.notify("Deploy cancelled", "warning");
						return;
					}
				}

				ctx.ui.setStatus("freeflow", `deploying ${platform} relay…`);
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
					relayState = withRelayState((s) => {
						const r = ensureRelay(s, url, `deployed ${name}`);
						r.auth = auth;
						s.enabled = true;
						s.url = url;
						return s;
					});
					persist();
					let probeNote = "";
					try {
						const probe = await probeRelay(url, auth);
						probeNote = probe.ok
							? ` ✓ reachable (HTTP ${probe.status}, ${probe.latencyMs}ms)`
							: ` ⚠ deployed but unreachable (${probe.error || `HTTP ${probe.status}`}) — verify with /freeflow test`;
					} catch {
						// probeRelay never throws, but keep the notify safe regardless
					}
					ctx.ui.notify(`✓ Deployed & active: ${url}${probeNote}`, "info");
				} catch (e) {
					updateStatusBar(ctx.ui);
					ctx.ui.notify(
						`Deploy failed: ${(e as Error).message}`,
						"error",
					);
				}
			};

			const switchRelay = async () => {
				if (!relayState.relays.length) {
					ctx.ui.notify("No saved relays yet", "warning");
					return;
				}
				const fmt = (r: KnownRelay, idx: number) => formatRelayPickerItem(r, idx, relayState.url);
				const opts = relayState.relays.map(fmt);
				const choice = await ctx.ui.select("Switch active relay", opts);
				if (!choice) return;
				const match = relayState.relays.find((r, idx) => fmt(r, idx) === choice);
				if (!match) return;
				applyRelayState((s) => {
					const fresh = s.relays.find((r) => r.url === match.url);
					if (!fresh) return s;
					s.enabled = true;
					s.url = fresh.url;
					return s;
				});
				persist();
				flash();
			};

			const showList = () => {
				if (!relayState.relays.length) {
					ctx.ui.notify("No saved relays (direct upstream mode)", "info");
					return;
				}
				const lines = relayState.relays.map((r, idx) => {
					const star = r.url === relayState.url ? "★" : " ";
					const shortName = r.label ? `[${r.label}]` : `[${shortRelayLabel(r.url, relayState.relays)}]`;
					const paddedName = shortName.padEnd(16, " ");
					const health = getRelayHealth(r.url);
					const isCooling = health && Date.now() < health.cooldownUntil;
					const remainingSec = isCooling ? Math.ceil((health.cooldownUntil - Date.now()) / 1000) : 0;
					const healthBadge = isCooling
						? ` ⚠️ [cooling ${remainingSec}s: ${health.lastStatus ? `HTTP ${health.lastStatus}` : "error"}]`
						: health?.lastLatencyMs != null && Number.isFinite(health.lastLatencyMs)
							? ` ✓ [${health.lastLatencyMs}ms]`
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
			};

			const removeRelayMenu = async () => {
				const removable = relayState.relays.filter(
					(r) => r.url !== relayState.url,
				);
				if (!removable.length) {
					ctx.ui.notify(
						"Nothing to remove — the active relay cannot be removed (switch first)",
						"warning",
					);
					return;
				}
				const fmt = (r: KnownRelay, idx: number) => formatRelayPickerItem(r, idx);
				const choice = await ctx.ui.select(
					"Remove relay",
					removable.map(fmt),
				);
				if (!choice) return;
				const match = removable.find((r, idx) => fmt(r, idx) === choice);
				if (!match) return;
				applyRelayState((s) => {
					removeRelay(s, match.url);
					return s;
				});
				persist();
				ctx.ui.notify(`Removed: [${shortRelayLabel(match.url, relayState.relays)}] ${match.url}`, "info");
			};

			if (sub === "auto") {
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
			} else if (sub === "off") {
				applyRelayState((s) => {
					s.mode = "off";
					s.enabled = false;
					return s;
				});
				persist();
				flash();
			} else if (sub === "hide" || (sub === "widget" && rest === "hide")) {
				applyRelayState((s) => ({ ...s, hideWidget: true }));
				persist();
				updateStatusBar(ctx.ui);
				ctx.ui.notify("Widget hidden — use /freeflow show or /freeflow widget show to restore", "info");
			} else if (sub === "show" || (sub === "widget" && rest === "show")) {
				applyRelayState((s) => ({ ...s, hideWidget: false }));
				persist();
				flash();
				ctx.ui.notify("Widget shown", "info");
			} else if (sub === "status") {
				flash();
				try {
					const local = getLocalVersion();
					let latest: string | null = null;
					const cached = getCachedUpdate();
					if (cached && typeof cached.latest === "string") {
						latest = cached.latest;
					}
					if (latest && compareVersions(latest, local) > 0) {
						ctx.ui.notify(
							`Update available: ${local} -> ${latest} - run /freeflow update`,
							"info",
						);
					}
				} catch {
					// swallow — status banner is best-effort
				}

				const modeLine =
					relayState.mode === "off"
						? "Mode: off (always direct)"
						: relayState.mode === "on"
							? "Mode: on (always relay)"
							: "Mode: auto (enabled on session, auto-rolls on 429/5xx)";
				const poolLine = `${relayState.relays.length} relay(s)${
					relayState.relays.length > 0
						? ` | active: ${shortRelayLabel(relayState.url, relayState.relays)}`
						: ""
				}`;
				const stateFileLine = `State file: ${RELAY_STATE_FILE}`;
				ctx.ui.notify(`${modeLine} | ${poolLine}\n${stateFileLine}`, "info");
			} else if (sub === "kill" || sub === "stop" || sub === "shutdown") {
				const port = getClientPort() || PORT;
				try {
					const res = await fetch(`http://${HOST}:${port}/_shutdown`, {
						method: "POST",
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
							const cmp = compareVersions(latest, local);
							if (cmp <= 0) {
								ctx.ui.notify(`Already on latest (v${local})`, "info");
							} else {
								ctx.ui.notify(`Update available: v${local} → v${latest} — updating…`, "info");
								let code = await spawnWithProgress("omp", ["plugin", "update", "pi-freeflow"], ctx);
								if (code !== 0) {
									ctx.ui.notify(`omp update exited ${code}, trying npm…`, "info");
									code = await spawnWithProgress("npm", ["i", "-g", "pi-freeflow@latest"], ctx);
								}
								if (code === 0) {
									ctx.ui.notify(`Updated to ${latest}, restart OMP`, "info");
								} else {
									ctx.ui.notify(
										`Update failed (exit ${code}) — try manually: npm i -g pi-freeflow@latest`,
										"warning",
									);
								}
							}
						}
					} catch (e) {
						ctx.ui.notify(`Update failed: ${(e as Error).message} — try manually: npm i -g pi-freeflow@latest`, "warning");
					}
				}
			} else if (sub === "list") {
				showList();
			} else if (sub === "add") {
				if (!rest.trim()) {
					await addRelayInteractive();
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
						return;
					}
					persist();
					flash();
					ctx.ui.notify(
						`✓ Added & activated relay [${shortRelayLabel(relayState.url, relayState.relays)}]: ${relayState.url}`,
						"info",
					);
				}
			} else if (sub === "use") {
				if (!rest.trim()) {
					await switchRelay();
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
						} catch {}
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
								return;
							}
							persist();
							flash();
						} else {
							ctx.ui.notify(`Relay '${targetToken}' not found in saved list`, "warning");
						}
					}
				}
			} else if (sub === "label" || sub === "rename") {
				if (!rest.trim()) {
					await editRelayLabelMenu();
				} else {
					const tokens = rest.trim().split(/\s+/);
					const targetToken = tokens[0];
					const newLabel = tokens.slice(1).join(" ").trim();
					const matched = findRelay(relayState, targetToken);
					if (!matched) {
						ctx.ui.notify(`Relay '${targetToken}' not found in saved list`, "warning");
						return;
					}
					let finalLabel = newLabel;
					if (!finalLabel) {
						finalLabel = (
							await ctx.ui.input(
								`New short name / alias for ${matched.url}:`,
								matched.label || shortRelayLabel(matched.url, relayState.relays),
							)
						)?.trim() || "";
					}
					applyRelayState((s) => {
						setRelayLabel(s, matched.url, finalLabel);
						return s;
					});
					persist();
					flash();
					ctx.ui.notify(
						`✓ Relay short name updated to [${shortRelayLabel(matched.url, relayState.relays)}] for ${matched.url}`,
						"info",
					);
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
					const lvl = arg.split(/\s+/)[1] as LogLevel | undefined;
					// Allowlist only levels that actually have emitters. 'audit' exists in
					// LOG_LEVEL_ORDER but nothing ever logs at it, so accepting it here
					// silently suppressed ALL log output until manually reset.
					const EMITTED_LEVELS: readonly LogLevel[] = [
						"debug",
						"info",
						"warn",
						"error",
					];
					if (
						lvl &&
						(EMITTED_LEVELS as readonly string[]).includes(lvl)
					) {
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
					const cur = st?.debug
						? "debug (ON)"
						: st?.level ||
							process.env.FREEFLOW_LOG_LEVEL ||
							"info";
					ctx.ui.notify(
						`Debug status: ${cur}\nFile: ${DEBUG_STATE_FILE}\nMinLevel: ${getMinLogLevel()} | isDebug=${isDebugEnabled()}\nUsage: /freeflow debug on|off | /freeflow debug level debug`,
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
							if (lower in LOG_LEVEL_ORDER) {
								filterLevel = lower as LogLevel;
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
								count,
								filterText,
								result.totalMatched,
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
							count,
							filterText,
							result.totalMatched,
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
				persist();
				onCatalogRefreshed?.(updated);
				ctx.ui.notify(
					`✓ Refreshed ${updated.length} models with full-spec metadata!`,
					"info",
				);
			} else if (sub === "remove") {
				if (!rest.trim()) {
					await removeRelayMenu();
				} else {
					const target = rest.trim();
					const matched = findRelay(relayState, target);
					if (!matched) {
						ctx.ui.notify(`Relay '${target}' not in saved list`, "warning");
						return;
					}
					if (matched.url === relayState.url) {
						ctx.ui.notify(
							"Cannot remove the active relay — switch to another relay first",
							"warning",
						);
						return;
					}
					applyRelayState((s) => {
						removeRelay(s, matched.url);
						return s;
					});
					persist();
					ctx.ui.notify(`Removed: [${shortRelayLabel(matched.url, relayState.relays)}] ${matched.url}`, "info");
				}
			} else if (sub === "test") {
				const target = rest.trim();
				const matched = findRelay(relayState, target);
				if (!matched) {
					ctx.ui.notify(`Relay '${target}' not in saved list`, "warning");
					return;
				}
				ctx.ui.notify(`Testing ${matched.url}…`, "info");
				const probe = await probeRelay(matched.url, matched.auth);
				if (probe.ok) {
					ctx.ui.notify(`✓ ${shortRelayLabel(matched.url, relayState.relays)} ok (HTTP ${probe.status}, ${probe.latencyMs}ms)`, "info");
				} else {
					ctx.ui.notify(`✗ ${shortRelayLabel(matched.url, relayState.relays)} failed: ${probe.error || `HTTP ${probe.status}`}`, "error");
				}
			} else if (sub === "url") {
				const input =
					rest ||
					(await ctx.ui.input(
						"Relay URL (empty = default):",
						relayState.url || "",
					));
				const cleanInput = (input || "").trim() || "";
				applyRelayState((s) => {
					s.url = cleanInput;
					if (cleanInput) {
						ensureRelay(s, cleanInput, shortRelayLabel(cleanInput, s.relays));
					}
					return s;
				});
				persist();
				flash();
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
							"Unknown platform. Use: vercel | cloudflare | deno",
							"warning",
						);
					} else {
						await doDeploy(pf);
					}
				}
			} else {
				const currentMode = (relayState.mode || "auto").toUpperCase();
				const activeLabel = shortRelayLabel(relayState.url, relayState.relays);
				const choice = await ctx.ui.select("freeflow relay", [
					`Mode: ${currentMode} (${relayState.enabled ? "ON" : "OFF"}) → ${activeLabel}`,
					"Add custom relay (URL + Short name)…",
					"Switch active relay…",
					"Rename / Set relay short name…",
					"Remove relay…",
					"List saved relays",
					"Deploy Vercel relay…",
					"Deploy Cloudflare relay…",
					"Deploy Deno relay…",
					"Mode: AUTO (auto-detect on model select)",
					"Mode: ON (always relay)",
					"Mode: OFF (always direct)",
				]);
				if (choice === `Mode: ${currentMode} (${relayState.enabled ? "ON" : "OFF"}) → ${activeLabel}`) {
					flash();
				} else if (choice === "Add custom relay (URL + Short name)…") {
					await addRelayInteractive();
				} else if (choice === "Switch active relay…") {
					await switchRelay();
				} else if (choice === "Rename / Set relay short name…") {
					await editRelayLabelMenu();
				} else if (choice === "Remove relay…") {
					await removeRelayMenu();
				} else if (choice === "List saved relays") {
					showList();
				} else if (choice === "Deploy Vercel relay…") {
					await doDeploy("vercel");
				} else if (choice === "Deploy Cloudflare relay…") {
					await doDeploy("cloudflare");
				} else if (choice === "Deploy Deno relay…") {
					await doDeploy("deno");
				} else if (choice === "Mode: AUTO (auto-detect on model select)") {
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
				} else if (choice === "Mode: ON (always relay)") {
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
				}
			}
		},
	};
}
