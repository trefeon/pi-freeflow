/**
 * High-resiliency multi-cloud relay client and failover dispatcher
 */

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Agent } from "undici";
import { isDebugEnabled, log } from "./logger.ts";
import { getModelDef } from "./models.ts";

export const agent = new Agent({ keepAliveTimeout: 30_000 });
import {
	getActiveRelayState,
	getOrderedRelayUrls,
	markRelayFailure,
	markRelaySuccess,
	saveRelayState,
	setActiveRelayState,
	shortRelayLabel,
	updateRelayStatusUi,
} from "./relay-state.ts";

/**
 * Determine if an HTTP status code indicates a temporary relay or upstream error
 * that warrants rolling to the next relay candidate.
 */
export function isRetriableStatus(status: number): boolean {
	return (
		status === 429 ||
		status === 408 ||
		status === 502 ||
		status === 503 ||
		status === 504 ||
		(status >= 520 && status <= 530)
	);
}
export function clampMaxTokens(modelId: string, requested: number): number {
	const def = getModelDef(modelId);
	const max = def ? def.maxTokens - 1024 : 32_000 - 1024;
	// special case for big-pickle acceptance
	const effectiveMax = modelId.includes("big-pickle") ? 32_000 : max;
	const clamped = Math.min(requested, effectiveMax);
	if (clamped !== requested) {
		// logDebug
		try { log("debug", `clamp maxTokens ${requested}->${clamped} for ${modelId}`); } catch {}
	}
	return clamped;
}


/**
 * Fetch a target URL through the active relay pool with rolling failover and direct fallback.
 *
 * @param url Full upstream destination URL (e.g. https://opencode.ai/zen/v1/chat/completions)
 * @param opts Standard fetch RequestInit options
 * @param reqId Optional correlation request ID for end-to-end tracing
 */
