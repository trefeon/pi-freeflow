/**
 * High-resiliency multi-cloud relay client and failover dispatcher
 */

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { UPSTREAM_HEADER_TIMEOUT_MS } from "./config.ts";
import { isDebugEnabled, log } from "./logger.ts";
import {
	getActiveRelayState,
	isRelayHealthy,
	orderedRelayCandidates,
	getStatusUi,
	markRelayFailure,
	markRelaySuccess,
	shortRelayLabel,
	updateRelayStatusUi,
	withRelayState,
	validateRelayUrl,
} from "./relay-state.ts";

// Throttle user-facing roll notifications so a burst of failures surfaces
// one warning instead of a wall of identical toasts.
let lastRollNotify = 0;
const ROLL_NOTIFY_MS = 5 * 60 * 1_000;
/********************************************************
 * Hedged failover grace: an attempt with no response headers
 * within this window fires the NEXT candidate in parallel.
 ********************************************************/
export let HEDGE_GRACE_MS = 8000;
/** Test-only: override the hedge grace; returns a restore function. */
export function _setHedgeGraceForTest(ms: number): () => void {
	const prev = HEDGE_GRACE_MS;
	HEDGE_GRACE_MS = ms;
	return () => { HEDGE_GRACE_MS = prev; };
}
/** Test-only: reset roll-notify throttle */
export function _resetRollNotifyForTest(): void { lastRollNotify = 0; }

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

/**
 * Gated 402 roll predicate: a 402 is a relay-host failure only when it
 * carries the Vercel edge-error marker or a DEPLOYMENT_DISABLED body match.
 * Generic 402s (payment/quota) carry neither and must surface immediately.
 * Only x-vercel-error qualifies as an edge marker: Vercel stamps x-vercel-id
 * on EVERY function response, so keying on it would misroll a genuine
 * upstream quota 402 forwarded by a healthy Vercel-hosted relay — and
 * wrongly cool that relay down.
 */
function isRelayDeploymentDisabled(res: Response, bodyText: string | null): boolean {
	if (res.status !== 402) return false;
	if (Boolean(res.headers.get("x-vercel-error"))) return true;
	return bodyText !== null && bodyText.toLowerCase().includes("deployment_disabled");
}
/**
 * Per-conversation reasoning affinity. Callers sending caller-bound reasoning
 * pass the relay that issued it; `onServed` reports the relay that actually
 * produced the response (`null` = direct fallback).
 */
export interface RelayAffinity {
	preferred?: string;
	/** Stable key used to shard requests across healthy relays in spread mode. */
	spreadKey?: string;
	onServed?: (relay: string | null) => void;
}

/**
 * Fetch a target URL through the active relay pool with rolling failover and direct fallback.
 *
 * @param url Full upstream destination URL (e.g. https://opencode.ai/zen/v1/chat/completions)
 * @param opts Standard fetch RequestInit options
 * @param reqId Optional correlation request ID for end-to-end tracing
 * @param affinity Per-conversation affinity: `preferred` is tried first when it
 *        is healthy (the caller is expected to send a body that relay can read),
 *        and `onServed` reports which relay actually produced the response —
 *        `null` for the direct fallback — so the caller does not have to infer
 *        the issuer from mutable global state.
 */
