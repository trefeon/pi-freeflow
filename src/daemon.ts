/**
 * Detached proxy daemon entry for pi-freeflow.
 *
 * Spawned as a separate OS process by src/client.ts so the local proxy survives
 * the OMP/Pi session that started it. Owns port 28180, serves the proxy plus
 * the client lease/control endpoints, and retires itself once no client holds
 * a live lease and no request has been proxied recently.
 *
 * Run directly: `node --experimental-strip-types src/daemon.ts` (or `bun src/daemon.ts`).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DAEMON_GC_MS,
	DAEMON_GRACE_MS,
	DAEMON_TTL_MS,
	HOST,
	PKG_VERSION,
	PORT,
} from "./config.ts";
import { setShutdownShouldExit } from "./proxy.ts";
import {
	getAliveCatalog,
	readCatalogCache,
	refreshCatalog,
	setAliveCatalog,
} from "./catalog.ts";
import { log, logInfo, logWarn } from "./logger.ts";
import {
	startLeaseGC,
	stopLeaseGC,
	touchActivity,
} from "./lease.ts";
import { getActiveRequests, startProxy } from "./proxy.ts";
import { loadRelayState, setActiveRelayState } from "./relay-state.ts";

/** True when this module was run as the entry script (not imported by tests). */
export function isDaemonMain(): boolean {
	try {
		const entry = process.argv[1];
		if (!entry) return false;
		return path.resolve(entry) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

/**
 * Load the on-disk relay state into this process's in-memory cache so routing
 * uses the latest client edits without a daemon restart. Non-fatal on failure.
 */
export function syncRelayStateFromDisk(): void {
	try {
		setActiveRelayState(loadRelayState(), false);
	} catch (e) {
		log("warn", "daemon failed to load relay state from disk", { error: String(e) });
	}
}

/**
 * Serve the static+disk catalog and refresh it in the background, mirroring
 * what the host session did in-process. Keeps /v1/models correct after the
 * 24h cache TTL without requiring a daemon restart.
 */
export async function seedCatalog(): Promise<void> {
	const cached = readCatalogCache();
	if (cached && Array.isArray(cached.models) && cached.models.length > 0) {
		setAliveCatalog(cached.models);
	}
	try {
		const fresh = await refreshCatalog(false);
		if (fresh.length > 0) {
			setAliveCatalog(fresh);
		}
	} catch (e) {
		logWarn("daemon catalog refresh failed; retaining cached catalog", {
			error: String(e),
		});
	}
	logInfo(`daemon catalog ready: ${getAliveCatalog().length} models`);
}

/**
 * Boot the detached proxy daemon. Binds the port, seeds catalog + relay state,
 * starts the lease GC, and installs signal handlers so the daemon exits
 * cleanly on SIGTERM/SIGINT (e.g. /freeflow kill, taskkill, Ctrl+C).
 */
export async function runDaemon(): Promise<void> {
	let server: { close(): void } | null = null;
	const retire = (why: string): void => {
		logInfo(`daemon retiring: ${why}`);
		stopLeaseGC();
		try {
			server?.close();
		} catch {}
		process.exit(0);
	};
	process.on("SIGTERM", () => retire("SIGTERM"));
	process.on("SIGINT", () => retire("SIGINT"));
	setShutdownShouldExit(true);
	try {
		const r = await startProxy();
		if (!r.server) {
			// Port was taken by another (possibly newer) daemon — the parent
			// attaches to the winner; this spawn exits quietly.
			logInfo(`daemon found an existing proxy on http://${HOST}:${r.port} — exiting`);
			process.exit(0);
		}
		server = r.server;
	} catch (e) {
		log("error", "daemon failed to bind proxy port", { error: String(e) });
		process.exit(1);
	}

	// lastActivityAt is initialized AT BIND TIME: a freshly started daemon with
	// zero leases must never be GC'd during the parent's readiness-poll window.
	touchActivity();
	syncRelayStateFromDisk();
	void seedCatalog();

	startLeaseGC({
		ttlMs: DAEMON_TTL_MS,
		gcMs: DAEMON_GC_MS,
		graceMs: DAEMON_GRACE_MS,
		getActiveRequests,
		onIdle: () => retire("no clients and idle"),
	});

	logInfo(`pi-freeflow daemon v${PKG_VERSION} listening on http://${HOST}:${PORT}`);
}

// Entry guard: run only when executed as the entry script. When imported by
// tests, isDaemonMain() is false and no port is bound.
if (isDaemonMain()) {
	runDaemon().catch((e) => {
		log("error", "daemon crashed", { error: String(e) });
		process.exit(1);
	});
}
