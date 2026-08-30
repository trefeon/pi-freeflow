/**
 * Single-port local HTTP proxy and dynamic upstream router for pi-freeflow
 *
 * Provides loopback proxying on port 28180 (shared across parent and subagents),
 * intelligent routing to OpenCode Zen and KiloCode Gateway, and failover support.
 */

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import { handleHealthRequest } from "./health.ts";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getAliveCatalog } from "./catalog.ts";
import {
	ALLOWED_METHODS,
	ALLOWED_PATH_PATTERN,
	HOST,
	KILO_CHAT_URL,
	PATH_TRAVERSAL_PATTERN,
	MAX_BODY_BYTES,
	PORT,
	UPSTREAM_HEADER_TIMEOUT_MS,
	UPSTREAM_OPENCODE,
	opencodeHeaders,
} from "./config.ts";
import { isDebugEnabled, log } from "./logger.ts";
import { KILO_MODEL_IDS, resolveCanonicalModelId } from "./models.ts";
// normalize removed — host pi-ai already normalizes thinking/reasoning before proxy
import { checkRateLimit } from "./rate-limiter.ts";
import { agent, canUseCustomDispatcher, relayFetch } from "./relay.ts";
import { getActiveRelayState } from "./relay-state.ts";
import { pipeUpstreamStream } from "./stream-pipe.ts";
import type { Upstream } from "./types.ts";

/**
 * Direct-mode 429 hint throttle: the guidance hint is emitted at most once per
 * 10 minutes per process so repeated rate-limit responses don't spam clients.
 */
let last429HintAt = 0;
function shouldShow429Hint(): boolean {
	const now = Date.now();
	if (now - last429HintAt < 10 * 60 * 1000) return false;
	last429HintAt = now;
	return true;
}
/** Test-only: reset 429 hint throttle */
export function _reset429HintForTest(): void { last429HintAt = 0; }

/**
 * Extract client IP address from incoming HTTP request.
 */
export function getClientIP(req: http.IncomingMessage): string {
	const addr = req.socket.remoteAddress;
	if (!addr) return "unknown";
	return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/**
 * Validate that the request URL matches allowed API path patterns and prevents path traversal.
 */
export function validatePath(rawUrl: string): URL | null {
	const cleaned = rawUrl.replace(/^\/+/, "");
	if (!ALLOWED_PATH_PATTERN.test(`/${cleaned}`)) return null;
	if (PATH_TRAVERSAL_PATTERN.test(cleaned)) return null;
	try {
		const decoded = decodeURIComponent(cleaned);
		if (PATH_TRAVERSAL_PATTERN.test(decoded)) return null;
		if (decoded !== cleaned && !ALLOWED_PATH_PATTERN.test(`/${decoded}`)) {
			return null;
		}
	} catch {
		return null;
	}
	try {
		return new URL(cleaned, `${UPSTREAM_OPENCODE}/`);
	} catch {
		return null;
	}
}

/**
 * Sanitize and inject standard headers before forwarding request to upstream.
 */
export function sanitizeHeaders(
	incoming: http.IncomingHttpHeaders,
	targetHost: string,
): Record<string, string> {
	// authorization is deliberately NOT forwarded: the host provider registers
	// with a dummy key (placeholder), and zen free models are keyless — sending
	// that fake key upstream gets 401 Invalid API key. Kilo injects its own key.
	const allowed: Record<string, true> = {
		"content-type": true,
		accept: true,
		"x-request-id": true,
	};
	const sanitized: Record<string, string> = {};
	for (const [key, value] of Object.entries(incoming)) {
		const lower = key.toLowerCase();
		if (lower.startsWith(":")) continue;
		if (!allowed[lower] && !lower.startsWith("x-opencode-")) continue;
		if (typeof value === "string") sanitized[lower] = value;
		else if (Array.isArray(value)) sanitized[lower] = value.join(", ");
	}
	sanitized.host = targetHost;
	// Drop the client's own user-agent so opencodeHeaders() cannot produce a
	// duplicate (case-differing) User-Agent pair — upstream resets connections
	// that send two conflicting User-Agent headers.
	delete sanitized["user-agent"];
	Object.assign(sanitized, opencodeHeaders());
	sanitized["accept-encoding"] = "identity";
	sanitized.connection = "keep-alive";
	return sanitized;
}
export async function isProxyAlive(port: number): Promise<boolean> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	try {
		const res = await fetch(`http://${HOST}:${port}/v1/models`, {
			signal: AbortSignal.timeout(500),
		});
		const ct = res.headers.get("content-type") || "";
		return res.ok && ct.includes("application/json");
	} catch {
		return false;
	}
}

