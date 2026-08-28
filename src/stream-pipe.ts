/**
 * Upstream SSE streaming pipeline with thinking sniffing and exception isolation.
 *
 * Prevents upstream stream aborts or timeouts from crashing the host process.
 * Sniffs thinking and reasoning chunks for debug trace logging without payload mutation.
 */

import { randomUUID } from "node:crypto";
import type * as http from "node:http";
import type { Readable } from "node:stream";
import { isDebugEnabled, log } from "./logger.ts";
import { markRelayFailure } from "./relay-state.ts";

/**
 * A premature stream end counts as "substantial" only when BOTH thresholds
 * are strictly exceeded: more than 50 chunks AND more than 100KB. Substantial
 * truncations are reported as incomplete; smaller drops stay failed.
 */
export const SUBSTANTIAL_MIN_CHUNKS = 50;
export const SUBSTANTIAL_MIN_BYTES = 100 * 1024;

export function isSubstantial(chunks: number, bytes: number): boolean {
	return chunks > SUBSTANTIAL_MIN_CHUNKS && bytes > SUBSTANTIAL_MIN_BYTES;
}
/**
 * Pipes an upstream readable stream to a client HTTP response.
 *
 * - Flushes HTTP headers immediately for low Time-to-First-Byte (TTFB).
 * - Detects thinking/reasoning tokens in chunks for diagnostic logs.
 * - Handles upstream errors (returns 502 if headers unsent) and ends response.
 * - Cleans up resources and destroys upstream stream on client disconnect/abort.
 */
