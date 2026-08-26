/**
 * Automated Vercel Edge Relay deployer for pi-freeflow
 *
 * Deploys a private 3-file Vercel edge proxy with strict target domain whitelisting.
 * The provided API token is held in-memory only and never persisted to disk or logs.
 */

import { VERCEL_API } from "./config.ts";
import { log, logError } from "./logger.ts";

/**
 * Hardened Edge Worker code deployed to Vercel.
 * Strictly whitelists OpenCode Zen and KiloCode Gateway endpoints to prevent open proxy abuse.
 */
export const VERCEL_RELAY_WORKER = `// Only the 2 upstreams pi-freeflow talks to. Anything else = open proxy abuse.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
export const config = { runtime: "edge" };
export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), { status: 400, headers: { "content-type": "application/json" } });
  const cleanTarget = target.replace(/\\/$/, "");
  if (!ALLOWED_TARGETS.includes(cleanTarget)) return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403, headers: { "content-type": "application/json" } });
  if (!relayPath.startsWith("/")) return new Response(JSON.stringify({ error: "Bad path" }), { status: 400, headers: { "content-type": "application/json" } });
  const targetUrl = cleanTarget + relayPath;
  const headers = new Headers(req.headers);
  headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
  const response = await fetch(targetUrl, { method: req.method, headers, body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined, duplex: "half" });
  return new Response(response.body, { status: response.status, headers: response.headers });
}`;

/**
 * Deploy a fresh Vercel Edge Relay project in-memory.
 *
 * @param token Vercel personal access token (used in-memory only)
 * @param name Unique project/deployment name (e.g. pi-freeflow-relay-abc123)
 * @param onProgress Optional callback for user-facing progress updates
 * @returns Deployed HTTPS relay URL
 */
export async function deployVercelRelay(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<string> {
	const auth = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};

	// 1. Create deployment (3 inline files, no git repository required)
	onProgress?.("Uploading relay files to Vercel…");
	log("info", `Starting Vercel deployment: ${name}`);

	const dep = await fetch(`${VERCEL_API}/v13/deployments`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({
			name,
			files: [
				{ file: "api/relay.js", data: VERCEL_RELAY_WORKER },
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
		const s = await fetch(`${VERCEL_API}/v13/deployments/${depId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (s.ok) {
			const j = (await s.json()) as { readyState?: string; url?: string };
			if (j.readyState === "READY" && j.url) {
				const deployedUrl = `https://${j.url}`;
				log("info", `Vercel relay successfully deployed: ${deployedUrl}`);
				return deployedUrl;
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

/**
 * Module Worker relay deployed to Cloudflare Workers.
 * Same whitelist contract as the Vercel Edge relay, without Vercel's
 * `config` export or undici-only `duplex` flag (plain body passthrough).
 */
export const CLOUDFLARE_RELAY_WORKER = `// Only the 2 upstreams this relay talks to. Anything else = open proxy abuse.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
export default {
  async fetch(request) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    if (!target) return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), { status: 400, headers: { "content-type": "application/json" } });
    const cleanTarget = target.replace(/\\/$/, "");
    if (!ALLOWED_TARGETS.includes(cleanTarget)) return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403, headers: { "content-type": "application/json" } });
    if (!relayPath.startsWith("/")) return new Response(JSON.stringify({ error: "Bad path" }), { status: 400, headers: { "content-type": "application/json" } });
    const headers = new Headers(request.headers);
    headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
    try {
      const response = await fetch(cleanTarget + relayPath, { method: request.method, headers, body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined });
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), { status: 502, headers: { "content-type": "application/json" } });
    }
  },
};`;

/**
 * Relay script deployed to Deno Deploy (Deno.serve variant).
 * Same whitelist contract; plain streaming passthrough, no duplex flag.
 */
export const DENO_RELAY_SCRIPT = `// Only the 2 upstreams this relay talks to. Anything else = open proxy abuse.
const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];
Deno.serve(async (request) => {
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";
  if (!target) return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), { status: 400, headers: { "content-type": "application/json" } });
  const cleanTarget = target.replace(/\\/$/, "");
  if (!ALLOWED_TARGETS.includes(cleanTarget)) return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403, headers: { "content-type": "application/json" } });
  if (!relayPath.startsWith("/")) return new Response(JSON.stringify({ error: "Bad path" }), { status: 400, headers: { "content-type": "application/json" } });
  const headers = new Headers(request.headers);
  headers.delete("x-relay-target"); headers.delete("x-relay-path"); headers.delete("host");
  try {
    const response = await fetch(cleanTarget + relayPath, { method: request.method, headers, body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined });
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 502, headers: { "content-type": "application/json" } });
  }
});`;

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
 * @returns Public *.workers.dev relay URL
 */
export async function deployCloudflareWorker(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<string> {
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
	const formData = new FormData();
	formData.append(
		"index.js",
		new Blob([CLOUDFLARE_RELAY_WORKER], { type: "application/javascript+module" }),
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
	return url;
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
 * @returns Public *.deno.dev-style (*.deno.net) relay URL
 */
export async function deployDenoRelay(
	token: string,
	name: string,
	onProgress?: (msg: string) => void,
): Promise<string> {
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
	const deployRes = await fetch(`${DENO_API}/apps/${appId}/deploy`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify({
			assets: {
				"main.ts": { kind: "file", content: DENO_RELAY_SCRIPT, encoding: "utf-8" },
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
		const s = await fetch(`${DENO_API}/revisions/${revisionId}`, { headers: auth });
		if (!s.ok) continue;
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
		return url;
	}
	const managed = await firstManagedDenoDomain(token);
	if (!managed) {
		const err = `Deployed but could not determine the public URL for "${slug}". Check the app's domain in the Deno Deploy dashboard.`;
		logError(err);
		throw new Error(err);
	}
	const url = `https://${slug}.${managed}`;
	log("info", `Deno Deploy relay successfully deployed: ${url}`);
	return url;
}
