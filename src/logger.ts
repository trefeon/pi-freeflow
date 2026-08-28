/**
 * Structured, leveled, rotating, request-aware logger for pi-freeflow
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	DEBUG_STATE_FILE,
	LOG_FILE,
	LOG_MAX_BYTES,
	LOG_MAX_FILES,
} from "./config.ts";
import type { DebugState, LogLevel } from "./types.ts";

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	audit: 4,
};

let cachedDebugState: DebugState | null | undefined = undefined;
let cachedDebugMtime = 0;
let cachedDebugAt = 0;

/**
 * Load persisted debug state from disk with a 1-second in-memory mtime cache.
 */
export function loadDebugState(): DebugState | null {
	const now = Date.now();
	if (cachedDebugState !== undefined && now - cachedDebugAt < 1000) {
		return cachedDebugState;
	}

	try {
		if (!fs.existsSync(DEBUG_STATE_FILE)) {
			cachedDebugState = null;
			cachedDebugAt = now;
			return null;
		}

		const stat = fs.statSync(DEBUG_STATE_FILE);
		if (stat.mtimeMs === cachedDebugMtime && cachedDebugState !== undefined) {
			cachedDebugAt = now;
			return cachedDebugState;
		}

		const raw = fs.readFileSync(DEBUG_STATE_FILE, "utf8");
		const parsed = JSON.parse(raw) as DebugState;
		if (typeof parsed?.debug === "boolean") {
			cachedDebugState = parsed;
			cachedDebugMtime = stat.mtimeMs;
			cachedDebugAt = now;
			return parsed;
		}
	} catch {
		// Non-fatal if parsing or reading fails
	}

	cachedDebugState = null;
	cachedDebugAt = now;
	return null;
}

/**
 * Atomically persist debug state to disk.
 */
