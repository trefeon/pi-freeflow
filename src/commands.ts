/**
 * Interactive CLI slash commands and status bar manager for pi-freeflow
 *
 * log viewing, debug level configuration, and live catalog refreshing.
 */

import { refreshCatalog, setAliveCatalog } from "./catalog.ts";
import { DEBUG_STATE_FILE, DEFAULT_RELAY_URL, LOG_FILE } from "./config.ts";
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
import {
	ensureRelay,
	findRelay,
	getActiveRelayState,
	getRelayHealth,
	isRelayHealthy,
	removeRelay,
	saveRelayState,
	setActiveRelayState,
	setRelayLabel,
	setStatusUi,
	shortRelayLabel,
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
	const relayState = getActiveRelayState();
	if (relayState.enabled && relayState.relays.length > 0) {
		const label = shortRelayLabel(relayState.url);
		const idx = Math.max(
			1,
			relayState.relays.findIndex((r) => r.url === relayState.url) + 1,
		);
		const total = relayState.relays.length;
		const modeLabel = relayState.mode === "on" ? "ON" : "AUTO (ON)";
		ui.setStatus("freeflow", `relay: ${modeLabel} | ${label} ${idx}/${total}`);
	} else if (relayState.mode === "off" || !relayState.enabled) {
		ui.setStatus("freeflow", "relay: OFF (direct)");
	} else {
		ui.setStatus("freeflow", undefined);
	}
}