export async function relayFetch(
	url: string,
	opts: RequestInit = {},
	reqId?: string,
	affinity: RelayAffinity = {},
): Promise<Response> {
	const rid = reqId || randomUUID().slice(0, 8);
	const relayState = getActiveRelayState();

	if (!relayState.enabled) {
		log("debug", `relayFetch: direct (relay disabled) -> ${url}`, undefined, rid);
		affinity.onServed?.(null);
		return fetch(url, opts as unknown as RequestInit);
	}
	const candidates = orderedRelayCandidates(affinity.preferred, affinity.spreadKey);

	if (candidates.length === 0) {
		// Empty pool: skip straight to upstream instead of logging a misleading
		// "relays bypassed/exhausted" WARN on every request.
		log("debug", `relayFetch: direct (empty relay pool) -> ${url}`, undefined, rid);
		affinity.onServed?.(null);
		return fetch(url, opts as unknown as RequestInit);
	}

	let lastResponse: Response | null = null;
	let lastError: unknown = null;
	/** Relay that produced `lastResponse`, for accurate issuer reporting. */
	let lastResponseRelay: string | null = null;
	/** Relay URLs that returned a gated 402 DEPLOYMENT_DISABLED this request. */
	const disabledRelays: string[] = [];
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

	let hedgeSkipNext = false;
	for (let i = 0; i < candidates.length; i++) {
		if (hedgeSkipNext) {
			hedgeSkipNext = false;
			continue;
		}
		let targetUrl = candidates[i];
		let attemptStart = Date.now();
		try {
			// SSRF guard: reject private/loopback/non-https candidates the same
			// way a deployed relay worker rejects an inbound x-relay-target.
			const candidateCheck = validateRelayUrl(targetUrl);
			if (!candidateCheck.ok) {
				log(
					"warn",
					`relay ${targetUrl} skipped — ${candidateCheck.reason}`,
					{ upstream: url },
					rid,
				);
				continue;
			}
			// Per-candidate wiring: relay-target headers, per-relay auth, and a
			// combined signal (caller + header budget + hedge-cancel) so a
			// hedged loser can be aborted without touching the winner.
			const buildAttempt = (candidateUrl: string, hedgeCtl: AbortController) => {
				let host = "opencode.ai";
				try {
					if (candidateUrl) host = new URL(candidateUrl).host;
				} catch {}
				const attemptHeaders = new Headers(opts.headers);
				attemptHeaders.set("x-relay-target", relayTarget);
				attemptHeaders.set("x-relay-path", relayPath);
				attemptHeaders.set("host", host);
				attemptHeaders.set("x-request-id", rid);
				// Per-relay shared secret set by /freeflow deploy. Legacy entries
				// without auth keep working: no header at all.
				const attemptEntry = getActiveRelayState().relays.find(
					(r) => r.url === candidateUrl.trim(),
				);
				if (attemptEntry?.auth) {
					attemptHeaders.set("x-relay-auth", attemptEntry.auth);
				}
				// Per-attempt budget: each relay gets its own header-timeout
				// window, combined with the caller's signal so either can fire.
				// A hung relay then trips only its own timeout (roll) instead of
				// vetoing the pool; a genuine client cancel (caller signal
				// aborted) still propagates to both hedged attempts.
				const attemptTimeout = AbortSignal.timeout(UPSTREAM_HEADER_TIMEOUT_MS);
				const attemptSignal = opts.signal
					? AbortSignal.any([opts.signal, attemptTimeout, hedgeCtl.signal])
					: AbortSignal.any([attemptTimeout, hedgeCtl.signal]);
				return { headers: attemptHeaders, signal: attemptSignal };
			};

			// Hedged failover: an attempt with no response headers within
			// HEDGE_GRACE_MS fires the NEXT candidate in parallel; first headers
			// wins. The loser is aborted immediately and — cancelled before
			// headers — marked neither success nor failure (no cooldown). The
			// winner flows through the normal branches below, so its 429/cooling
			// marks and EWMA sample apply exactly once. Cap: one hedge in
			// flight (2 concurrent max); never on the last candidate; never
			// when fewer than two healthy candidates exist (hedging a lone
			// healthy relay into a cooling tail helps nobody).
			const canHedge =
				candidates.length > 1 &&
				i < candidates.length - 1 &&
				isRelayHealthy(targetUrl) &&
				isRelayHealthy(candidates[i + 1]);
			let res: Response;
			if (!canHedge) {
				const soloCtl = new AbortController();
				const solo = buildAttempt(targetUrl, soloCtl);
				res = await fetch(targetUrl, { ...opts, headers: solo.headers, signal: solo.signal } as unknown as RequestInit);
			} else {
				const primaryUrl = targetUrl;
				const nextUrl = candidates[i + 1];
				const nextCheck = validateRelayUrl(nextUrl);
				const hedgeCtlA = new AbortController();
				const first = buildAttempt(primaryUrl, hedgeCtlA);
				const fetchA = fetch(primaryUrl, { ...opts, headers: first.headers, signal: first.signal } as unknown as RequestInit);
				const stalled = await new Promise<boolean>((resolve) => {
					const graceTimer = setTimeout(() => resolve(true), HEDGE_GRACE_MS);
					fetchA.then(
						() => { clearTimeout(graceTimer); resolve(false); },
						() => { clearTimeout(graceTimer); resolve(false); },
					);
				});
				if (!stalled || !nextCheck.ok) {
					res = await fetchA;
				} else {
					log("info", `relay ${primaryUrl} slow headers (>${HEDGE_GRACE_MS}ms) — hedging to ${nextUrl}`, { upstream: url }, rid);
					const hedgeCtlB = new AbortController();
					const second = buildAttempt(nextUrl, hedgeCtlB);
					const hedgeStart = Date.now();
					const fetchB = fetch(nextUrl, { ...opts, headers: second.headers, signal: second.signal } as unknown as RequestInit);
					// Swallow the loser path so the deliberate abort never
					// surfaces as an unhandled rejection or a direct fallback.
					fetchA.catch(() => {});
					fetchB.catch(() => {});
					interface HedgedWin { url: string; response: Response; }
					try {
						const winner = await new Promise<HedgedWin>((resolve, reject) => {
							let failures = 0;
							let firstError: unknown = null;
							const onError = (err: unknown) => {
								failures += 1;
								if (firstError === null) firstError = err;
								if (failures >= 2) reject(firstError);
							};
							fetchA.then(
								(response) => resolve({ url: primaryUrl, response }),
								onError,
							);
							fetchB.then(
								(response) => resolve({ url: nextUrl, response }),
								onError,
							);
						});
						if (winner.url === nextUrl) {
							hedgeCtlA.abort();
							targetUrl = nextUrl;
							attemptStart = hedgeStart;
						} else {
							hedgeCtlB.abort();
						}
						res = winner.response;
						// Both candidates are consumed by this race: skip the next
						// index so the loser is never retried in this request.
						hedgeSkipNext = true;
					} catch (hedgeErr) {
						// Both hedged attempts failed without usable headers. Caller
						// abort must propagate unmarked (the outer catch rethrows);
						// otherwise record the next relay here and let the outer
						// catch record the primary.
						if ((hedgeErr as Error)?.name === "AbortError" && opts.signal?.aborted) {
							throw hedgeErr;
						}
						markRelayFailure(nextUrl, 0, (hedgeErr as Error)?.message || String(hedgeErr));
						hedgeSkipNext = true;
						throw hedgeErr;
					}
				}
			}
			const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);
			// Relay 504 Gateway Timeout on heavy prompts: the response already arrived
			// (no 25s wait to repeat), so roll to the next relay instead of falling
			// straight back to direct. The pool is self-hosted, not Vercel-edge, so a
			// sibling relay is worth trying before the direct fallback.
			if (res.status === 504) {
				markRelayFailure(targetUrl, 504, "Gateway Timeout (25s exceeded)");
				res.body?.cancel().catch(() => {});
				log(
					"warn",
					`relay ${targetUrl} hit HTTP 504 Gateway Timeout in ${elapsed}s (prompt evaluation exceeded relay limit) — rolling to next relay`,
					{ upstream: url, sizeKB: bodySizeKB },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} hit HTTP 504 — rolled to next relay`, "warning");
					}
				}
				continue;
			}
			// Relay payload cap hit (413: request exceeds host payload limit):
			// Not a relay health signal, so no failure marking — try the next
			// relay (a different host may accept it), else the direct fallback.
			if (res.status === 413) {
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
				lastResponseRelay = targetUrl;
				log(
					"warn",
					`relay ${targetUrl} hit HTTP 413 payload limit in ${elapsed}s — trying next path`,
					{ upstream: url, sizeKB: bodySizeKB },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} hit payload limit — trying next path`, "warning");
					}
				}
				continue;
			}

			// Relay host infrastructure 404 (e.g. Vercel DEPLOYMENT_NOT_FOUND or non-JSON 404):
			// When a relay URL is deleted, misconfigured, or has no deployment, Vercel/Cloudflare
			// returns edge 404. This is a relay failure, not an upstream API response.
			const isRelayEdge404 =
				res.status === 404 &&
				(Boolean(res.headers.get("x-vercel-error")) ||
					Boolean(res.headers.get("x-vercel-id")) ||
					res.headers.get("server")?.toLowerCase().includes("vercel") ||
					!res.headers.get("content-type")?.includes("json"));

			if (isRelayEdge404) {
				markRelayFailure(targetUrl, 404, "Deployment or route not found on relay host");
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
				lastResponseRelay = targetUrl;
				log(
					"warn",
					`relay ${targetUrl} returned edge 404 (deployment missing or route not found) — rolling to next relay`,
					{ upstream: url },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} failed (HTTP 404) — rolled to next relay`, "warning");
					}
				}
				continue;
			}
			// Relay deployment disabled (402 DEPLOYMENT_DISABLED from Vercel):
			// A disabled deployment is a relay-host failure, so roll to the next
			// relay. A blanket 402 must NOT roll: generic 402s are payment/quota
			// verdicts that must surface immediately, so gate strictly on Vercel
			// edge markers or a DEPLOYMENT_DISABLED body match and otherwise fall
			// through to the terminal path below. The body is peeked via a clone so
			// the downstream stream stays intact; on any clone/read failure decide
			// on headers alone (headerless failure reads as a generic 402).
			if (res.status === 402) {
				let disabledBody: string | null = null;
				try {
					disabledBody = (await res.clone().text()).slice(0, 8192);
				} catch {
					disabledBody = null;
				}
				if (isRelayDeploymentDisabled(res, disabledBody)) {
					markRelayFailure(targetUrl, 402, "Deployment disabled (DEPLOYMENT_DISABLED) on relay host");
					disabledRelays.push(targetUrl);
					lastResponse?.body?.cancel().catch(() => {});
					lastResponse = res;
					lastResponseRelay = targetUrl;
					log(
						"warn",
						`relay ${targetUrl} returned 402 DEPLOYMENT_DISABLED in ${elapsed}s — rolling to next relay`,
						{ upstream: url },
						rid,
					);
					const now = Date.now();
					if (now - lastRollNotify > ROLL_NOTIFY_MS) {
						lastRollNotify = now;
						const ui = getStatusUi();
						if (ui?.notify) {
							ui.notify(`relay ${shortRelayLabel(targetUrl)} failed (HTTP 402) — rolled to next relay`, "warning");
						}
					}
					continue;
				}
			}
			if (isRetriableStatus(res.status)) {
				markRelayFailure(targetUrl, res.status);
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
				lastResponseRelay = targetUrl;
				log(
					"warn",
					`relay ${targetUrl} returned HTTP ${res.status} in ${elapsed}s — rolling to next relay`,
					{ upstream: url, status: res.status },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} failed (HTTP ${res.status}) — rolled to next relay`, "warning");
					}
				}
				continue;
			}

			markRelaySuccess(targetUrl, Date.now() - attemptStart);

			// SUCCESS or non-retriable client error (e.g. 200, 404):
			// If we switched to a different relay because previous failed, update sticky active relay!
			//
			// Exception: a winner that is the caller's preferred (affinity) relay
			// was reached on the first attempt, so the sticky primary never failed
			// a roll and must not be rewritten. Without this, two conversations
			// pinned to different issuers would flip the machine-wide primary on
			// every turn, churning the state file and re-shuffling every other
			// session's candidate order.
			const affinityServed =
				Boolean(affinity.preferred) &&
				targetUrl.trim() === (affinity.preferred ?? "").trim();
			// Spread mode has no single primary: every request picks its own
			// healthy relay, so rewriting the sticky URL here would churn the
			// state file and spam "active relay auto-switched" on every turn.
			const spreadMode = relayState.mode === "spread";
			if (relayState.url !== targetUrl && !affinityServed && !spreadMode) {
				log("info", `active relay auto-switched to ${targetUrl}`, {
					previous: relayState.url,
				}, rid);
				// CAS: re-apply the sticky-active switch to the freshest disk state at
				// write time so a concurrent session's pool edit is never clobbered.
				withRelayState((s) => {
					s.url = targetUrl;
					return s;
				});
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
			affinity.onServed?.(targetUrl);
			return res;
		} catch (err) {
			// Client abort: do not mark the relay failed — the client cancelled the
			// request, the relay itself is not at fault. Propagate immediately.
			// Only the *caller's* signal counts here: each attempt also carries its
			// own header-timeout budget (combined above), whose AbortError means a
			// hung relay and must mark + roll instead of vetoing the pool.
			if ((err as Error)?.name === "AbortError" && opts.signal?.aborted) {
				throw err;
			}
			const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);
			lastError = err;
			const errMsg =
				(err as Error)?.name === "AbortError"
					? `relay header timeout (${Math.round(UPSTREAM_HEADER_TIMEOUT_MS / 1000)}s exceeded)`
					: (err as Error)?.message || String(err);
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

		const directRes = await fetch(url, { ...opts, headers: directHeaders } as unknown as RequestInit);
		// lastResponse holds an unread body that would otherwise leak its socket
		// until GC; the salvage path below still needs it, so only cancel here.
		lastResponse?.body?.cancel().catch(() => {});
		affinity.onServed?.(null);
		return directRes;
	} catch (directErr) {
		const directElapsed = ((Date.now() - directStart) / 1000).toFixed(1);
		log("error", `direct fallback also failed in ${directElapsed}s`, {
			upstream: url,
			error: String(directErr),
		}, rid);
		if (disabledRelays.length > 0) {
			// Disabled deployment(s) seen and the direct fallback failed: never
			// surface the raw Vercel 402 to the host (its retry layer would
			// misfire on a 30min provider-wait). Fail fast with 503
			// relay_disabled instead so the host retries/fails over immediately.
			lastResponse?.body?.cancel().catch(() => {});
			const count = disabledRelays.length;
			const list = disabledRelays.join(", ");
			const hint = disabledRelays.map((u) => `/freeflow remove ${u}`).join("; ");
			affinity.onServed?.(null);
			return new Response(
				JSON.stringify({
					error: {
						code: "relay_disabled",
						message: `relay ${list} deployment disabled (DEPLOYMENT_DISABLED) \u2014 redeploy or ${hint}; rolled ${count} relay(s)`,
					},
				}),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
		if (lastResponse) {
			// Salvaged relay response: report the relay that produced it so the
			// caller keeps accurate affinity.
			affinity.onServed?.(lastResponseRelay);
			return lastResponse;
		}
		throw directErr || lastError;
	}
}
