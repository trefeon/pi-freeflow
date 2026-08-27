import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_CACHE_FILE, UPDATE_CHECK_TTL_MS } from "./config.ts";
import { logInfo } from "./logger.ts";
import type { ExtensionUIContext } from "./types.ts";
const REGISTRY_URL = "https://registry.npmjs.org/pi-freeflow/latest";
export interface UpdateCacheData {
	latest: string;
	checkedAt: number;
}

/**
 * Detect a LINK install by checking whether the published extension entry is a
 * symlink. `omp plugin link <path>` creates a symlink at extensions/index.ts
 * pointing at the dev checkout — when that link exists we skip the update check.
 */
export function isLinkedInstall(): boolean {
	try {
		const thisDir = path.dirname(fileURLToPath(import.meta.url));
		const entry = path.join(thisDir, "..", "extensions", "index.ts");
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
	try {
		const dir = path.dirname(UPDATE_CACHE_FILE);
		mkdirSync(dir, { recursive: true });
		const data: UpdateCacheData = { latest, checkedAt: Date.now() };
		writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
	} catch {
		// swallow — cache is best-effort
	}
}

export async function fetchLatestVersion(): Promise<string | null> {
	try {
		const res = await fetch(REGISTRY_URL, {
			signal: AbortSignal.timeout(3000),
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { version?: string };
		const v = json?.version;
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
		return null;
	} catch {
		return null;
	}
}

/**
 * Simple semver compare: split on '.' and compare numeric segments.
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
	try {
		const pa = a.split(".").map((s) => Number(s) || 0);
		const pb = b.split(".").map((s) => Number(s) || 0);
		const len = Math.max(pa.length, pb.length);
		for (let i = 0; i < len; i++) {
			const da = pa[i] ?? 0;
			const db = pb[i] ?? 0;
			if (da !== db) return da - db;
		}
		return 0;
	} catch {
		return 0;
	}
}

function getLocalVersion(): string | null {
	try {
		const thisDir = path.dirname(fileURLToPath(import.meta.url));
		const pkgPath = path.join(thisDir, "..", "package.json");
		const raw = readFileSync(pkgPath, "utf8");
		const pkg = JSON.parse(raw) as { version?: string };
		if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
			return pkg.version.trim();
		}
		return null;
	} catch {
		return null;
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
						logInfo(`pi-freeflow update available: ${local} -> ${latest} (run /freeflow update)`);
						const targetUi = ui ?? null;
						if (targetUi?.setStatus) {
							try { targetUi.setStatus("freeflow", `update: ${local} → ${latest}`); } catch {}
						} else {
							try {
								const { getStatusUi } = require("./relay-state.ts") as { getStatusUi: () => ExtensionUIContext | null };
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