export function createCommandSpec(
	_pi: ExtensionAPI,
	onCatalogRefreshed?: (models: RegisteredModel[]) => void,
): Omit<RegisteredCommand, "name"> {
	return {
		description:
			"Relay egress: auto | on | off | status | add <URL> [name] | list | use <URL|name|index> [name] | label <target> <name> | remove <target> | logs [level] [n] | debug on|off | refresh | deploy vercel | deploy cloudflare | deploy deno",
		getArgumentCompletions: (prefix: string) =>
			[
				"auto",
				"on",
				"off",
				"status",
				"add",
				"list",
				"use",
				"label",
				"rename",
				"remove",
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
			const relayState = getActiveRelayState();

			const flash = () => {
				const activeLabel = shortRelayLabel(relayState.url, relayState.relays);
				const activeIdx = Math.max(
					1,
					relayState.relays.findIndex((r) => r.url === relayState.url) + 1,
				);
				const total = relayState.relays.length || 1;
				const modeStr = (relayState.mode || "auto").toUpperCase();
				ctx.ui.notify(
					`Relay mode: ${modeStr} (${relayState.enabled ? "ON" : "OFF"})${relayState.enabled ? ` → ${activeLabel} (${activeIdx}/${total})` : " (direct)"} | saved=${relayState.relays.length} (auto-fallback rolling)`,
					"info",
				);
			};

			const persist = () => {
				setActiveRelayState(relayState, true);
				setStatusUi(ctx.ui);
				updateStatusBar(ctx.ui);
			};
			const setRelay = (
				enabled: boolean,
				url: string,
				addLabel?: string,
			) => {
				relayState.enabled = enabled;
				const cleanUrl = (url || "").trim() || DEFAULT_RELAY_URL;
				relayState.url = cleanUrl;
				if (cleanUrl) {
					ensureRelay(relayState, cleanUrl, addLabel);
				}
				setActiveRelayState(relayState);
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

				const added = ensureRelay(relayState, inputUrl, inputLabel);
				setRelay(true, added.url, added.label);
				persist();
				flash();
				ctx.ui.notify(
					`✓ Added & activated relay [${added.label || shortRelayLabel(added.url)}]: ${added.url}`,
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
				setRelayLabel(relayState, match.url, newLabel);
				persist();
				flash();
				ctx.ui.notify(
					`✓ Relay short name updated to [${newLabel}] for ${match.url}`,
					"info",
				);
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

				ctx.ui.setStatus("freeflow", `deploying ${platform} relay…`);
				try {
					const deployer =
						platform === "cloudflare"
							? deployCloudflareWorker
							: platform === "deno"
								? deployDenoRelay
								: deployVercelRelay;
					const url = await deployer(token, name, (m) =>
						ctx.ui.notify(m, "info"),
					);
					setRelay(true, url, `deployed ${name}`);
					persist();
					ctx.ui.notify(`✓ Deployed & active: ${url}`, "info");
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
				const fmt = (r: KnownRelay, idx: number) => {
					const isAct = r.url === relayState.url ? "★ " : "  ";
					const lbl = r.label ? `[${r.label}] ` : `[${shortRelayLabel(r.url, relayState.relays)}] `;
					return `${isAct}[${idx + 1}] ${lbl}→ ${r.url}`;
				};
				const opts = relayState.relays.map(fmt);
				const choice = await ctx.ui.select("Switch active relay", opts);
				if (!choice) return;
				const match = relayState.relays.find((r, idx) => fmt(r, idx) === choice);
				if (!match) return;
				setRelay(true, match.url, match.label);
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
						: " ✓";
					return `${star} [${idx + 1}] ${paddedName} → ${r.url}${healthBadge}`;
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
				const fmt = (r: KnownRelay, idx: number) => {
					const lbl = r.label ? `[${r.label}] ` : `[${shortRelayLabel(r.url, relayState.relays)}] `;
					return `[${idx + 1}] ${lbl}→ ${r.url}`;
				};
				const choice = await ctx.ui.select(
					"Remove relay",
					removable.map(fmt),
				);
				if (!choice) return;
				const match = removable.find((r, idx) => fmt(r, idx) === choice);
				if (!match) return;
				removeRelay(relayState, match.url);
				persist();
				ctx.ui.notify(`Removed: [${shortRelayLabel(match.url, relayState.relays)}] ${match.url}`, "info");
			};

			if (sub === "auto") {
				relayState.mode = "auto";
				relayState.enabled = true;
				setRelay(true, relayState.url || DEFAULT_RELAY_URL);
				persist();
				flash();
			} else if (sub === "on") {
				relayState.mode = "on";
				setRelay(true, relayState.url || DEFAULT_RELAY_URL);
				persist();
				flash();
			} else if (sub === "off") {
				relayState.mode = "off";
				relayState.enabled = false;
				setActiveRelayState(relayState);
				persist();
				flash();
			} else if (sub === "status") {
				flash();
			} else if (sub === "list") {
				showList();
			} else if (sub === "add") {
				if (!rest.trim()) {
					await addRelayInteractive();
				} else {
					const tokens = rest.trim().split(/\s+/);
					const targetUrl = tokens[0];
					const customLabel = tokens.slice(1).join(" ").trim() || undefined;
					const added = ensureRelay(relayState, targetUrl, customLabel);
					setRelay(true, added.url, added.label);
					persist();
					flash();
					ctx.ui.notify(
						`✓ Added & activated relay [${added.label || shortRelayLabel(added.url)}]: ${added.url}`,
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
						if (customLabel) {
							matched.label = customLabel;
						}
						setRelay(true, matched.url, matched.label);
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
							const added = ensureRelay(relayState, targetToken, customLabel);
							setRelay(true, added.url, added.label);
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
					setRelayLabel(relayState, matched.url, finalLabel);
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
					let count = 25;

					if (sub === "trace" && rawRest) {
						filterReqId = rawRest.split(/\s+/)[0];
					} else if (rawRest) {
						const tokens = rawRest.split(/\s+/);
						for (const t of tokens) {
							const lower = t.toLowerCase();
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
								filterReqId = t;
							}
						}
					}

					const result = readRecentLogs(
						filterLevel,
						filterReqId,
						count,
					);
					if (result.lines.length === 0) {
						if (result.totalLines === 0) {
							ctx.ui.notify(
								"Log file is empty (no logs yet)",
								"info",
							);
						} else {
							ctx.ui.notify(
								`No logs matched (level=${filterLevel || "any"} reqId=${filterReqId || "any"} count=${count})`,
								"warning",
							);
						}
						return;
					}

					const header = `pi-freeflow logs (last ${result.lines.length}/${result.totalMatched} matched, total ${result.totalLines} lines, file: ${LOG_FILE}${filterLevel ? ` level=${filterLevel}` : ""}${filterReqId ? ` req=${filterReqId}` : ""}):`;
					ctx.ui.notify(
						`${header}\n\n${result.lines.join("\n")}`,
						"info",
					);
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
					removeRelay(relayState, matched.url);
					persist();
					ctx.ui.notify(`Removed: [${shortRelayLabel(matched.url, relayState.relays)}] ${matched.url}`, "info");
				}
			} else if (sub === "url") {
				const input =
					rest ||
					(await ctx.ui.input(
						"Relay URL (empty = default):",
						relayState.url || DEFAULT_RELAY_URL,
					));
				const cleanInput = (input || "").trim() || DEFAULT_RELAY_URL;
				setRelay(
					relayState.enabled,
					cleanInput,
					shortRelayLabel(cleanInput, relayState.relays),
				);
				persist();
				flash();
			} else if (sub === "deploy") {
				const pf = parseDeployPlatform(rest);
				if (!pf) {
					ctx.ui.notify(
						"Unknown platform. Use: vercel | cloudflare | deno",
						"warning",
					);
				} else {
					await doDeploy(pf);
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
					relayState.mode = "auto";
					relayState.enabled = true;
					setRelay(true, relayState.url || DEFAULT_RELAY_URL);
					persist();
					flash();
				} else if (choice === "Mode: ON (always relay)") {
					relayState.mode = "on";
					setRelay(true, relayState.url || DEFAULT_RELAY_URL);
					persist();
					flash();
				} else if (choice === "Mode: OFF (always direct)") {
					relayState.mode = "off";
					relayState.enabled = false;
					setActiveRelayState(relayState);
					persist();
					flash();
				}
			}
		},
	};
}