export async function relayFetch(
	url: string,
	opts: RequestInit = {},
	reqId?: string,
): Promise<Response> {
	const rid = reqId || randomUUID().slice(0, 8);
	const relayState = getActiveRelayState();

	if (!relayState.enabled) {
		log("debug", `relayFetch: direct (relay disabled) -> ${url}`, undefined, rid);
		return fetch(url, { ...opts, dispatcher: agent } as unknown as RequestInit);

	}
	const candidates = getOrderedRelayUrls();

	if (candidates.length === 0) {
		// Empty pool: skip straight to upstream instead of logging a misleading
		// "relays bypassed/exhausted" WARN on every request.
		log("debug", `relayFetch: direct (empty relay pool) -> ${url}`, undefined, rid);
		return fetch(url, { ...opts, dispatcher: agent } as unknown as RequestInit);
	}

	let lastResponse: Response | null = null;
	let lastError: unknown = null;
	const u = new URL(url);
	const relayTarget = `${u.protocol}//${u.host}`;
	const relayPath = `${u.pathname}${u.search}`;

	const bodySizeKB =
		typeof opts.body === "string"
			? (opts.body.length / 1024).toFixed(1)
			: Buffer.isBuffer(opts.body)
				? (opts.body.length / 1024).toFixed(1)
				: "0";

	log("info", `request starting (${bodySizeKB}KB payload) -> ${url}`, undefined, rid);
	if (isDebugEnabled()) {
		try {
			const bodyPreview = typeof opts.body === "string" ? opts.body.slice(0, 1200) : "";
			const modelMatch = bodyPreview.match(/"model"\s*:\s*"([^"]+)"/);
			const streamMatch = bodyPreview.match(/"stream"\s*:\s*(true|false)/);
			log("debug", "request detail", {
				model: modelMatch?.[1],
				stream: streamMatch?.[1],
				sizeKB: bodySizeKB,
				relayTarget,
				relayPath,
				candidates: candidates.length,
			}, rid);
		} catch {}
	}

	for (let i = 0; i < candidates.length; i++) {
		const targetUrl = candidates[i];
		const attemptStart = Date.now();
		try {
			let targetHost = "opencode.ai";
			try {
				if (targetUrl) targetHost = new URL(targetUrl).host;
			} catch {}

			const headers = new Headers(opts.headers);
			headers.set("x-relay-target", relayTarget);
			headers.set("x-relay-path", relayPath);
			headers.set("host", targetHost);
			headers.set("x-request-id", rid);

			const signal = opts.signal || AbortSignal.timeout(300_000);
			const res = await fetch(targetUrl, { ...opts, headers, signal, dispatcher: agent } as unknown as RequestInit);
			const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);
			// Vercel 504 Gateway Timeout on heavy prompts (>50KB or >25s):
			// Fast fallback directly to upstream instead of cycling through multiple 25s timeouts.
			if (res.status === 504) {
				markRelayFailure(targetUrl, 504, "Gateway Timeout (25s exceeded)");
				res.body?.cancel().catch(() => {});
				log(
					"warn",
					`relay ${targetUrl} hit HTTP 504 Gateway Timeout in ${elapsed}s (prompt evaluation exceeded Vercel 25s limit) — fast fallback to direct upstream`,
					{ upstream: url, sizeKB: bodySizeKB },
					rid,
				);
				break;
			}

			if (isRetriableStatus(res.status)) {
				markRelayFailure(targetUrl, res.status);
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
				log(
					"warn",
					`relay ${targetUrl} returned HTTP ${res.status} in ${elapsed}s — rolling to next relay`,
					{ upstream: url, status: res.status },
					rid,
				);
				continue;
			}

			markRelaySuccess(targetUrl, Date.now() - attemptStart);

			// SUCCESS or non-retriable client error (e.g. 200, 404):
			// If we switched to a different relay because previous failed, update sticky active relay!
			if (relayState.url !== targetUrl) {
				log("info", `active relay auto-switched to ${targetUrl}`, {
					previous: relayState.url,
				}, rid);
				relayState.url = targetUrl;
				saveRelayState(relayState);
				setActiveRelayState(relayState, false);
			}

			log("info", `relay ${targetUrl} succeeded (HTTP ${res.status} in ${elapsed}s)`, undefined, rid);
			if (isDebugEnabled()) {
				log("debug", "relay headers", {
					status: res.status,
					contentType: res.headers.get("content-type"),
					via: res.headers.get("via") || res.headers.get("x-vercel-id") || "direct",
				}, rid);
			}

			updateRelayStatusUi(targetUrl);
			return res;
		} catch (err) {
			// Client abort: do not mark the relay failed — the client cancelled the
			// request, the relay itself is not at fault. Propagate immediately.
			if ((err as Error)?.name === "AbortError") {
				throw err;
			}
			const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);
			lastError = err;
			const errMsg = (err as Error)?.message || String(err);
			markRelayFailure(targetUrl, 0, errMsg);
			log(
				"warn",
				`relay ${targetUrl} fetch error in ${elapsed}s — rolling to next relay`,
				{ upstream: url, error: errMsg },
				rid,
			);
			continue;
		}
	}

	// Full fallback: attempt direct fetch to upstream
	const directStart = Date.now();
	try {
		log("warn", "relays bypassed/exhausted — attempting direct fetch to upstream", {
			upstream: url,
			sizeKB: bodySizeKB,
		}, rid);

		const directHeaders = new Headers(opts.headers);
		directHeaders.delete("x-relay-target");
		directHeaders.delete("x-relay-path");
		directHeaders.set("host", u.host);
		directHeaders.set("x-request-id", rid);

		const directRes = await fetch(url, { ...opts, headers: directHeaders, dispatcher: agent } as unknown as RequestInit);
		// lastResponse holds an unread body that would otherwise leak its socket
		// until GC; the salvage path below still needs it, so only cancel here.
		lastResponse?.body?.cancel().catch(() => {});
		return directRes;
	} catch (directErr) {
		const directElapsed = ((Date.now() - directStart) / 1000).toFixed(1);
		log("error", `direct fallback also failed in ${directElapsed}s`, {
			upstream: url,
			error: String(directErr),
		}, rid);
		if (lastResponse) {
			return lastResponse;
		}
		throw directErr || lastError;
	}
}