export function pipeUpstreamStream(
	nodeStream: Readable,
	res: http.ServerResponse,
	req: http.IncomingMessage,
	reqId?: string,
	relayUrl?: string,
): void {
	const rid = reqId || randomUUID().slice(0, 8);
	let totalChunks = 0;
	let totalBytes = 0;
	let thinkingChunks = 0;
	let thinkingBytes = 0;
	let firstChunkAt: number | null = null;
	const startAt = Date.now();
	const isResponsesApi = req.url?.includes("/responses") ?? false;
	let hasTerminalEvent = false;
	// Abort-cause tracking: only genuine upstream-side truncation may penalize
	// relay health. Client disconnects and clean upstream ends must not.
	let upstreamEnded = false;
	let clientAborted = false;
	// Terminal-marker scan carry: holds the tail of the previously scanned
	// view so a marker split across adjacent chunks ("[DO" | "NE]") is still
	// recognized. Longest marker is "response.completed" (18 bytes); 32
	// gives comfortable headroom.
	let terminalScanCarry = Buffer.alloc(0);

	const sniffThinking = (chunk: Buffer | string): boolean => {
		const s =
			typeof chunk === "string"
				? chunk
				: chunk.toString("utf8", 0, Math.min(chunk.length, 4000));
		return (
			s.includes("reasoning") ||
			s.includes("thinking") ||
			s.includes("<think>") ||
			s.includes("reasoning_content") ||
			s.includes('"type":"thinking"') ||
			s.includes("thinking_delta")
		);
	};

	const checkTerminalEvent = (s: string): boolean => {
		return (
			s.includes("response.completed") ||
			s.includes("response.done") ||
			s.includes("response.failed") ||
			s.includes("response.incomplete") ||
			s.includes("[DONE]")
		);
	};
	const ensureTerminalEvent = (
		isError = false,
		errorMsg?: string,
		penalizeRelay = true,
	) => {
		if (hasTerminalEvent || res.writableEnded) return;
		// Only genuine upstream-side truncation penalizes relay health.
		// Client disconnects and clean upstream ends leave it untouched.
		if (penalizeRelay && relayUrl && relayUrl !== "direct") {
			markRelayFailure(relayUrl, 0, errorMsg || "stream truncated prematurely");
		}
		if (isResponsesApi && totalChunks > 0) {
			try {
				if (isError) {
					res.write(
						`\nevent: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"stream_error","message":${JSON.stringify(errorMsg || "Upstream stream disconnected unexpectedly")}}}}\n\n`,
					);
				} else {
					res.write(
						`\nevent: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"cancelled"}}}\n\n`,
					);
				}
				hasTerminalEvent = true;
				log(
					"warn",
					`injected synthetic response.${isError ? "failed" : "incomplete"} for prematurely truncated stream`,
					{ totalChunks, totalBytes, isError, errorMsg },
					rid,
				);
			} catch {}
		} else if (!isResponsesApi && totalChunks > 0) {
			try {
				res.write("\ndata: [DONE]\n\n");
				hasTerminalEvent = true;
			} catch {}
		}
	};

	try {
		if (typeof res.flushHeaders === "function") {
			res.flushHeaders();
		}
	} catch {}
	nodeStream.on("data", (chunk: Buffer | string) => {
		try {
			if (firstChunkAt === null) {
				firstChunkAt = Date.now();
				const ttfb = firstChunkAt - startAt;
				log("debug", `stream first chunk in ${ttfb}ms`, undefined, rid);
			}
			totalChunks++;
			const chunkSize =
				typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
			totalBytes += chunkSize;

			if (sniffThinking(chunk)) {
				thinkingChunks++;
				thinkingBytes += chunkSize;
				if (isDebugEnabled() && thinkingChunks <= 3) {
					const preview =
						typeof chunk === "string"
							? chunk.slice(0, 600)
							: chunk.toString("utf8", 0, 600);
					log(
						"debug",
						`thinking chunk #${thinkingChunks}`,
						{ preview: preview.slice(0, 400) },
						rid,
					);
				}
			}
			// Always scan the FULL chunk plus the small carry from the previous
			// view. SSE chunks are KBs at most, so includes() over everything
			// is negligible against correctness — the removed head/tail windows
			// are exactly what let markers buried mid-chunk or split across
			// adjacent chunks escape and cause duplicate synthetic terminals.
			const buf =
				typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			const scanBuf =
				terminalScanCarry.length > 0
					? Buffer.concat([terminalScanCarry, buf])
					: buf;
			if (!hasTerminalEvent && checkTerminalEvent(scanBuf.toString("utf8"))) {
				hasTerminalEvent = true;
			}
			terminalScanCarry = Buffer.from(scanBuf.subarray(Math.max(0, scanBuf.length - 32)));

			const canContinue = res.write(chunk);
			if (canContinue === false && !nodeStream.destroyed) {
				// Backpressure: pause the upstream source until the client
				// socket drains, instead of buffering an unbounded amount into
				// the response. 'drain' might never fire if the client closes —
				// the close handlers below destroy the stream regardless of
				// its paused state.
				nodeStream.pause();
				const onDrain = () => {
					res.off("drain", onDrain);
					if (!nodeStream.destroyed) nodeStream.resume();
				};
				res.once("drain", onDrain);
			}
			const maybeFlush = res as unknown as { flush?: () => void };
			if (typeof maybeFlush.flush === "function") {
				maybeFlush.flush();
			}
		} catch {}
	});

	nodeStream.on("error", (e: unknown) => {
		const errorMsg = (e as Error)?.message || String(e);
		// An abort (client disconnect or a proxy-internal header timeout marked
		// FF_INTERNAL_ABORT) is not a relay fault — never penalize relay health,
		// and behave like a client abort for the terminal marker. Only genuine
		// upstream-side failures (socket errors, truncation) penalize.
		// Stream errors are always Error subclasses (node/undici).
		const streamErr = e as Error & { code?: string };
		const isInternalAbort =
			streamErr?.name === "AbortError" || streamErr?.code === "FF_INTERNAL_ABORT";
		log(
			isInternalAbort ? "warn" : "error",
			isInternalAbort
				? "upstream stream aborted (internal cancel/timeout)"
				: "upstream stream error",
			{ error: errorMsg, totalChunks, thinkingChunks, hasTerminalEvent },
			rid,
		);
		try {
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json" });
			} else if (isInternalAbort) {
				clientAborted = true;
				ensureTerminalEvent(false, errorMsg || "stream interrupted", false);
			} else {
				ensureTerminalEvent(!isSubstantial(totalChunks, totalBytes), errorMsg, true);
			}
			if (!res.writableEnded) {
				res.end();
			}
		} catch {}
	});

	nodeStream.on("end", () => {
		upstreamEnded = true;
		const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
		if (!hasTerminalEvent && totalChunks > 0) {
			// Clean upstream end without a detectable marker: keep the host
			// contract (synthetic terminal) but never blame the relay.
			ensureTerminalEvent(
				false,
				"upstream ended without terminal marker",
				false,
			);
		}
		if (thinkingChunks > 0) {
			log(
				"info",
				`stream ended in ${elapsed}s — ${totalChunks} chunks (${(totalBytes / 1024).toFixed(1)}KB), thinking: ${thinkingChunks} chunks (${(thinkingBytes / 1024).toFixed(1)}KB)`,
				undefined,
				rid,
			);
		} else if (isDebugEnabled()) {
			log(
				"debug",
				`stream ended in ${elapsed}s — ${totalChunks} chunks (${(totalBytes / 1024).toFixed(1)}KB), no thinking detected`,
				undefined,
				rid,
			);
		}
		try {
			if (!res.writableEnded) res.end();
		} catch {}
	});

	nodeStream.on("close", () => {
		try {
			if (!hasTerminalEvent && totalChunks > 0) {
				if (clientAborted || upstreamEnded) {
					// Client disconnect teardown or post-end cleanup — the relay
					// is not at fault; still give the host a terminal event.
					ensureTerminalEvent(false, "stream interrupted by client", false);
				} else {
					// Upstream socket died mid-stream with no error event.
					// For muse-spark large payloads: raxtant 514KB failed but feoni 802KB
					// succeeded with same 2.6MB in — so this is edge-specific, not pure
					// provider token limit. Keep penalize=true to rotate failing relay,
					// but inject incomplete (not failed) for substantial to avoid alarming
					// stream_error. Small premature (<50 chunks) stays failed+penalize.
					ensureTerminalEvent(!isSubstantial(totalChunks, totalBytes), "stream closed prematurely", true);
				}
			}
			if (!res.writableEnded) res.end();
		} catch {}
	});

	req.on("aborted", () => {
		clientAborted = true;
		log("warn", "client aborted — destroying upstream", { totalChunks }, rid);
		if (!nodeStream.destroyed) nodeStream.destroy();
	});

	req.on("close", () => {
		if (!upstreamEnded && !nodeStream.destroyed) {
			clientAborted = true;
			nodeStream.destroy();
		}
	});

	res.on("close", () => {
		if (
			!upstreamEnded &&
			!res.writableEnded &&
			!nodeStream.destroyed
		) {
			clientAborted = true;
			nodeStream.destroy();
		}
	});

	res.on("error", () => {
		if (!upstreamEnded && !nodeStream.destroyed) {
			clientAborted = true;
			nodeStream.destroy();
		}
	});
}
