/**
 * Shared sandbox-file isolation for user-flow / lifecycle style tests.
 *
 * Operates ONLY on paths from src/config.ts, which test/setup.mjs already
 * re-rooted into a fresh temp data dir — these helpers never touch real user
 * files. Each test snapshots the sandbox files it may write, runs, then
 * restores them, so tests stay isolated from each other within the shared
 * per-run sandbox.
 */
import fs from "node:fs";
import {
	RELAY_STATE_FILE,
	ONBOARDED_FLAG_FILE,
	LOG_FILE,
	UPDATE_CACHE_FILE,
	DEBUG_STATE_FILE,
	CATALOG_CACHE_FILE,
	resolveSessionPinPath,
} from "../src/config.ts";

export const BAK_FILE = `${RELAY_STATE_FILE}.bak`;
const LOCK_FILE = `${RELAY_STATE_FILE}.lock`;
/** Every sandbox file these tests may write; backed up/restored around a test. */
const TOUCHED = [
	RELAY_STATE_FILE,
	BAK_FILE,
	LOCK_FILE,
	ONBOARDED_FLAG_FILE,
	LOG_FILE,
	UPDATE_CACHE_FILE,
	DEBUG_STATE_FILE,
	CATALOG_CACHE_FILE,
	resolveSessionPinPath(),
];

export function clearSandboxFiles(): void {
	for (const p of TOUCHED) {
		try {
			fs.rmSync(p, { force: true });
		} catch {}
	}
	// Log/state tmp + rotated archives too (best-effort).
	for (const p of [`${DEBUG_STATE_FILE}.tmp`, `${LOG_FILE}.1`, `${LOG_FILE}.2`, `${LOG_FILE}.3`]) {
		try {
			fs.rmSync(p, { force: true });
		} catch {}
	}
}

export async function withIsolatedSandboxFiles(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const before = TOUCHED.map((p) => [p, read(p)] as const);
	try {
		await fn();
	} finally {
		for (const [p, content] of before) {
			try {
				if (content !== null) {
					fs.writeFileSync(p, content, "utf8");
				} else {
					fs.rmSync(p, { force: true });
				}
			} catch {}
		}
	}
}

export interface IsolatedRelayFilesOptions {
	/** Also snapshot/restore the relay state LOCK file (cross-process writer tests). */
	lock?: boolean;
	/** Also snapshot/restore the session pin mirror (resolveSessionPinPath()). */
	pin?: boolean;
	/** Extra cleanup after the disk restore (in-memory state, dispatcher close). May be async. */
	onRestore?: () => void | Promise<void>;
}

/**
 * Snapshot RELAY_STATE_FILE + BAK_FILE (plus the relay LOCK file and/or the
 * session pin mirror when asked) before `fn` runs, then put every snapshot back
 * in a finally: the same bytes when the file existed, removed when it did not.
 *
 * Call-site styles:
 *   await withIsolatedRelayFiles(async () => { ... });   // async body: restores after it settles
 *   withIsolatedRelayFiles(() => { ... });               // sync body: restores before returning
 *   await withIsolatedRelayFiles(body, { onRestore: () => resetAllRelayHealth() });
 *
 * `onRestore` runs after the disk restore; it is awaited on the promise path,
 * so only the async call style can await a promise-returning `onRestore`.
 */
export function withIsolatedRelayFiles(fn: () => void, opts?: IsolatedRelayFilesOptions): void;
export function withIsolatedRelayFiles(fn: () => Promise<void>, opts?: IsolatedRelayFilesOptions): Promise<void>;
export function withIsolatedRelayFiles(
	fn: () => void | Promise<void>,
	opts: IsolatedRelayFilesOptions = {},
): void | Promise<void> {
	const targets = [RELAY_STATE_FILE, BAK_FILE];
	if (opts.lock) targets.push(LOCK_FILE);
	if (opts.pin) targets.push(resolveSessionPinPath());
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const before = targets.map((p) => [p, read(p)] as const);
	const restore = (): void => {
		for (const [p, content] of before) {
			try {
				if (content !== null) {
					fs.writeFileSync(p, content, "utf8");
				} else {
					fs.rmSync(p, { force: true });
				}
			} catch {}
		}
	};
	let returned: Promise<void> | null = null;
	try {
		const result = fn();
		returned = result instanceof Promise ? result : null;
	} catch (err) {
		restore();
		opts.onRestore?.();
		throw err;
	}
	if (returned === null) {
		restore();
		opts.onRestore?.();
		return;
	}
	const pending = returned;
	return (async () => {
		try {
			await pending;
		} finally {
			restore();
			await opts.onRestore?.();
		}
	})();
}
