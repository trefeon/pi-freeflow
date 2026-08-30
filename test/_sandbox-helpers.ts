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
