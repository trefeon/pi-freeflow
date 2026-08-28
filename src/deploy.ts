/**
 * Automated Vercel Edge Relay deployer for pi-freeflow
 *
 * Deploys a private 3-file Vercel edge proxy with strict target domain whitelisting.
 * The provided API token is held in-memory only and never persisted to disk or logs.
 */

import { VERCEL_API } from "./config.ts";
import { log, logError } from "./logger.ts";
import { randomBytes } from "node:crypto";

/**
 * Canonical guarded request pipeline shared by every platform relay template.
 * The platform wrappers below only adapt the entry point (Vercel fetch
 * handler / Cloudflare module worker / Deno.serve) around this core, so the
 * whitelist, SSRF guard, path resolver, header denylist, auth gate and
 * streaming forward live exactly once.
 *
 * @param relayAuth Per-deployment shared secret. Empty string disables the
 *   auth gate (legacy/manual deploys); built-in deploys always embed one.
 */
function buildRelayWorkerCore(relayAuth: string): string {
	return `// Only the 2 upstreams pi-freeflow talks to. Anything else = open proxy abuse.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
const RELAY_AUTH = ${JSON.stringify(relayAuth)};
const resolveRelayTarget = function(target, relayPath) {
  let targetUrl;
  try { targetUrl = new URL(target); } catch { return { ok: false, status: 400, reason: "invalid x-relay-target" }; }
  if (typeof relayPath !== "string" || relayPath.indexOf("@") !== -1 || relayPath.indexOf("\\") !== -1 || relayPath.charAt(0) !== "/") {
    return { ok: false, status: 403, reason: "forbidden x-relay-path" };
  }
  let finalUrl;
  try { finalUrl = new URL(relayPath, targetUrl); } catch { return { ok: false, status: 403, reason: "forbidden x-relay-path" }; }
  if (finalUrl.hostname !== targetUrl.hostname || finalUrl.protocol !== targetUrl.protocol || finalUrl.port !== targetUrl.port || finalUrl.username || finalUrl.password) {
    return { ok: false, status: 403, reason: "forbidden x-relay-path (host mismatch)" };
  }
  return { ok: true, url: finalUrl.toString() };
};
const isPrivateHostname = function(h) {
  if (!h) return true
  let host = String(h).trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (host.length > 1 && host.endsWith(".")) host = host.slice(0, -1)
  if (!host) return true
  if (host === "localhost" || host === "0.0.0.0" || host === "127.0.0.1" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true
  if (host.startsWith("::")) return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd")) return true
    if (/^fe[89ab]/.test(host)) return true
    return false
  }
  return false
};
// Constant-time string comparison (no timingSafeEqual in every edge runtime).
const timingSafeEqualStr = function(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
};
// x-relay-auth is read by the handler below, so it is stripped explicitly
// (never forwarded upstream) instead of living in the denylist.
const DENY_HEADERS = ["host", "connection", "content-length", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "transfer-encoding", "te", "trailer", "upgrade", "x-relay-target", "x-relay-path"];
async function relayHandler(req) {
  const target = req.headers.get("x-relay-target");
  if (!target) return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), { status: 400, headers: { "content-type": "application/json" } });
  if (RELAY_AUTH && !timingSafeEqualStr(req.headers.get("x-relay-auth") || "", RELAY_AUTH)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  let targetUrl;
  try { targetUrl = new URL(target); } catch { return new Response(JSON.stringify({ error: "invalid x-relay-target" }), { status: 400, headers: { "content-type": "application/json" } }); }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") return new Response(JSON.stringify({ error: "forbidden x-relay-target protocol" }), { status: 403, headers: { "content-type": "application/json" } });
  if (targetUrl.username || targetUrl.password) return new Response(JSON.stringify({ error: "forbidden x-relay-target (embedded credentials)" }), { status: 403, headers: { "content-type": "application/json" } });
  if (isPrivateHostname(targetUrl.hostname)) return new Response(JSON.stringify({ error: "forbidden x-relay-target (private/loopback host)" }), { status: 403, headers: { "content-type": "application/json" } });
  const cleanTarget = target.replace(/\/$/, "");
  if (!ALLOWED_TARGETS.includes(cleanTarget)) return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403, headers: { "content-type": "application/json" } });
  const relayPath = req.headers.get("x-relay-path") || "/";
  const resolved = resolveRelayTarget(target, relayPath);
  if (!resolved.ok) return new Response(JSON.stringify({ error: resolved.reason }), { status: resolved.status, headers: { "content-type": "application/json" } });
  const headers = new Headers(req.headers);
  DENY_HEADERS.forEach((h) => headers.delete(h));
  headers.delete("x-relay-auth");
  try {
    const init = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") { init.body = req.body; init.duplex = "half"; }
    const response = await fetch(resolved.url, init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 502, headers: { "content-type": "application/json" } });
  }
}`;
}

