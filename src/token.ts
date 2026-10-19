/**
 * Per-installation bearer token for the loopback proxy.
 *
 * Loopback is not an authorization boundary: any local process can connect to
 * the port. The daemon therefore writes a random 32-byte token to
 * `<data dir>/token` (hex, mode 0600, no trailing newline) when the file is
 * missing, and every `/v1/*` and `/_*` route requires it as
 * `Authorization: Bearer <token>`. The host gets the same value into its
 * provider config (src/index.ts buildProviderConfig), and internal callers
 * (heartbeat, watchdog, CLI control verbs) read it from the file.
 *
 * readToken() re-reads on a cache miss, so a client that starts before its
 * daemon has written the file picks the token up as soon as it appears.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveTokenPath } from "./config.ts";

/** Token entropy: 32 random bytes rendered as 64 hex characters. */
const TOKEN_BYTES = 32;
/** File mode: owner read/write only. */
const TOKEN_MODE = 0o600;

let cache: { path: string; token: string } | null = null;

/** Read the installation token; null while the file is missing or empty. */
export function readToken(): string | null {
	const file = resolveTokenPath();
	if (cache !== null && cache.path === file) return cache.token;
	try {
		const token = readFileSync(file, "utf8").trim();
		if (!token) return null;
		cache = { path: file, token };
		return token;
	} catch {
		return null;
	}
}

/**
 * Read the token, creating it first when the file does not exist yet.
 *
 * Returns "" when the file cannot be created or read (read-only data dir):
 * callers that gate requests MUST fail closed on the empty value instead of
 * accepting unauthenticated traffic.
 */
export function ensureToken(): string {
	const existing = readToken();
	if (existing) return existing;
	const file = resolveTokenPath();
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		// `wx` never truncates a token another process just wrote.
		writeFileSync(file, token, { encoding: "utf8", mode: TOKEN_MODE, flag: "wx" });
		chmodSync(file, TOKEN_MODE);
		cache = { path: file, token };
		return token;
	} catch {
		// Lost a creation race (EEXIST) or the data dir is not writable:
		// prefer whatever is on disk now, else report the failure as "".
		cache = null;
		return readToken() ?? "";
	}
}

/**
 * Constant-time check of an `Authorization: Bearer <token>` header value
 * against `expected`. False for a missing header, a different scheme, a
 * different length, or an empty expected token (fail closed).
 */
export function isAuthorizedBearer(header: string | undefined, expected: string): boolean {
	if (!expected || typeof header !== "string") return false;
	const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
	if (!match) return false;
	const candidate = Buffer.from(match[1], "utf8");
	const wanted = Buffer.from(expected, "utf8");
	if (candidate.length !== wanted.length) return false;
	return timingSafeEqual(candidate, wanted);
}

/** Test-only: drop the cached token so the file is re-read. */
function _resetTokenCacheForTest(): void {
	cache = null;
}
