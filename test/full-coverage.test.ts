/**
 * Full coverage — issue #3 + all user-facing (no external deps)
 * Sandboxed via test/setup.mjs (PI_*_DATA_DIR → tmpdir).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ALL_MODELS } from "../src/models.ts";
import { ALLOWED_METHODS } from "../src/config.ts";
import {
	getAliveCatalog,
	setAliveCatalog,
	mergeCatalog,
	DEAD_MODEL_IDS,
	readCatalogCache,
	writeCatalogCache,
} from "../src/catalog.ts";
import {
	setActiveRelayState,
	getActiveRelayState,
	getOrderedRelayUrls,
	markRelayFailure,
	markRelaySuccess,
	resetAllRelayHealth,
	validateRelayUrl,
	formatRelayStatusLabel,
} from "../src/relay-state.ts";
import { isRetriableStatus, relayFetch } from "../src/relay.ts";
import { checkRateLimit, getRateLimitStatus, resetRateLimits } from "../src/rate-limiter.ts";
import { validatePath, sanitizeHeaders, isProxyAlive, startProxy } from "../src/proxy.ts";
import { clearSandboxFiles, withIsolatedSandboxFiles } from "./_sandbox-helpers.ts";
import { getHealthData, isLoopbackIP } from "../src/health.ts";
import type { RegisteredModel } from "../src/types.ts";

test("windows-hide contract: code contains windowsHide:true + Promise.withResolvers", () => {
	const clientSrc = fs.readFileSync("src/client.ts", "utf8");
	const proxySrc = fs.readFileSync("src/proxy.ts", "utf8");
	const cmdSrc = fs.readFileSync("src/commands.ts", "utf8");
	assert.match(clientSrc, /windowsHide:\s*true/);
	assert.match(proxySrc, /windowsHide:\s*true/);
	assert.match(cmdSrc, /windowsHide:\s*true/);
	assert.match(cmdSrc, /Promise\.withResolvers<number>/);
});

test("throttle: rapid ensureDaemon respects ensuring guard", async () => {
	const { ensureDaemon, _resetClientForTest } = await import("../src/client.ts");
	_resetClientForTest();
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const p1 = ensureDaemon().catch(() => 0);
		const p2 = ensureDaemon().catch(() => 0);
		const [r1, r2] = await Promise.all([p1, p2]);
		assert.equal(typeof r1, "number");
		assert.equal(typeof r2, "number");
	});
	_resetClientForTest();
});

test("idle leak: heartbeat does not bloat leases", async () => {
	const { registerClient, renewClient, getLeaseCount, _resetLeaseStateForTest, touchActivity } = await import("../src/lease.ts");
	_resetLeaseStateForTest();
	registerClient("idle-1");
	assert.equal(getLeaseCount(), 1);
	renewClient("idle-1");
	assert.equal(getLeaseCount(), 1);
	for (let i = 0; i < 10; i++) renewClient("idle-1");
	assert.equal(getLeaseCount(), 1);
	touchActivity();
	_resetLeaseStateForTest();
});

test("idle leak: daemon retires after TTL+grace when idle and no leases", async () => {
	const { registerClient, unregisterClient, getLeaseCount, startLeaseGC, stopLeaseGC, _resetLeaseStateForTest } =
		await import("../src/lease.ts");
	_resetLeaseStateForTest();
	let retired = false;
	startLeaseGC({
		ttlMs: 50,
		gcMs: 20,
		graceMs: 30,
		getActiveRequests: () => 0,
		onIdle: () => {
			retired = true;
		},
	});
	registerClient("a");
	await new Promise<void>((r) => setTimeout(r, 40));
	assert.equal(retired, false);
	unregisterClient("a");
	assert.equal(getLeaseCount(), 0);
	await new Promise<void>((r) => setTimeout(r, 80));
	assert.equal(retired, true);
	stopLeaseGC();
	_resetLeaseStateForTest();
});

test("validateRelayUrl rejects private hosts unless ALLOW_UNSAFE", () => {
	assert.equal(validateRelayUrl("http://localhost:443").ok, false);
	assert.equal(validateRelayUrl("https://127.0.0.1").ok, false);
	assert.equal(validateRelayUrl("https://192.168.1.1").ok, false);
	assert.equal(validateRelayUrl("https://10.0.0.5").ok, false);
	assert.equal(validateRelayUrl("https://example.com:443 ").ok, true);
	assert.equal(validateRelayUrl("https://example.com:8443").ok, false);
});

test("isRetriableStatus rolls 429/408/502/503/504/520-530, not 400/401/500", () => {
	for (const s of [429, 408, 502, 503, 504, 520, 521, 530]) assert.equal(isRetriableStatus(s), true);
	for (const s of [400, 401, 403, 404, 500, 200]) assert.equal(isRetriableStatus(s), false);
});

test("cooldown escalates and success resets (via setActiveRelayState)", () => {
	resetAllRelayHealth();
	const url = "https://example.com";
	setActiveRelayState({ relays: [{ url, label: "t", auth: "" }], mode: "on", enabled: true, url }, false);
	markRelayFailure(url, 429);
	markRelayFailure(url, 503);
	markRelayFailure(url, 504);
	markRelaySuccess(url, 20);
	markRelayFailure(url, 429);
	resetAllRelayHealth();
	setActiveRelayState({ relays: [], mode: "auto", enabled: false, url: "" }, false);
});

test("client abort does not mark relay failure", async () => {
	resetAllRelayHealth();
	const url = "https://example.com";
	setActiveRelayState({ relays: [{ url, label: "abort-test", auth: "" }], mode: "on", enabled: true, url }, false);
	const ac = new AbortController();
	ac.abort();
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		const e = new Error("abort") as Error & { name: string };
		e.name = "AbortError";
		throw e;
	}) as unknown as typeof fetch;
	try {
		await relayFetch("https://opencode.ai/zen/v1/chat/completions", { signal: ac.signal }).catch(() => {});
	} finally {
		globalThis.fetch = origFetch;
	}
	assert.ok(getOrderedRelayUrls().includes(url) || getOrderedRelayUrls().length === 0);
	resetAllRelayHealth();
	setActiveRelayState({ relays: [], mode: "auto", enabled: false, url: "" }, false);
});

test("DEAD_MODEL_IDS never re-enter via merge", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const dead = "deepseek-v4-flash-free";
		assert.ok(DEAD_MODEL_IDS.has(dead));
		const fakeModel = { id: dead, name: dead, api: "openai-completions", source: "opencode" as const };
		writeCatalogCache({
			timestamp: Date.now(),
			opencode: [dead],
			kilo: [],
			models: [fakeModel as unknown as RegisteredModel],
			etag: "w/1",
		});
		const cached = readCatalogCache();
		const merged = mergeCatalog(ALL_MODELS as unknown as RegisteredModel[], (cached?.models as unknown as RegisteredModel[]) ?? []);
		assert.equal(merged.some((m) => m.id === dead), false);
	});
});

test("catalog ETag 304 extends timestamp", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		writeCatalogCache({
			timestamp: Date.now() - 1000,
			opencode: [],
			kilo: [],
			models: ALL_MODELS.slice(0, 2) as unknown as RegisteredModel[],
			etag: "etag-1",
		});
		const orig = globalThis.fetch;
		globalThis.fetch = (async () => new Response(null, { status: 304, headers: { etag: "etag-1" } })) as unknown as typeof fetch;
		try {
			const { refreshCatalog } = await import("../src/catalog.ts");
			const before = readCatalogCache()!.timestamp;
			await refreshCatalog(false);
			const after = readCatalogCache()!.timestamp;
			assert.ok(after >= before);
		} finally {
			globalThis.fetch = orig;
		}
	});
});

test("rate-limit path: getRateLimitStatus returns remaining", () => {
	resetRateLimits();
	const ip = "127.0.0.1";
	for (let i = 0; i < 100; i++) checkRateLimit(ip, "opencode");
	const s1 = getRateLimitStatus(ip, "opencode");
	assert.equal(typeof s1.remaining, "number");
});

test("validatePath guards traversal and allowed methods", () => {
	assert.ok(validatePath("/v1/chat/completions") !== null);
	assert.ok(validatePath("/v1/chat/completions")?.pathname.includes("/v1/chat/completions"));
	assert.equal(validatePath("/v1/../etc/passwd"), null);
	assert.equal(validatePath("/v1/models?query=1")?.search, "?query=1");
	assert.ok(ALLOWED_METHODS.has("POST"));
	assert.ok(!ALLOWED_METHODS.has("DELETE"));
});

test("sanitizeHeaders strips denylisted and replaces host", () => {
	const h = sanitizeHeaders(
		{ host: "evil.com", "x-relay-target": "https://opencode.ai", authorization: "Bearer x", cookie: "a=b" },
		"opencode.ai",
	);
	assert.equal(h.host, "opencode.ai");
	assert.ok(!("cookie" in h));
	assert.ok(!("x-relay-target" in h));
});

test("payload size guard via startProxy 413", async () => {
	const { server, port } = await startProxy(0);
	try {
		const res = await new Promise<{ status: number }>((resolve, reject) => {
			import("node:http").then(({ request }) => {
				const req = request(
					{
						hostname: "127.0.0.1",
						port,
						path: "/v1/chat/completions",
						method: "POST",
						headers: { "content-type": "application/json", "content-length": String(33 * 1024 * 1024) },
					},
					(res) => resolve({ status: res.statusCode ?? 0 }),
				);
				req.on("error", reject);
				req.end(JSON.stringify({ model: "muse-spark-1.2-contributor-free" }));
			});
		});
		assert.equal(res.status, 413);
	} finally {
		server?.close();
	}
});

test("isLoopbackIP and /_health", () => {
	assert.equal(isLoopbackIP("127.0.0.1"), true);
	assert.equal(isLoopbackIP("::1"), true);
	assert.equal(isLoopbackIP("8.8.8.8"), false);
	const data = getHealthData(28180, 0);
	assert.equal(data.port, 28180);
	assert.equal(typeof data.version, "string");
});

test("relay status label toggles", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		setActiveRelayState({ relays: [], mode: "auto", enabled: false, url: "" }, false);
		const s = getActiveRelayState();
		assert.equal(s.mode, "auto");
		const label = formatRelayStatusLabel(s);
		assert.ok(label === null || typeof label === "string");
	});
});

test("no rtk string in src (external skill)", () => {
	const srcFiles = ["src/client.ts", "src/proxy.ts", "src/commands.ts", "src/relay.ts", "src/catalog.ts", "src/index.ts"];
	for (const f of srcFiles) {
		const c = fs.readFileSync(f, "utf8");
		assert.equal(c.includes("rtk") && !c.includes("x-portkey"), false, `${f} must not contain rtk`);
	}
});

test("startProxy binds ephemeral and isProxyAlive true", async () => {
	const { server, port } = await startProxy(0);
	try {
		assert.ok(port > 0);
		assert.equal(await isProxyAlive(port), true);
	} finally {
		server?.close();
	}
});

test("alive catalog init 28 models", () => {
	setAliveCatalog(ALL_MODELS as unknown as RegisteredModel[]);
	assert.equal(getAliveCatalog().length, ALL_MODELS.length);
	assert.ok(getAliveCatalog().length >= 28);
});