/**
 * Vercel Edge Function relay template: canonical core wrapped in the edge-runtime module handler.
 */
export function buildVercelRelayWorker(relayAuth: string): string {
	return `${buildRelayWorkerCore(relayAuth)}
export const config = { runtime: "edge" };
export default async function handler(req) {
  return relayHandler(req);
}`;
}

/**
 * Cloudflare Workers module relay template: canonical core wrapped in the module fetch handler.
 */
export function buildCloudflareRelayWorker(relayAuth: string): string {
	return `${buildRelayWorkerCore(relayAuth)}
export default {
  async fetch(request) {
    return relayHandler(request);
  },
};`;
}

/**
 * Deno Deploy relay script template: canonical core wrapped in Deno.serve.
 */
export function buildDenoRelayScript(relayAuth: string): string {
	return `${buildRelayWorkerCore(relayAuth)}
Deno.serve(async (request) => {
  return relayHandler(request);
});`;
}

/**
 * Public template constants (tests/README): the canonical core without a
 * secret, so the auth gate is disabled. Deployed relays always embed their
 * own per-deployment secret.
 */
export const VERCEL_RELAY_WORKER = buildVercelRelayWorker("");
export const CLOUDFLARE_RELAY_WORKER = buildCloudflareRelayWorker("");
export const DENO_RELAY_SCRIPT = buildDenoRelayScript("");

/**
 * Deploy a fresh Vercel Edge Relay project in-memory.
 *
 * @param token Vercel personal access token (used in-memory only)
 * @param name Unique project/deployment name (e.g. pi-freeflow-relay-abc123)
 * @param onProgress Optional callback for user-facing progress updates
 * @returns Deployed { url, auth } — url is the public relay URL, auth the embedded shared secret
 */
export async function deployVercelRelay(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<{ url: string; auth: string }> {
	const auth = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};

	// 1. Create deployment (3 inline files, no git repository required)
	onProgress?.("Uploading relay files to Vercel…");
	log("info", `Starting Vercel deployment: ${name}`);
	// Per-deployment shared secret: embedded in the worker, persisted on the
	// relay-state entry by the caller, and required via x-relay-auth.
	const relayAuth = randomBytes(24).toString("base64url");

	const dep = await fetch(`${VERCEL_API}/v13/deployments`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({
			name,
			files: [
				{ file: "api/relay.js", data: buildVercelRelayWorker(relayAuth) },
				{
					file: "package.json",
					data: JSON.stringify({ name, version: "1.0.0" }),
				},
				{
					file: "vercel.json",
					data: JSON.stringify({
						rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
					}),
				},
			],
			projectSettings: { framework: null },
			target: "production",
		}),
	});

	if (!dep.ok) {
		const e = (await dep
			.json()
			.catch(() => ({}))) as { error?: { message?: string } };
		const errMsg = e?.error?.message || `Vercel deploy failed (HTTP ${dep.status})`;
		logError(`Vercel deployment failed to create: ${errMsg}`);
		throw new Error(errMsg);
	}

	const depJson = (await dep.json()) as { id?: string; uid?: string; projectId?: string };
	const depId = depJson.id || depJson.uid;
	const projectId = depJson.projectId || name;

	// 2. Make the deployment public (disable SSO protection if enabled on team)
	try {
		await fetch(`${VERCEL_API}/v9/projects/${projectId}`, {
			method: "PATCH",
			headers: auth,
			body: JSON.stringify({ ssoProtection: null }),
		});
	} catch {}

	// 3. Poll until READY state (3s interval, 120s maximum timeout)
	onProgress?.("Waiting for Edge deployment to go live…");
	const deadline = Date.now() + 120_000;

	while (Date.now() < deadline) {
		let s: Response | null = null;
		try {
			s = await fetch(`${VERCEL_API}/v13/deployments/${depId}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
		} catch (err) {
			log(
				"warn",
				`Vercel deployment status poll failed, retrying: ${(err as Error).message}`,
			);
		}
		if (s?.ok) {
			const j = (await s.json()) as { readyState?: string; url?: string };
			if (j.readyState === "READY" && j.url) {
				const deployedUrl = `https://${j.url}`;
				log("info", `Vercel relay successfully deployed: ${deployedUrl}`);
				return { url: deployedUrl, auth: relayAuth };
			}
			if (j.readyState === "ERROR" || j.readyState === "CANCELED") {
				const err = `Deployment failed with state: ${j.readyState}`;
				logError(err);
				throw new Error(err);
			}
		}
		await new Promise<void>((r) => setTimeout(r, 3000));
	}

	const timeoutErr = "Deployment timed out (120s)";
	logError(timeoutErr);
	throw new Error(timeoutErr);
}