export function saveDebugState(s: DebugState): void {
	try {
		const dir = path.dirname(DEBUG_STATE_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmp = `${DEBUG_STATE_FILE}.${randomUUID()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
		fs.renameSync(tmp, DEBUG_STATE_FILE);

		try {
			const stat = fs.statSync(DEBUG_STATE_FILE);
			cachedDebugState = s;
			cachedDebugMtime = stat.mtimeMs;
			cachedDebugAt = Date.now();
		} catch {
			cachedDebugState = s;
			cachedDebugAt = Date.now();
		}
	} catch (err) {
		// Avoid recursive logger calls on save failure
	}
}

/**
 * Calculate the active minimum log level threshold based on state and env.
 */
export function getMinLogLevel(): number {
	const dbg = loadDebugState();
	if (dbg?.debug) {
		return LOG_LEVEL_ORDER.debug;
	}
	if (dbg?.level && dbg.level in LOG_LEVEL_ORDER) {
		return LOG_LEVEL_ORDER[dbg.level];
	}

	const raw = (process.env.FREEFLOW_LOG_LEVEL || "info").toLowerCase();

	if (raw in LOG_LEVEL_ORDER) {
		return LOG_LEVEL_ORDER[raw as LogLevel];
	}

	const isEnvDebug =
		process.env.FREEFLOW_DEBUG === "1" ||
		process.env.FREEFLOW_DEBUG === "true";

	if (isEnvDebug) {
		return LOG_LEVEL_ORDER.debug;
	}

	return LOG_LEVEL_ORDER.info;
}

export function shouldLog(level: LogLevel): boolean {
	return LOG_LEVEL_ORDER[level] >= getMinLogLevel();
}

export function isDebugEnabled(): boolean {
	return LOG_LEVEL_ORDER.debug >= getMinLogLevel();
}

/**
 * Rotate log files if current log file size exceeds LOG_MAX_BYTES.
 * Rotates: log -> log.1 -> log.2 -> log.3 ... up to LOG_MAX_FILES.
 */
export function rotateLogsIfNeeded(targetFile: string = LOG_FILE): void {
	try {
		if (!fs.existsSync(targetFile)) return;
		const stat = fs.statSync(targetFile);
		if (stat.size <= LOG_MAX_BYTES) return;

		for (let i = LOG_MAX_FILES; i >= 1; i--) {
			const src = i === 1 ? targetFile : `${targetFile}.${i - 1}`;
			const dst = `${targetFile}.${i}`;
			try {
				if (fs.existsSync(src)) {
					if (i === LOG_MAX_FILES && fs.existsSync(dst)) {
						fs.unlinkSync(dst);
					} else if (fs.existsSync(dst)) {
						fs.unlinkSync(dst);
					}
					fs.renameSync(src, dst);
				}
			} catch {
				// Ignore rotation step error and continue
			}
		}
	} catch {
		// Ignore rotation errors
	}
}

/**
 * Safely format metadata object and optional requestId for log output.
 */
export function formatLogMeta(
	meta?: Record<string, unknown>,
	reqId?: string,
): string {
	const parts: string[] = [];
	if (reqId) {
		parts.push(`req=${reqId}`);
	}

	if (meta && Object.keys(meta).length > 0) {
		const safe: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(meta)) {
			if (typeof v === "string" && v.length > 800) {
				safe[k] = `${v.slice(0, 800)}…(${v.length})`;
			} else if (v instanceof Error) {
				safe[k] = {
					name: v.name,
					message: v.message,
					stack: v.stack?.split("\n").slice(0, 3).join(" | "),
				};
			} else {
				safe[k] = v;
			}
		}
		parts.push(JSON.stringify(safe));
	}

	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Write a structured log entry to disk if level passes threshold.
 */
export function log(
	level: LogLevel,
	message: string,
	meta?: Record<string, unknown>,
	reqId?: string,
): void {
	if (!shouldLog(level)) return;

	try {
		const ts = new Date().toISOString();
		const reqTag = reqId ? ` [${reqId}]` : "";
		const line = `[${ts}] [${level.toUpperCase()}]${reqTag} ${message}${formatLogMeta(meta)}\n`;

		rotateLogsIfNeeded(LOG_FILE);

		const dir = path.dirname(LOG_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.appendFileSync(LOG_FILE, line, "utf8");
	} catch {
		// Fallback silent failure
	}
}

export function logDebug(
	message: string,
	meta?: Record<string, unknown>,
	reqId?: string,
): void {
	log("debug", message, meta, reqId);
}

export function logInfo(
	message: string,
	meta?: Record<string, unknown>,
	reqId?: string,
): void {
	log("info", message, meta, reqId);
}

export function logWarn(
	message: string,
	meta?: Record<string, unknown>,
	reqId?: string,
): void {
	log("warn", message, meta, reqId);
}

export function logError(
	message: string,
	meta?: Record<string, unknown>,
	reqId?: string,
): void {
	log("error", message, meta, reqId);
}

export function logAudit(
	message: string,
	meta?: Record<string, unknown>,
	reqId?: string,
): void {
	log("audit", message, meta, reqId);
}

export interface ReadRecentLogsResult {
	lines: string[];
	totalMatched: number;
	totalLines: number;
	logFile: string;
}

/**
 * Read recent log entries from log file and its rotated archives.
 * @param filterLevel Optional log-level filter (case-insensitive label match).
 * @param filterReqId Optional request-ID substring filter.
 * @param count Max lines to return (clamped 1-200).
 * @param filterText Optional case-insensitive text substring filter.
 * @param files Optional log files to read (newest-last order); defaults to
 *   LOG_FILE and its rotated archives (.1-.3).
 */
export function readRecentLogs(
	filterLevel?: LogLevel | null,
	filterReqId?: string | null,
	count = 25,
	filterText?: string | null,
	files?: string[],
): ReadRecentLogsResult {
	const filesList: string[] = (files ?? [
		LOG_FILE,
		`${LOG_FILE}.1`,
		`${LOG_FILE}.2`,
		`${LOG_FILE}.3`,
	]).filter((f) => fs.existsSync(f));

	if (filesList.length === 0) {
		return {
			lines: [],
			totalMatched: 0,
			totalLines: 0,
			logFile: LOG_FILE,
		};
	}

	let allLines: string[] = [];
	for (const f of filesList) {
		try {
			const content = fs.readFileSync(f, "utf8");
			const lines = content.trim().split("\n").filter(Boolean);
			allLines = lines.concat(allLines);
		} catch {
			// Skip unreadable rotated files
		}
	}

	let filtered = allLines;
	if (filterLevel) {
		const levelTag = `[${filterLevel.toUpperCase()}]`;
		filtered = filtered.filter((l) => l.includes(levelTag));
	}

	if (filterReqId) {
		const cleanedReqId = filterReqId.replace(/^req=/, "");
		filtered = filtered.filter(
			(l) => l.includes(cleanedReqId) || l.includes(`[${cleanedReqId}]`),
		);
	}

	if (filterText) {
		const lower = filterText.toLowerCase();
		filtered = filtered.filter((l) => l.toLowerCase().includes(lower));
	}

	const clampedCount = Math.min(200, Math.max(1, count));
	const resultLines = filtered.slice(-clampedCount);

	return {
		lines: resultLines,
		totalMatched: filtered.length,
		totalLines: allLines.length,
		logFile: LOG_FILE,
	};
}