export async function getDaemonVersion(port: number): Promise<string | null> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	try {
		const res = await fetch(`http://${HOST}:${port}/_health`, {
			signal: AbortSignal.timeout(800),
		});
		if (!res.ok) return null;
		const data: unknown = await res.json();
		if (data && typeof data === "object" && "version" in data) {
			const v = data.version;
			if (typeof v === "string" && v) return v;
		}
		// Alive but no version field = pre-1.8.0 daemon (never embedded it) — stale.
		return "";
	} catch {
		return null;
	}
}

export async function killPortHolder(port: number): Promise<boolean> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	try {
		if (process.platform === "win32") {
			try {
				const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8", timeout: 3000 }) as string;
				for (const line of out.split("\n")) {
					if (!line.includes("LISTENING")) continue;
					if (!line.includes(`:${port}`)) continue;
					const parts = line.trim().split(/\s+/);
					const pid = parts[parts.length - 1];
					if (!pid || !/^\d+$/.test(pid)) continue;
					// Windows netstat report: 127.0.0.1:38180 ... LISTENING/PID
					if (Number(pid) === process.pid) continue; // never self-kill
					execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: "ignore" });
					return true;
				}
			} catch {}
			return false;
		}
		try {
			const out = execSync(`lsof -ti tcp:${port} 2>/dev/null || fuser -n tcp ${port} 2>/dev/null`, {
				encoding: "utf8",
				timeout: 3000,
			}) as string;
			const pid = out.trim().split(/\s+/)[0];
			if (!pid || !/^\d+$/.test(pid)) return false;
			if (Number(pid) === process.pid) return false; // never self-kill (Unix) — matches Windows guard at 161
			execSync(`kill -9 ${pid}`, { timeout: 3000, stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

/**
 * Tagged abort reason for the proxy-internal header-wait timeout.
 * relayFetch rethrows AbortErrors untouched, and stream-pipe recognizes
 * code FF_INTERNAL_ABORT as "our abort, not a relay fault" — so neither
 * rolls nor penalizes a healthy relay when the request merely ran slow.
 */
function upstreamTimeoutError(): Error & { code: string } {
	const err = new Error(
		`upstream header timeout (${UPSTREAM_HEADER_TIMEOUT_MS}ms)`,
	) as Error & { code: string };
	err.name = "AbortError";
	err.code = "FF_INTERNAL_ABORT";
	return err;
}

/**
 * Start the local HTTP proxy daemon.
 * Implements master/worker single-port reuse: if port 28180 is already held by a live
 * parent or sibling OMP session, resolves immediately with { server: null, port: 28180 }.
 */
export function startProxy(
	overridePort?: number,
): Promise<{ server: http.Server | null; port: number }> {
	const basePort = overridePort ?? PORT;

	const server = http.createServer((req, res) => {
		const clientIP = getClientIP(req);
		const reqId = randomUUID().slice(0, 8);
		if (isDebugEnabled()) {
			log(
				"debug",
				`incoming ${req.method} ${req.url} from ${clientIP}`,
				{ ip: clientIP, method: req.method, url: req.url },
				reqId,
			);
		}

		if (!ALLOWED_METHODS.has(req.method ?? "")) {
			res.writeHead(405, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "method not allowed" }));
			return;
		}

		if (req.method === "OPTIONS") {
			// No CORS headers: loopback proxy is not a cross-origin resource.
			// Keep a bare 204 so OPTIONS never reaches validatePath/upstream.
			res.writeHead(204);
			res.end();
			return;
		}

		let reqPathname: string | null = null;
		try {
			reqPathname = new URL(req.url ?? "/", `http://${HOST}`).pathname;
		} catch {}
		// Loopback-only health endpoint — always accessible even when widget hidden
		if (req.method === "GET" && reqPathname !== null && (reqPathname === "/_health" || reqPathname === "/health")) {
			const addr = server.address();
			const realPort = addr && typeof addr === "object" ? (addr as { port: number }).port : basePort;
			if (handleHealthRequest(req, res, realPort)) return;
		}
		if (req.method === "GET" && (reqPathname === "/v1/models" || reqPathname === "/v1/models/")) {
			const alive = getAliveCatalog();
			const body = JSON.stringify({
				object: "list",
				data: alive.map((m) => ({
					id: m.id,
					object: "model",
					created: 0,
					owned_by: m.source === "kilo" ? "kilocode" : "opencode",
				})),
			});
			res.writeHead(200, {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
			});
			res.end(body);
			return;
		}

		const target = validatePath(req.url ?? "/");
		if (!target) {
			const cleaned = (req.url ?? "/").replace(/^\/+/, "");
			if (PATH_TRAVERSAL_PATTERN.test(cleaned)) {
				res.writeHead(403, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "forbidden" }));
			} else {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "not found" }));
			}
			return;
		}
		// Buffer request body to inspect model ID for upstream routing
		const bodyChunks: Buffer[] = [];
		// Reject oversized bodies before buffering starts: the client declares
		// the size in content-length, so no transfer cost is wasted.
		const declaredLength = Number(req.headers["content-length"] ?? 0);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
			res.writeHead(413, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "payload too large" }));
			return;
		}
		let bufferedBytes = 0;
		req.on("error", (err) => {
			log(
				"warn",
				"client request error during body buffering",
				{ error: String(err) },
				reqId,
			);
			if (!res.headersSent) {
				res.writeHead(400, { "content-type": "application/json" });
			}
			res.end(JSON.stringify({ error: "bad request" }));
		});

		// Running cap for chunked/undeclared bodies: stop buffering the instant
		// the limit is crossed instead of holding the whole payload in memory.
		req.on("data", (chunk: Buffer) => {
			bufferedBytes += chunk.length;
			if (bufferedBytes > MAX_BODY_BYTES) {
				req.destroy();
				if (!res.headersSent) {
					res.writeHead(413, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "payload too large" }));
				}
				return;
			}
			bodyChunks.push(chunk);
		});

		req.on("end", async () => {
			const bodyStr = Buffer.concat(bodyChunks).toString();
			let isKilo = false;
			let parsedBody: Record<string, unknown> | null = null;

			try {
				parsedBody = JSON.parse(bodyStr);
				if (typeof parsedBody?.model === "string") {
					const canonical = resolveCanonicalModelId(parsedBody.model);
					parsedBody.model = canonical;
					if (KILO_MODEL_IDS.has(canonical)) {
						isKilo = true;
					}
				}
			} catch {}

			const upstream: Upstream = isKilo ? "kilo" : "opencode";
			const isStream = parsedBody?.stream === true;

			// Seamless sub-agent rate-limit: when relay pool is active, bypass
			// local per-IP quota (127.0.0.1 shared by all subagents) — upstream
			// quota is per-egress-IP and relayFetch already rolls on 429 across
			// 7 candidates until a response succeeds. Without this, parallel
			// subagents sharing the daemon would hit local 429 before relay failover.
			const relayPreview = getActiveRelayState();
			const willUseRelay = relayPreview.enabled && Boolean(relayPreview.url || relayPreview.relays.length > 0);
			if (!willUseRelay && !checkRateLimit(clientIP, upstream)) {
				const body: Record<string, unknown> = { error: "rate limit exceeded" };
				if (shouldShow429Hint()) {
					body.hint = "Shared free-tier IP quota reached. Add your own relay egress: /freeflow deploy (Vercel 1M/mo recommended)";
				}
				res.writeHead(429, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
				return;
			}

			try {
				if (isKilo && parsedBody) {
					// Header-wait timeout + client-disconnect abort: once headers
					// arrive the timer is cleared so a long stream is not killed at
					// the timeout ceiling; the stream phase is owned by
					// pipeUpstreamStream and its close handling.
					const kiloController = new AbortController();
					const kiloTimeoutId = setTimeout(
						() => kiloController.abort(upstreamTimeoutError()),
						UPSTREAM_HEADER_TIMEOUT_MS,
					);
					const abortKiloOnClientGone = () => {
						if (!res.writableEnded) kiloController.abort();
					};
					res.once("close", abortKiloOnClientGone);
					req.once("error", abortKiloOnClientGone);
					let response: Response;
					try {
						response = await relayFetch(
							KILO_CHAT_URL,
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Authorization: "Bearer kilo-free",
								},
								body: JSON.stringify(parsedBody),
								signal: kiloController.signal,
							},
							reqId,
						);
					} finally {
						clearTimeout(kiloTimeoutId);
						res.off("close", abortKiloOnClientGone);
						req.off("error", abortKiloOnClientGone);
					}

					if (isStream && response.ok && response.body) {
						const ct =
							response.headers.get("content-type") || "text/event-stream";
						res.writeHead(response.status, {
							"content-type": ct,
							"cache-control": "no-cache, no-transform",
							connection: "keep-alive",
							"x-accel-buffering": "no",
						});
						// Kilo is fetched directly (not via the relay pool), so pass undefined:
						// attributing kilo-side stream failures to an unrelated opencode relay
						// would mark a healthy relay as failed.
						pipeUpstreamStream(
							Readable.fromWeb(
								response.body as unknown as WebReadableStream,
							),
							res,
							req,
							reqId,
							undefined,
						);
					} else {
						const data = await response.text();
						const ct =
							response.headers.get("content-type") || "application/json";
						res.writeHead(response.status, { "content-type": ct });
						res.end(data);
					}
				} else {
					// OpenCode routing — relay when enabled, else direct upstream
					const relayState = getActiveRelayState();
					const shouldUseRelay =
						relayState.mode !== "off" &&
						relayState.enabled !== false &&
						Boolean(relayState.url || (relayState.relays && relayState.relays.length > 0));
					if (shouldUseRelay) {
						const fullUrl = `${UPSTREAM_OPENCODE}${req.url ?? "/"}`;
						const activeHost = relayState.url
							? new URL(relayState.url).host
							: "opencode.ai";
						const relayHeaders = sanitizeHeaders(req.headers, activeHost);

						try {
							if (parsedBody) {
								const relayBody = Buffer.concat(bodyChunks);
								// Header-wait timeout + client-disconnect abort; the
								// timer is cleared once headers arrive so streams are
								// not killed at the timeout ceiling. Aborts caused by
								// our own timeout are tagged FF_INTERNAL_ABORT so
								// stream-pipe never penalizes the relay for them.
								const relayController = new AbortController();
								const relayTimeoutId = setTimeout(
									() => relayController.abort(upstreamTimeoutError()),
									UPSTREAM_HEADER_TIMEOUT_MS,
								);
								const abortRelayOnClientGone = () => {
									if (!res.writableEnded) relayController.abort();
								};
								res.once("close", abortRelayOnClientGone);
								req.once("error", abortRelayOnClientGone);
								let response: Response;
								try {
									response = await relayFetch(
										fullUrl,
										{
											method: req.method || "POST",
											headers: relayHeaders,
											body: relayBody,
											signal: relayController.signal,
										},
										reqId,
									);
								} finally {
									clearTimeout(relayTimeoutId);
									res.off("close", abortRelayOnClientGone);
									req.off("error", abortRelayOnClientGone);
								}

								if (isStream && response.ok && response.body) {
									const ct =
										response.headers.get("content-type") ||
										"text/event-stream";
									res.writeHead(response.status, {
										"content-type": ct,
										"cache-control": "no-cache, no-transform",
										connection: "keep-alive",
										"x-accel-buffering": "no",
									});
									pipeUpstreamStream(
										Readable.fromWeb(
											response.body as unknown as WebReadableStream,
										),
										res,
										req,
										reqId,
										relayState.url,
									);
								} else {
									const data = await response.text();
									const ct =
										response.headers.get("content-type") ||
										"application/json";
									res.writeHead(response.status, { "content-type": ct });
									res.end(data);
								}
								return; // relay handled successfully
							}
						} catch (e) {
							log(
								"warn",
								"opencode relay failed, falling back to direct upstream",
								{ error: String(e) },
								reqId,
							);
							if (res.headersSent) return; // cannot recover mid-stream
						}
					}

					// Direct path — the relay already parsed/forwarded raw; send the buffered bytes unchanged
					const directBody = Buffer.concat(bodyChunks);

					if (isDebugEnabled()) {
						log(
							"debug",
							`direct upstream ${target.hostname}${target.pathname} (${directBody.length}B)`,
							{ model: parsedBody?.model, isKilo },
							reqId,
						);
					}

					const fwd = sanitizeHeaders(req.headers, target.hostname);
					if (directBody.length > 0) {
						fwd["content-length"] = String(directBody.byteLength);
					}
					fwd["connection"] = "keep-alive";

					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(upstreamTimeoutError()), UPSTREAM_HEADER_TIMEOUT_MS);
					const onClientClose = () => {
						if (!res.writableEnded) controller.abort();
					};
					const onReqError = () => controller.abort();
					res.on("close", onClientClose);
					req.on("error", onReqError);

					try {
						const upstreamRes = await fetch(target.href, {
							method: req.method,
							headers: fwd,
							body: directBody.length > 0 ? directBody : undefined,
							signal: controller.signal,
							...(canUseCustomDispatcher ? { dispatcher: agent } : {}),
						} as unknown as RequestInit);
						clearTimeout(timeoutId);
						res.off("close", onClientClose);
						req.off("error", onReqError);

						const outHeaders: Record<string, string> = {};
						for (const h of ["content-type", "cache-control", "x-request-id"] as const) {
							const v = upstreamRes.headers.get(h);
							if (v) outHeaders[h] = v;
						}
						outHeaders["x-content-type-options"] = "nosniff";
						outHeaders["connection"] = "keep-alive";
						const ka = upstreamRes.headers.get("keep-alive");
						if (ka) outHeaders["keep-alive"] = ka;

						res.writeHead(upstreamRes.status, outHeaders);
						if (isStream && upstreamRes.body) {
							pipeUpstreamStream(
								Readable.fromWeb(upstreamRes.body as unknown as WebReadableStream),
								res,
								req,
								reqId,
								"direct",
							);
						} else if (upstreamRes.body) {
							const nodeStream = Readable.fromWeb(upstreamRes.body as unknown as WebReadableStream);
							nodeStream.on("error", (streamErr) => {
								log("error", "upstream stream error in direct proxy", { error: String(streamErr) }, reqId);
								if (!res.writableEnded) res.end();
							});
							nodeStream.pipe(res);
						} else {
							res.end();
						}
					} catch (proxyErr) {
						clearTimeout(timeoutId);
						res.off("close", onClientClose);
						req.off("error", onReqError);
						log("error", "proxy socket error", { error: String(proxyErr) }, reqId);
						if (!res.headersSent) {
							res.writeHead(502, { "content-type": "application/json" });
							res.end(JSON.stringify({ error: "upstream error" }));
						} else if (!res.writableEnded) {
							res.end();
						}
					}
				}
			} catch (err) {
				log("error", "proxy error", { error: String(err) }, reqId);
				if (!res.headersSent) {
					res.writeHead(502, { "content-type": "application/json" });
				}
				res.end(JSON.stringify({ error: "internal error" }));
			}
		});
	});

	return new Promise<{ server: http.Server | null; port: number }>(
		(resolve, reject) => {
			let attempt = 0;
			let settled = false;

			const tryListen = async (port: number) => {
				server.removeAllListeners("error");
				server.once("error", async (err: NodeJS.ErrnoException) => {
					if (settled) return;
					if (err.code === "EADDRINUSE") {
						// Re-check if the base port is alive (attached master race)
						if (await isProxyAlive(basePort)) {
							settled = true;
							log(
								"info",
								`attached to running proxy on http://${HOST}:${basePort}`,
							);
							resolve({ server: null, port: basePort });
							return;
						}
						if (attempt < 20) {
							attempt++;
							log("warn", `port ${port} taken — trying ${port + 1}`);
							tryListen(port + 1);
							return;
						}
					}
					settled = true;
					log("error", "server error", { code: err.code, message: err.message });
					reject(err);
				});
				server.listen(port, HOST, () => {
					if (settled) return;
					settled = true;
					try {
						server.unref();
					} catch {}
					const addr = server.address();
					const realPort = addr && typeof addr === "object" ? addr.port : port;
					log("info", `proxy listening on http://${HOST}:${realPort}`);
					resolve({ server, port: realPort });
				});
			};

			tryListen(basePort);
		},
	);
}