// ── Multi-platform deployment (Cloudflare Workers / Deno Deploy) ────

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const DENO_API = "https://api.deno.com/v2";

export type DeployPlatform = "vercel" | "cloudflare" | "deno";

function baseRelayName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Cloudflare Worker script names: [a-z0-9-], max 58 chars. */
function cloudflareScriptName(name: string): string {
	const clean = baseRelayName(name)
		.slice(0, 58)
		.replace(/-+$/g, "");
	return clean || "relay-worker";
}

/** Deno Deploy app slugs: [a-z0-9-], 3-32 chars, no edge/consecutive hyphens. */
function denoProjectName(name: string): string {
	const clean = baseRelayName(name)
		.slice(0, 32)
		.replace(/-+$/, "");
	if (!clean) return "relay-app";
	return clean.length < 3 ? `${clean}-relay` : clean;
}

async function cloudflareError(action: string, res: Response): Promise<Error> {
	const body = (await res
		.json()
		.catch(() => ({}))) as { errors?: Array<{ message?: string }> };
	const detail = body.errors?.[0]?.message || `HTTP ${res.status}`;
	let err: Error;
	if (res.status === 401 || res.status === 403) {
		err = /quota|limit|exceeded/i.test(detail)
			? new Error(`Cloudflare plan or usage limit hit while trying to ${action}: ${detail}. Check your Workers plan limits.`)
			: new Error(`Cloudflare authentication failed while trying to ${action}: ${detail}. Check that your API token is valid and has Workers permissions.`);
	} else {
		err = new Error(`Failed to ${action} (HTTP ${res.status}): ${detail}`);
	}
	logError(err.message);
	return err;
}

async function denoError(action: string, res: Response, override?: string): Promise<Error> {
	if (override) {
		logError(override);
		return new Error(override);
	}
	const raw = await res.text().catch(() => "");
	let detail = raw;
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: string } };
		detail = parsed.error?.message || raw;
	} catch {}
	let err: Error;
	if (res.status === 401 || res.status === 403) {
		err = /quota|limit|exceeded/i.test(detail)
			? new Error(`Deno Deploy plan or usage limit hit while trying to ${action}: ${detail}. Check your organization's limits.`)
			: new Error(`Deno Deploy authentication failed while trying to ${action}: ${detail}. Check that your access token is valid.`);
	} else {
		err = new Error(`Failed to ${action} (HTTP ${res.status}): ${detail}`);
	}
	logError(err.message);
	return err;
}

/**
 * Deploy a fresh Cloudflare Workers relay (module worker) in-memory.
 *
 * @param token Cloudflare API token (used in-memory only)
 * @param name Unique worker/script name (sanitized to [a-z0-9-])
 * @param onProgress Optional callback for user-facing progress updates
 * @returns Public { url, auth } — relay URL plus the embedded shared secret
 */
