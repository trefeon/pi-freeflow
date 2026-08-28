/**
 * Unit tests for multi-platform relay deployment (Cloudflare Workers / Deno Deploy).
 * All network traffic is stubbed via globalThis.fetch; tokens are fake and only
 * exist in-memory to assert they never leak into messages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCloudflareRelayWorker,
	buildDenoRelayScript,
	buildVercelRelayWorker,
	CLOUDFLARE_RELAY_WORKER,
	DENO_RELAY_SCRIPT,
	VERCEL_RELAY_WORKER,
	deployCloudflareWorker,
	deployDenoRelay,
	deployVercelRelay,
	type DeployPlatform,
} from "../src/deploy.ts";

type StubResponse = { status?: number; body?: unknown; reject?: string };
type RecordedCall = { url: string; init?: RequestInit };

/** Replace globalThis.fetch with a scripted responder; auto-restores after the test. */
function stubFetch(
	t: test.TestContext,
	responder: (url: string, init: RequestInit | undefined, call: number) => StubResponse,
): RecordedCall[] {
	const calls: RecordedCall[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, init });
		const r = responder(url, init, calls.length - 1);
		if (r.reject) throw new Error(r.reject);
		const status = r.status ?? 200;
		const payload = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
		return new Response(payload, {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	return calls;
}

/**
 * Make polling sleeps resolve immediately so revision-poll loops finish fast.
 * Only ever used alongside terminal-status stubs, so loops cannot spin unbounded.
 */
function instantTimers(t: test.TestContext): void {
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((cb: () => void) => {
		queueMicrotask(cb);
		return 0;
	}) as unknown as typeof setTimeout;
	t.after(() => {
		globalThis.setTimeout = original;
	});
}

test("relay worker sources keep the whitelist contract on every platform", () => {
	const TEST_AUTH = "test-secret-w-0123456789abcdef0123456789";
	for (const [label, src] of [
		["cloudflare", buildCloudflareRelayWorker(TEST_AUTH)],
		["deno", buildDenoRelayScript(TEST_AUTH)],
	] as const) {
		assert.match(src, /\["https:\/\/opencode\.ai", "https:\/\/api\.kilo\.ai"\]/);
		assert.match(src, /x-relay-target/);
		assert.match(src, /x-relay-path/);
		assert.match(src, /charAt\(0\) !== "\/"/, `${label}: bad-path guard`);
		assert.match(src, /status: 403/, `${label}: non-whitelisted target rejected`);
		assert.match(src, /status: 400/, `${label}: missing header rejected`);
		assert.match(src, /headers\.delete\(h\)/, `${label}: header denylist stripped`);
		assert.ok(src.includes('"host"'), `${label}: host in denylist`);
		assert.equal(src.includes("export const config"), false, `${label}: no Vercel config`);
		assert.ok(src.includes('duplex'), `${label}: duplex half for streaming`);
		// Per-deployment auth: secret embedded, enforced constant-time, never forwarded upstream.
		assert.ok(src.includes(`const RELAY_AUTH = ${JSON.stringify(TEST_AUTH)};`), `${label}: embedded auth secret`);
		assert.match(src, /timingSafeEqualStr/, `${label}: constant-time compare`);
		assert.match(src, /status: 401/, `${label}: unauthorized rejected`);
		assert.ok(src.includes('headers.delete("x-relay-auth")'), `${label}: auth stripped before forwarding`);
	}
	assert.match(buildCloudflareRelayWorker(TEST_AUTH), /export default\s*\{[\s\S]*async fetch/);
	assert.doesNotMatch(buildCloudflareRelayWorker(TEST_AUTH), /^export (const|async function)/m);
	assert.match(buildDenoRelayScript(TEST_AUTH), /\nDeno\.serve\(async \(request\) => \{/);
	// Vercel wrapper keeps the edge-runtime module handler.
	assert.match(buildVercelRelayWorker(TEST_AUTH), /export const config/);
	// Static constants: canonical core without a secret (auth gate disabled).
	assert.ok(VERCEL_RELAY_WORKER.includes('const RELAY_AUTH = "";'), "static constant must ship no secret");
	assert.ok(CLOUDFLARE_RELAY_WORKER.includes('const RELAY_AUTH = "";'), "static constant must ship no secret");
	assert.ok(DENO_RELAY_SCRIPT.includes('const RELAY_AUTH = "";'), "static constant must ship no secret");
});

test("DeployPlatform union exposes all three platforms", () => {
	const platforms: DeployPlatform[] = ["vercel", "cloudflare", "deno"];
	assert.deepEqual(platforms.sort(), ["cloudflare", "deno", "vercel"]);
});

test("deployCloudflareWorker uploads module worker and returns workers.dev URL", async (t) => {
	instantTimers(t);
	const TOKEN = "cf-fake-token";
	const calls = stubFetch(t, (url, init) => {
		if (url.endsWith("/client/v4/accounts")) {
			return { body: { success: true, result: [{ id: "acct123" }] } };
		}
		if (url.endsWith("/workers/scripts/my-relay/subdomain")) {
			return { body: { success: true } };
		}
		if (url.includes("/workers/scripts/my-relay")) {
			return { body: { success: true, result: { id: "my-relay" } } };
		}
		if (url.includes("/workers/subdomain")) {
			return { body: { success: true, result: { subdomain: "mysub" } } };
		}
		return { status: 500, body: { errors: [{ message: `unexpected ${init?.method} ${url}` }] } };
	});
	const progress: string[] = [];

	const deployed = await deployCloudflareWorker(TOKEN, "My Relay", (m) => progress.push(m));

	assert.equal(deployed.url, "https://my-relay.mysub.workers.dev");
	assert.match(deployed.auth, /^[A-Za-z0-9_-]{32}$/, "relay auth must be a 32-char base64url secret");
	assert.equal(deployed.auth.includes(TOKEN), false, "relay auth must never leak the API token");

	// Multipart upload carries metadata + main module part
	const upload = calls.find((c) => c.init?.method === "PUT");
	assert.ok(upload, "expected PUT script upload");
	assert.match(upload!.url, /\/accounts\/acct123\/workers\/scripts\/my-relay$/);
	const fd = upload!.init?.body as FormData;
	assert.ok(fd instanceof FormData);
	const meta = JSON.parse(await (fd.get("metadata") as Blob).text());
	assert.equal((fd.get("metadata") as Blob).type, "application/json");
	assert.equal(meta.main_module, "index.js");
	assert.ok(meta.compatibility_date);
	const mainPart = fd.get("index.js") as Blob;
	assert.equal(mainPart.type, "application/javascript+module");
	const mainSource = await mainPart.text();
	assert.match(mainSource, /ALLOWED_TARGETS/);
	assert.match(mainSource, /timingSafeEqualStr/);
	assert.ok(mainSource.includes(`const RELAY_AUTH = ${JSON.stringify(deployed.auth)};`), "uploaded worker must embed the returned auth secret");

	// workers.dev routing was enabled explicitly
	assert.ok(
		calls.some(
			(c) => c.init?.method === "POST" && c.url.endsWith("/scripts/my-relay/subdomain"),
		),
	);

	// Bearer token on every API call; never leaked into progress lines
	for (const c of calls) {
		assert.equal(new Headers(c.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
	}
	for (const m of progress) assert.equal(m.includes(TOKEN), false);
});

test("deployCloudflareWorker throws actionable auth error on 401 and never uploads", async (t) => {
	const TOKEN = "cf-bad-token";
	const calls = stubFetch(t, () => ({
		status: 401,
		body: { errors: [{ message: "Invalid API Token" }] },
	}));

	await assert.rejects(deployCloudflareWorker(TOKEN, "relay-x"), (e: unknown) => {
		const msg = (e as Error).message;
		return (
			/authentication failed/i.test(msg) &&
			msg.includes("Invalid API Token") &&
			!msg.includes(TOKEN)
		);
	});
	for (const c of calls) assert.ok(c.url.endsWith("/client/v4/accounts"));
});

test("deployCloudflareWorker surfaces plan/quota limits distinctly", async (t) => {
	stubFetch(t, () => ({
		status: 403,
		body: { errors: [{ message: "Workers free plan usage limit exceeded" }] },
	}));
	await assert.rejects(deployCloudflareWorker("cf-tok", "relay-x"), /plan or usage limit/i);
});

test("deployDenoRelay creates app, pushes script, polls revision, resolves routed domain", async (t) => {
	instantTimers(t);
	const TOKEN = "ddo-fake-token";
	const calls = stubFetch(t, (url, init) => {
		if (url.endsWith("/v2/revisions/rev-1")) {
			return {
				body: {
					id: "rev-1",
					status: "succeeded",
					timelines: [
						{
							slug: "production",
							partition: {},
							domains: [{ domain: "my-app.my-org.deno.net" }],
						},
					],
				},
			};
		}
		if (url.endsWith("/v2/apps/app-uuid-1/deploy") && init?.method === "POST") {
			return { body: { id: "rev-1", status: "queued" } };
		}
		if (url.endsWith("/v2/apps") && init?.method === "POST") {
			return { body: { id: "app-uuid-1", slug: "my-app" } };
		}
		return { status: 500, body: { error: { message: `unexpected ${init?.method} ${url}` } } };
	});
	const progress: string[] = [];

	const deployed = await deployDenoRelay(TOKEN, "My App", (m) => progress.push(m));

	assert.equal(deployed.url, "https://my-app.my-org.deno.net");
	assert.match(deployed.auth, /^[A-Za-z0-9_-]{32}$/, "deno relay auth must be base64url");

	// App creation requests a dynamic runtime with main.ts entrypoint
	const createCall = calls.find((c) => c.url.endsWith("/v2/apps") && c.init?.method === "POST");
	const created = JSON.parse(String(createCall!.init!.body));
	assert.equal(created.slug, "my-app");
	assert.equal(created.config.runtime.entrypoint, "main.ts");

	// Assets push embeds the Deno relay source
	const deployCall = calls.find((c) => c.url.endsWith("/apps/app-uuid-1/deploy"));
	const sent = JSON.parse(String(deployCall!.init!.body));
	assert.equal(sent.assets["main.ts"].kind, "file");
	assert.match(sent.assets["main.ts"].content, /ALLOWED_TARGETS/);
	assert.match(sent.assets["main.ts"].content, /Deno\.serve\(/);
	assert.ok(sent.assets["main.ts"].content.includes(`const RELAY_AUTH = ${JSON.stringify(deployed.auth)};`), "deno script must embed the returned auth secret");

	// Happy path never tears the app down; token never leaks into progress
	assert.equal(calls.some((c) => c.init?.method === "DELETE"), false);
	for (const m of progress) assert.equal(m.includes(TOKEN), false);
});

test("deployDenoRelay falls back to managed *.deno.net domain when timelines are bare", async (t) => {
	instantTimers(t);
	stubFetch(t, (url, init) => {
		if (url.endsWith("/v2/revisions/rev-1")) {
			return { body: { id: "rev-1", status: "succeeded", timelines: [] } };
		}
		if (url.endsWith("/v2/apps/app-uuid-1/deploy")) return { body: { id: "rev-1", status: "queued" } };
		if (url.endsWith("/v2/apps") && init?.method === "POST") return { body: { id: "app-uuid-1" } };
		if (url.endsWith("/v2/domains")) return { body: [{ domain: "*.my-org.deno.net" }] };
		return { status: 500, body: { error: { message: `unexpected ${init?.method} ${url}` } } };
	});

	const deployed = await deployDenoRelay("ddo-tok", "my-app");
	assert.equal(deployed.url, "https://my-app.my-org.deno.net");
	assert.match(deployed.auth, /^[A-Za-z0-9_-]{32}$/, "deno relay auth must be base64url");
});

test("deployDenoRelay throws actionable auth error on 401 before creating anything", async (t) => {
	const TOKEN = "ddo-bad-token";
	const calls = stubFetch(t, () => ({
		status: 401,
		body: { error: { code: "UNAUTHENTICATED", message: "invalid token" } },
	}));

	await assert.rejects(deployDenoRelay(TOKEN, "relay-x"), (e: unknown) => {
		const msg = (e as Error).message;
		return (
			/authentication failed/i.test(msg) &&
			msg.includes("invalid token") &&
			!msg.includes(TOKEN)
		);
	});
	assert.equal(calls.length, 1);
});

test("deployDenoRelay deletes the app when the build fails", async (t) => {
	instantTimers(t);
	const calls = stubFetch(t, (url, init) => {
		if (url.endsWith("/v2/revisions/rev-9")) {
			return { body: { id: "rev-9", status: "failed", failure_reason: "error" } };
		}
		if (url.endsWith("/v2/apps/app-9/deploy")) return { body: { id: "rev-9", status: "queued" } };
		if (url.endsWith("/v2/apps") && init?.method === "POST") return { body: { id: "app-9" } };
		return { status: 500, body: { error: { message: `unexpected ${init?.method} ${url}` } } };
	});

	await assert.rejects(deployDenoRelay("ddo-tok", "doomed-app"), /build failed/);
	assert.ok(
		calls.some((c) => c.url.endsWith("/v2/apps/app-9") && c.init?.method === "DELETE"),
		"expected app cleanup DELETE",
	);
});

test("cloudflare script names are sanitized to [a-z0-9-]", async (t) => {
	const TOKEN = "cf-tok";
	const calls = stubFetch(t, (url, init) => {
		if (url.endsWith("/client/v4/accounts")) return { body: { result: [{ id: "acct" }] } };
		if (/\/workers\/scripts\/[^/]+\/subdomain$/.test(url)) return { body: {} };
		if (url.includes("/workers/subdomain")) return { body: { result: { subdomain: "s" } } };
		if (url.includes("/workers/scripts/")) return { body: {} };
		return { status: 400, body: { errors: [{ message: `unexpected ${init?.method} ${url}` }] } };
	});

	await deployCloudflareWorker(TOKEN, "My Relay_v2!");
	let puts = calls.filter((c) => c.init?.method === "PUT");
	assert.match(puts[puts.length - 1]!.url, /\/workers\/scripts\/my-relay-v2$/);

	await deployCloudflareWorker(TOKEN, "///");
	puts = calls.filter((c) => c.init?.method === "PUT");
	assert.match(puts[puts.length - 1]!.url, /\/workers\/scripts\/relay-worker$/);
});

test("deno app names are sanitized to valid 3-32 char slugs", async (t) => {
	instantTimers(t);
	const slugs: string[] = [];
	stubFetch(t, (url, init) => {
		if (url.endsWith("/v2/revisions/rev-1")) {
			return {
				body: {
					id: "rev-1",
					status: "succeeded",
					timelines: [{ slug: "production", domains: [{ domain: "d.my-org.deno.net" }] }],
				},
			};
		}
		if (url.endsWith("/apps/app-1/deploy")) return { body: { id: "rev-1", status: "queued" } };
		if (url.endsWith("/v2/apps") && init?.method === "POST") {
			slugs.push(JSON.parse(String(init!.body)).slug);
			return { body: { id: "app-1" } };
		}
		return { status: 400, body: { error: { message: `unexpected ${init?.method} ${url}` } } };
	});

	// Short names are padded to the 3-char minimum
	await deployDenoRelay("ddo-tok", "AB");
	// Long names truncate to 32 chars without a trailing hyphen
	await deployDenoRelay("ddo-tok", "a-".repeat(20));
	// Names with nothing valid fall back deterministically
	await deployDenoRelay("ddo-tok", "???");

	assert.equal(slugs[0], "ab-relay");
	assert.equal(slugs[1], `${"a-".repeat(15)}a`);
	assert.equal(slugs[2], "relay-app");
	for (const s of slugs) {
		assert.match(s, /^[a-z0-9-]{3,32}$/);
		assert.equal(s.startsWith("-") || s.endsWith("-"), false);
		assert.equal(s.includes("--"), false);
	}
});

test("deployVercelRelay keeps its existing contract (regression guard)", async (t) => {
	instantTimers(t);
	const calls = stubFetch(t, (url, init) => {
		if (url.includes("/v13/deployments/")) {
			return { body: { readyState: "READY", url: "relay-test.vercel.app" } };
		}
		if (url.includes("/v13/deployments") && init?.method === "POST") {
			return { body: { id: "dep1", projectId: "proj1" } };
		}
		if (url.includes("/v9/projects/")) return { body: {} };
		return { status: 500, body: { error: { message: `unexpected ${init?.method} ${url}` } } };
	});

	const deployed = await deployVercelRelay("vercel-tok", "relay-name");
	assert.equal(deployed.url, "https://relay-test.vercel.app");
	assert.ok(calls.some((c) => c.init?.body && String(c.init.body).includes("api/relay.js")));
});

test("deployVercelRelay survives a transient status-poll network failure", async (t) => {
	instantTimers(t);
	let pollAttempts = 0;
	const calls = stubFetch(t, (url, init) => {
		if (url.includes("/v13/deployments/")) {
			return pollAttempts++ === 0
				? { reject: "getaddrinfo EAI_AGAIN api.vercel.com" }
				: { body: { readyState: "READY", url: "relay-test.vercel.app" } };
		}
		if (url.includes("/v13/deployments") && init?.method === "POST") {
			return { body: { id: "dep1", projectId: "proj1" } };
		}
		if (url.includes("/v9/projects/")) return { body: {} };
		return { status: 500, body: {} };
	});

	const deployed = await deployVercelRelay("vercel-tok", "relay-name");
	assert.equal(deployed.url, "https://relay-test.vercel.app");
	assert.ok(calls.length >= 4); // create + sso patch + failed poll + successful poll
});