export async function deployCloudflareWorker(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<{ url: string; auth: string }> {
	const auth = { Authorization: `Bearer ${token}` };
	const scriptName = cloudflareScriptName(name);

	// 1. Resolve the account scoped to this token
	onProgress?.("Resolving Cloudflare account…");
	log("info", `Starting Cloudflare Worker deployment: ${scriptName}`);
	const accRes = await fetch(`${CLOUDFLARE_API}/accounts`, { headers: auth });
	if (!accRes.ok) throw await cloudflareError("resolve Cloudflare account", accRes);
	const accJson = (await accRes.json()) as { result?: Array<{ id?: string }> };
	const accountId = accJson.result?.[0]?.id;
	if (!accountId) {
		const err = "No Cloudflare account is accessible with this API token";
		logError(err);
		throw new Error(err);
	}

	// 2. Upload the module worker script (multipart: main module + metadata)
	onProgress?.("Uploading relay worker to Cloudflare…");
	// Per-deployment shared secret: embedded in the worker, persisted on the
	// relay-state entry by the caller, and required via x-relay-auth.
	const relayAuth = randomBytes(24).toString("base64url");
	const formData = new FormData();
	formData.append(
		"index.js",
		new Blob([buildCloudflareRelayWorker(relayAuth)], { type: "application/javascript+module" }),
		"index.js",
	);
	formData.append(
		"metadata",
		new Blob(
			[
				JSON.stringify({
					main_module: "index.js",
					compatibility_date: "2024-03-20",
					observability: { enabled: true },
				}),
			],
			{ type: "application/json" },
		),
		"metadata.json",
	);
	const uploadRes = await fetch(
		`${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
		{ method: "PUT", headers: auth, body: formData },
	);
	if (!uploadRes.ok) throw await cloudflareError("upload Worker to Cloudflare", uploadRes);

	// 3. Enable workers.dev routing for the script (non-fatal if it fails)
	try {
		await fetch(`${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
	} catch {}

	// 4. Read the account-level workers.dev subdomain to assemble the public URL
	onProgress?.("Reading workers.dev routing…");
	const subRes = await fetch(`${CLOUDFLARE_API}/accounts/${accountId}/workers/subdomain`, { headers: auth });
	if (!subRes.ok) throw await cloudflareError("retrieve workers.dev subdomain", subRes);
	const subJson = (await subRes.json()) as { result?: { subdomain?: string } };
	const subdomain = subJson.result?.subdomain;
	if (!subdomain) {
		const err = "Worker deployed but workers.dev subdomain is unavailable. Enable a workers.dev subdomain for your account in the Cloudflare dashboard.";
		logError(err);
		throw new Error(err);
	}
	const url = `https://${scriptName}.${subdomain}.workers.dev`;
	log("info", `Cloudflare relay successfully deployed: ${url}`);
	return { url, auth: relayAuth };
}

type DenoRevision = {
	status?: string;
	failure_reason?: string | null;
	timelines?: Array<{ slug?: string; domains?: Array<{ domain?: string }> }>;
};

function resolveRoutedDomain(revision: DenoRevision): string | null {
	const timelines = revision.timelines ?? [];
	const production = timelines.find((t) => t.slug === "production") ?? timelines[0];
	const host = (production?.domains ?? [])
		.map((d) => d.domain ?? "")
		.find((h) => h.length > 0);
	return host ?? null;
}

async function firstManagedDenoDomain(token: string): Promise<string | null> {
	const res = await fetch(`${DENO_API}/domains`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) return null;
	const list = (await res.json().catch(() => [])) as Array<{ domain?: string }>;
	const managed = (Array.isArray(list) ? list : [])
		.map((d) => d.domain ?? "")
		.find((h) => h.endsWith(".deno.net"));
	return managed ? managed.replace(/^\*\./, "") : null;
}

/**
 * Deploy a fresh Deno Deploy relay (Deno.serve script) in-memory.
 * The v2 API is scoped to the token's organization, so no org input is needed.
 *
 * @param token Deno Deploy organization access token (used in-memory only)
 * @param name Unique app/project name (sanitized to a valid slug)
 * @param onProgress Optional callback for user-facing progress updates
 * @returns Public { url, auth } — relay URL plus the embedded shared secret
 */
export async function deployDenoRelay(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<{ url: string; auth: string }> {
	const auth = { Authorization: `Bearer ${token}` };
	const jsonHeaders = { ...auth, "Content-Type": "application/json" };
	const slug = denoProjectName(name);

	// 1. Create the app
	onProgress?.("Creating Deno Deploy app…");
	log("info", `Starting Deno Deploy deployment: ${slug}`);
	const createRes = await fetch(`${DENO_API}/apps`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify({
			slug,
			labels: { "custom.kind": "relay" },
			config: {
				install: "deno install",
				runtime: { type: "dynamic", entrypoint: "main.ts" },
			},
		}),
	});
	if (!createRes.ok) {
		throw await denoError(
			`create Deno Deploy app "${slug}"`,
			createRes,
			createRes.status === 409
				? `An app named "${slug}" already exists on Deno Deploy — choose a different name.`
				: undefined,
		);
	}
	const app = (await createRes.json()) as { id?: string };
	const appId = app.id;
	if (!appId) {
		const err = "Deno Deploy did not return an app id";
		logError(err);
		throw new Error(err);
	}
	const deleteApp = (): Promise<void> =>
		fetch(`${DENO_API}/apps/${appId}`, { method: "DELETE", headers: auth })
			.then(() => undefined)
			.catch(() => {});

	// 2. Push the relay source as a single-file revision
	onProgress?.("Uploading relay script to Deno Deploy…");
	// Per-deployment shared secret: embedded in the worker, persisted on the
	// relay-state entry by the caller, and required via x-relay-auth.
	const relayAuth = randomBytes(24).toString("base64url");
	const deployRes = await fetch(`${DENO_API}/apps/${appId}/deploy`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify({
			assets: {
				"main.ts": { kind: "file", content: buildDenoRelayScript(relayAuth), encoding: "utf-8" },
			},
		}),
	});
	if (!deployRes.ok) {
		await deleteApp();
		throw await denoError("upload relay script", deployRes);
	}
	const revision = (await deployRes.json()) as { id?: string };
	const revisionId = revision.id;
	if (!revisionId) {
		await deleteApp();
		const err = "Deno Deploy did not return a revision id";
		logError(err);
		throw new Error(err);
	}

	// 3. Poll until the revision succeeds (2s interval, 120s maximum timeout)
	onProgress?.("Waiting for Deno Deploy build to finish…");
	const deadline = Date.now() + 120_000;
	let info: DenoRevision | undefined;

	while (Date.now() < deadline) {
		await new Promise<void>((r) => setTimeout(r, 2000));
		let s: Response | null = null;
		try {
			s = await fetch(`${DENO_API}/revisions/${revisionId}`, { headers: auth });
		} catch (err) {
			log(
				"warn",
				`Deno Deploy revision status poll failed, retrying: ${(err as Error).message}`,
			);
		}
		if (!s?.ok) continue;
		info = (await s.json()) as DenoRevision;
		if (info.status === "succeeded") break;
		if (info.status === "failed" || info.status === "skipped") {
			await deleteApp();
			const reason = info.failure_reason ? ` (${info.failure_reason})` : "";
			const err = `Deno Deploy build failed${reason}`;
			logError(err);
			throw new Error(err);
		}
	}
	if (info?.status !== "succeeded") {
		await deleteApp();
		const timeoutErr = "Deployment timed out (120s)";
		logError(timeoutErr);
		throw new Error(timeoutErr);
	}

	// 4. Resolve the public URL: prefer the hostname routed to this revision,
	// falling back to the org's managed *.deno.net wildcard domain.
	onProgress?.("Resolving public URL…");
	const routed = resolveRoutedDomain(info);
	if (routed) {
		const url = `https://${routed}`;
		log("info", `Deno Deploy relay successfully deployed: ${url}`);
		return { url, auth: relayAuth };
	}
	const managed = await firstManagedDenoDomain(token);
	if (!managed) {
		const err = `Deployed but could not determine the public URL for "${slug}". Check the app's domain in the Deno Deploy dashboard.`;
		logError(err);
		throw new Error(err);
	}
	const url = `https://${slug}.${managed}`;
	log("info", `Deno Deploy relay successfully deployed: ${url}`);
	return { url, auth: relayAuth };
}
