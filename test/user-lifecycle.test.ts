/**
 * Old-user / upgrade lifecycle suite (deterministic, network-mocked).
 *
 * Exercises the stale-daemon replacement guard that was just implemented:
 *   - older + idle daemon -> replaced with the current version
 *   - older + busy daemon (activeRequests > 0) -> left running
 *   - newer daemon -> left running (downgrade case)
 *   - NO_KILL_ENV=1 -> never replaced, even if older + idle
 *   - matching version -> reused (no kill)
 * and the surrounding lifecycle surfaces: legacy 18080 reuse (skip when the
 * port is busy), catalog-cache TTL reuse / stale refresh / corrupt fallback,
 * update-checker LINK-skip, and activation-time async catalog refresh merging
 * into the registered provider.
 *
 * The test port is forced by test/user-flow-env.ts (imported FIRST, a
 * side-effect module) so no real 28180/18080 daemon is ever reused; the
 * sandbox (test/setup.mjs) re-roots every data file into a temp dir.
 */
import { TEST_PROXY_PORT } from "./user-flow-env.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

import defaultExtension from "../src/index.ts";
import {
	PKG_VERSION,
	CATALOG_CACHE_FILE,
	CATALOG_CACHE_TTL_MS,
	NO_KILL_ENV,
	UPDATE_CACHE_FILE,
	LEGACY_PORT,
	RELAY_STATE_FILE,
	ONBOARDED_FLAG_FILE,
	LOG_FILE,
	DEBUG_STATE_FILE,
} from "../src/config.ts";
import { isProxyAlive, getDaemonVersion, getDaemonHealth } from "../src/proxy.ts";
import {
	setAliveCatalog,
	refreshCatalog,
	writeCatalogCache,
	readCatalogCache,
} from "../src/catalog.ts";
import { checkForUpdateInBackground, getCachedUpdate, isLinkedInstall } from "../src/update-checker.ts";
import { ALL_MODELS } from "../src/models.ts";
import type {
	ExtensionAPI,
	ProviderConfig,
	RegisteredModel,
} from "../src/types.ts";

// ── Repo root ───────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS_ENTRY = path.join(repoRoot, "extensions", "index.ts");

// ── Sandbox isolation ───────────────────────────────────────────────────────

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;
const LOCK_FILE = `${RELAY_STATE_FILE}.lock`;
/** Every sandbox file these tests may write; backed up/restored around a test. */
const TOUCHED = [
	RELAY_STATE_FILE,
	BAK_FILE,
	LOCK_FILE,
	ONBOARDED_FLAG_FILE,
	LOG_FILE,
	UPDATE_CACHE_FILE,
	DEBUG_STATE_FILE,
	CATALOG_CACHE_FILE,
];

function clearSandboxFiles(): void {
	for (const p of TOUCHED) {
		try {
			fs.rmSync(p, { force: true });
		} catch {}
	}
	for (const p of [`${DEBUG_STATE_FILE}.tmp`, `${LOG_FILE}.1`, `${LOG_FILE}.2`, `${LOG_FILE}.3`]) {
		try {
			fs.rmSync(p, { force: true });
		} catch {}
	}
}

async function withIsolatedSandboxFiles(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const before = TOUCHED.map((p) => [p, read(p)] as const);
	try {
		await fn();
	} finally {
		for (const [p, content] of before) {
			try {
				if (content !== null) {
					fs.writeFileSync(p, content, "utf8");
				} else {
					fs.rmSync(p, { force: true });
				}
			} catch {}
		}
	}
}

// ── Deterministic wait helpers (no wall-clock timers) ───────────────────────

/** Resolve after the current microtask queue drains (fired via a setImmediate macrotask). */
function awaitImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(() => resolve());
	return promise;
}

/** Flush the event loop until `predicate` is true, bounded to guard against a hang. */
async function flushUntil(predicate: () => boolean, maxTurns = 200): Promise<void> {
	for (let i = 0; i < maxTurns; i++) {
		if (predicate()) return;
		await awaitImmediate();
	}
	assert.ok(predicate(), "condition was not satisfied after flushing the event loop");
}

function closeServer(server: http.Server): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	return promise;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Reset the in-memory catalog to the static definitions (known baseline). */
function resetCatalog(): RegisteredModel[] {
	return ALL_MODELS.map((m) => ({ ...m, source: "opencode" as const }));
}

/** Minimal RegisteredModel for cache/fetch fixtures. */
function fakeModel(id: string, name = id): RegisteredModel {
	return {
		id,
		name,
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 64_000,
		source: "opencode",
	};
}

type ActivationHandle = {
	config: ProviderConfig | undefined;
	events: Record<string, (...a: unknown[]) => Promise<void> | void>;
	/** Restore the fetch mock and close the proxy the extension may have bound. */
	shutdown: () => Promise<void>;
};

/**
 * Run the full extension activation. Fetches to the forwarded ports hit the
 * real network (so a fake/extension daemon on the test port is observed);
 * every other URL goes to `handleExternal`.
 *
 * `config` is exposed through a live getter: the background refreshCatalog
 * merge re-registers the provider asynchronously, after this function returns.
 */
async function activate(
	forwardPorts: number[],
	handleExternal: (u: string, init?: RequestInit) => Response | Promise<Response>,
): Promise<ActivationHandle> {
	let config: ProviderConfig | undefined;
	const events: Record<string, (...a: unknown[]) => Promise<void> | void> = {};
	const mockPi: ExtensionAPI = {
		registerProvider(_name: string, cfg: ProviderConfig) {
			config = cfg;
		},
		registerCommand() {},
		on(event: string, handler: (...a: unknown[]) => Promise<void> | void) {
			events[event] = handler;
		},
	} as unknown as ExtensionAPI;

	const localPrefixes = forwardPorts.map((p) => `http://127.0.0.1:${p}`);
	const realFetch = globalThis.fetch.bind(globalThis);
	const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
		const u = String(url);
		if (localPrefixes.some((p) => u.startsWith(p))) return realFetch(u, init);
		return handleExternal(u, init);
	});

	await defaultExtension(mockPi);

	const shutdown = async (): Promise<void> => {
		try {
			const h = events.session_shutdown;
			if (h) await h();
		} catch {}
		fetchMock.mock.restore();
	};
	return { get config() { return config; }, events, shutdown };
}

function benignExternal(u: string): Response {
	// Never let the loopback probe ports look daemon-alive: a phantom 18080/28180
	// daemon would be "reused" by the extension and hide the fresh-bind path.
	if (u.includes("127.0.0.1:18080") || u.includes("127.0.0.1:28180")) {
		throw new Error("no daemon (test override)");
	}
	return new Response(JSON.stringify({ version: "1.4.12" }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

// ── Fake daemon (in-process; used for reuse/not-kill cases) ─────────────────

/** Retry the liveness probe (bounded, no wall-clock) so the daemon is reliably reachable. */
async function confirmAlive(port: number): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if (await isProxyAlive(port)) return;
		await awaitImmediate();
	}
	assert.fail(`fake daemon on :${port} never became reachable`);
}

function writeHealthJson(res: http.ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json",
		// Close each connection so closeServer() releases the port immediately
		// (no lingering keep-alive sockets racing the next test's bind).
		connection: "close",
	});
	res.end(JSON.stringify(data));
}

async function startFakeDaemon(
	port: number,
	health: { version: string; activeRequests?: number },
): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const url = req.url ?? "";
		if (url === "/_health" || url === "/health") {
			const data: Record<string, unknown> = { version: health.version };
			if (health.activeRequests !== undefined) data.activeRequests = health.activeRequests;
			writeHealthJson(res, 200, data);
			return;
		}
		if (url.startsWith("/v1/")) {
			writeHealthJson(res, 200, { object: "list", data: [] });
			return;
		}
		writeHealthJson(res, 404, { error: "not found" });
	});
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(port, "127.0.0.1", resolve);
	await promise;
	await confirmAlive(port);
	return server;
}

// ── Fake daemon (child process; used so killPortHolder can kill it) ──────────

const CHILD_DAEMON_SCRIPT = `
const http = require('node:http');
const port = Number(process.env.FAKE_PORT);
const version = process.env.FAKE_VERSION;
const activeRequests = Number(process.env.FAKE_ACTIVE);
const server = http.createServer((req, res) => {
	const url = req.url || '';
	const json = function (status, data) {
		res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
		res.end(JSON.stringify(data));
	};
	if (url === '/_health' || url === '/health') {
		json(200, { version: version, activeRequests: activeRequests });
		return;
	}
	if (url.indexOf('/v1/') === 0) {
		json(200, { object: 'list', data: [] });
		return;
	}
	json(404, { error: 'not found' });
});
server.listen(port, '127.0.0.1', function () {
	process.stdout.write(JSON.stringify({ ready: true, port: port }) + '\\n');
});
function shutdown() { try { server.close(); } catch (e) {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

function spawnFakeDaemon(port: number, version: string, activeRequests: number): ChildProcess {
	return spawn(process.execPath, ["-e", CHILD_DAEMON_SCRIPT], {
		env: {
			...process.env,
			FAKE_PORT: String(port),
			FAKE_VERSION: version,
			FAKE_ACTIVE: String(activeRequests),
		},
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Wait for the child to print its READY line (a real process signal). */
function waitForChildReady(child: ChildProcess): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onData = (chunk: Buffer): void => {
		if (chunk.toString("utf8").includes('"ready":true')) resolve();
	};
	child.stdout?.on("data", onData);
	child.once("error", (err) => reject(err));
	child.once("exit", (code) => reject(new Error(`fake daemon exited before ready (${code})`)));
	return promise;
}

function killChild(child: ChildProcess | null): void {
	if (child && child.exitCode === null) {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}

// ── 1. Stale-daemon guard: older + idle -> replaced ────────────────────────

test("lifecycle [a] older+idle daemon is replaced with the current version", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const fakeVer = "1.8.2";
		const child = spawnFakeDaemon(TEST_PROXY_PORT, fakeVer, 0);
		try {
			await waitForChildReady(child);
			await confirmAlive(TEST_PROXY_PORT);

			const handle = await activate(
				[TEST_PROXY_PORT],
				(u: string) => benignExternal(u),
			);
			try {
				// The guard decided to replace: the extension bound its OWN proxy
				// on the test port, reporting the current version.
				const v = await getDaemonVersion(TEST_PROXY_PORT);
				assert.equal(v, PKG_VERSION, "stale daemon must be replaced by the current version");
				const h = await getDaemonHealth(TEST_PROXY_PORT);
				assert.ok(h, "health must be readable on the replacement proxy");
			} finally {
				await handle.shutdown();
			}
		} finally {
			killChild(child);
		}
	});
});

// ── 2. Stale-daemon guard: older + busy -> NOT killed ─────────────────────

test("lifecycle [b] older+busy daemon is not killed (reused)", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const fakeVer = "1.8.2";
		const server = await startFakeDaemon(TEST_PROXY_PORT, { version: fakeVer, activeRequests: 2 });
		try {
			const handle = await activate(
				[TEST_PROXY_PORT],
				(u: string) => benignExternal(u),
			);
			try {
				// Busy daemon must survive: version still the fake, still listening.
				const v = await getDaemonVersion(TEST_PROXY_PORT);
				assert.equal(v, fakeVer, "busy daemon must be left running with its version");
				const h = await getDaemonHealth(TEST_PROXY_PORT);
				assert.equal(h?.activeRequests, 2, "busy daemon must still report active requests");
				assert.ok(server.listening, "busy daemon must still be listening");
			} finally {
				await handle.shutdown();
			}
		} finally {
			await closeServer(server);
		}
	});
});

// ── 3. Stale-daemon guard: newer daemon -> NOT killed ──────────────────────

test("lifecycle [c] newer daemon is not killed (reused)", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const fakeVer = "2.0.0"; // strictly newer than PKG_VERSION
		const server = await startFakeDaemon(TEST_PROXY_PORT, { version: fakeVer, activeRequests: 0 });
		try {
			const handle = await activate(
				[TEST_PROXY_PORT],
				(u: string) => benignExternal(u),
			);
			try {
				const v = await getDaemonVersion(TEST_PROXY_PORT);
				assert.equal(v, fakeVer, "newer daemon must be left running with its version");
				assert.ok(server.listening, "newer daemon must still be listening");
			} finally {
				await handle.shutdown();
			}
		} finally {
			await closeServer(server);
		}
	});
});

// ── 4. Stale-daemon guard: NO_KILL_ENV=1 -> NOT killed ─────────────────────

test("lifecycle [d] NO_KILL env keeps an older+idle daemon running", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const fakeVer = "1.8.2";
		const server = await startFakeDaemon(TEST_PROXY_PORT, { version: fakeVer, activeRequests: 0 });
		const prev = process.env[NO_KILL_ENV];
		process.env[NO_KILL_ENV] = "1";
		try {
			const handle = await activate(
				[TEST_PROXY_PORT],
				(u: string) => benignExternal(u),
			);
			try {
				const v = await getDaemonVersion(TEST_PROXY_PORT);
				assert.equal(v, fakeVer, "NO_KILL must prevent replacement of an older+idle daemon");
				assert.ok(server.listening, "NO_KILL daemon must still be listening");
			} finally {
				await handle.shutdown();
			}
		} finally {
			if (prev === undefined) delete process.env[NO_KILL_ENV];
			else process.env[NO_KILL_ENV] = prev;
			await closeServer(server);
		}
	});
});

// ── 5. Stale-daemon guard: matching version -> reused ──────────────────────

test("lifecycle [e] matching version daemon is reused", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const server = await startFakeDaemon(TEST_PROXY_PORT, { version: PKG_VERSION, activeRequests: 0 });
		try {
			const handle = await activate(
				[TEST_PROXY_PORT],
				(u: string) => benignExternal(u),
			);
			try {
				const v = await getDaemonVersion(TEST_PROXY_PORT);
				assert.equal(v, PKG_VERSION, "matching version daemon must be reused");
				assert.ok(server.listening, "matching version daemon must still be listening");
				await flushUntil(() => handle.config !== undefined);
				assert.equal(
					handle.config?.baseUrl,
					`http://127.0.0.1:${TEST_PROXY_PORT}/v1`,
					"provider must point at the reused daemon",
				);
			} finally {
				await handle.shutdown();
			}
		} finally {
			await closeServer(server);
		}
	});
});

// ── 6. Legacy 18080 reuse (skip when the port is busy) ─────────────────────

test("lifecycle [f] legacy 18080 daemon is reused when the test port is free", async (t: TestContext) => {
	// Only run if 18080 is verifiably free — a real daemon may be running there.
	const { promise: freeP, resolve: resolveFree } = Promise.withResolvers<boolean>();
	const probe = net.createServer();
	probe.once("error", () => resolveFree(false));
	probe.listen(LEGACY_PORT, "127.0.0.1", () => probe.close(() => resolveFree(true)));
	const free = await freeP;
	if (!free) {
		t.skip(`legacy port ${LEGACY_PORT} is busy`);
		return;
	}

	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const server = await startFakeDaemon(LEGACY_PORT, { version: PKG_VERSION, activeRequests: 0 });
		try {
			const handle = await activate(
				[TEST_PROXY_PORT, LEGACY_PORT],
				(u: string) => benignExternal(u),
			);
			try {
				// The test port has no daemon; the legacy 18080 daemon is reused.
				const v = await getDaemonVersion(LEGACY_PORT);
				assert.equal(v, PKG_VERSION, "legacy daemon must be reused while the test port is free");
				assert.ok(server.listening, "legacy daemon must still be listening");
				await flushUntil(() => handle.config !== undefined);
				assert.equal(
					handle.config?.baseUrl,
					`http://127.0.0.1:${LEGACY_PORT}/v1`,
					"provider must point at the reused legacy daemon",
				);
			} finally {
				await handle.shutdown();
			}
		} finally {
			await closeServer(server);
		}
	});
});

// ── 7. Catalog cache: TTL reuse ────────────────────────────────────────────

test("catalog cache [g1] fresh cache is served without a network refresh", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		setAliveCatalog(resetCatalog());
		writeCatalogCache({
			timestamp: Date.now(),
			opencode: ["m-ttl"],
			kilo: [],
			models: [fakeModel("m-ttl")],
			etag: "etag-ttl",
		});

		const fetchMock = test.mock.method(globalThis, "fetch", async () => {
			throw new Error("fresh cache must short-circuit the network");
		});
		try {
			const result = await refreshCatalog(false);
			assert.ok(result.some((m) => m.id === "m-ttl"), "fresh cache must be served");
			assert.equal(fetchMock.mock.calls.length, 0, "fresh cache must not trigger a fetch");
			assert.ok(readCatalogCache(), "cache file must remain valid");
		} finally {
			fetchMock.mock.restore();
		}
	});
});

// ── 8. Catalog cache: stale refresh merges the fetched model ───────────────

test("catalog cache [g2] stale cache triggers a conditional refresh that merges the new model", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		setAliveCatalog(resetCatalog());
		writeCatalogCache({
			timestamp: Date.now() - CATALOG_CACHE_TTL_MS - 5000,
			opencode: ["m-stale"],
			kilo: [],
			models: [fakeModel("m-stale")],
			etag: "etag-stale",
		});

		const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
			const u = String(url);
			assert.ok(u.includes("/v1/models"), `unexpected fetch: ${u}`);
			const headers = init?.headers as Record<string, string> | Headers | undefined;
			const etag = headers instanceof Headers ? headers.get("if-none-match") : headers?.["If-None-Match"];
			assert.equal(etag, "etag-stale", "conditional fetch must send If-None-Match");
			return new Response(JSON.stringify({ data: [{ id: "m-fresh", name: "Fresh" }] }), {
				status: 200,
				headers: { "content-type": "application/json", etag: "etag-fresh" },
			});
		});
		try {
			const result = await refreshCatalog(false);
			assert.ok(result.some((m) => m.id === "m-fresh"), "stale cache must be refreshed with the fetched model");
			assert.equal(fetchMock.mock.calls.length, 1, "exactly one conditional fetch");
			const cache = readCatalogCache();
			assert.ok(cache?.models?.some((m) => m.id === "m-fresh"), "fresh model must be persisted to the cache");
		} finally {
			fetchMock.mock.restore();
		}
	});
});

// ── 9. Catalog cache: corrupt fallback ─────────────────────────────────────

test("catalog cache [g3] corrupt cache falls back to the static catalog without a refresh", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		setAliveCatalog(resetCatalog());
		fs.writeFileSync(CATALOG_CACHE_FILE, "{ this is not valid json", "utf8");

		const fetchMock = test.mock.method(globalThis, "fetch", async () => {
			throw new Error("corrupt cache must not trigger a fetch");
		});
		try {
			const result = await refreshCatalog(false);
			assert.equal(result.length, ALL_MODELS.length, "corrupt cache must fall back to the static catalog");
			assert.equal(fetchMock.mock.calls.length, 0, "corrupt cache must not trigger a fetch");
			assert.equal(readCatalogCache(), null, "corrupt cache must read as null");
		} finally {
			fetchMock.mock.restore();
		}
	});
});

// ── 10. Update checker: LINK-skip ──────────────────────────────────────────

/**
 * isLinkedInstall() lstat()s the fixed <repo>/extensions/index.ts path. The
 * named `lstatSync` binding is frozen (cannot be mocked at the module level),
 * so the LINK case uses a real junction at that path and restores the original
 * file afterwards; the NOT-linked case is the repo's actual non-symlink file.
 */
async function withLinkedInstall(fn: () => Promise<void>): Promise<void> {
	const orig = fs.readFileSync(EXTENSIONS_ENTRY, "utf8");
	let target: string | null = null;
	try {
		fs.unlinkSync(EXTENSIONS_ENTRY);
		target = fs.mkdtempSync(path.join(os.tmpdir(), "pf-link-target-"));
		fs.symlinkSync(target, EXTENSIONS_ENTRY, "junction");
		await fn();
	} finally {
		try {
			fs.unlinkSync(EXTENSIONS_ENTRY);
		} catch {}
		if (target) {
			try {
				fs.rmSync(target, { recursive: true, force: true });
			} catch {}
		}
		fs.writeFileSync(EXTENSIONS_ENTRY, orig, "utf8");
	}
}

test("update checker [h1] linked install skips the registry fetch", async (t: TestContext) => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		try {
			await withLinkedInstall(async () => {
				assert.equal(isLinkedInstall(), true, "junction must be detected as a linked install");

				const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown) => {
					const u = String(url);
					assert.ok(!u.includes("registry.npmjs.org"), `linked install must not fetch: ${u}`);
					return new Response(JSON.stringify({ version: "9.9.9" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				});
				try {
					checkForUpdateInBackground(null);
					await awaitImmediate();
					assert.equal(fetchMock.mock.calls.length, 0, "linked install must skip the registry fetch");
				} finally {
					fetchMock.mock.restore();
				}
			});
		} catch (e: unknown) {
			const err = e as NodeJS.ErrnoException;
			if (err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "ELOOP") {
				t.skip(`cannot create a linked-install junction on this system (${err.code})`);
				return;
			}
			throw e;
		}
	});
});

test("update checker [h2] unlinked install performs the registry fetch", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		// Ensure the unlinked state (the repo's real non-symlink entry) and no cache.
		assert.equal(isLinkedInstall(), false, "repo entry must be a regular file (unlinked)");

		const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown) => {
			const u = String(url);
			if (u.includes("registry.npmjs.org")) {
				return new Response(JSON.stringify({ version: "9.9.9" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${u}`);
		});
		try {
			checkForUpdateInBackground(null);
			await awaitImmediate();
			assert.equal(
				getCachedUpdate()?.latest,
				"9.9.9",
				"unlinked install must fetch the registry and cache the latest version",
			);
			assert.ok(fetchMock.mock.calls.length >= 1, "unlinked install must perform the registry fetch");
		} finally {
			fetchMock.mock.restore();
		}
	});
});

// ── 11. Activation: async catalog refresh merges into the provider ─────────

test("activation [i1] async catalog refresh merges the fetched model into the registered provider", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		// Pre-seed a STALE cache so the activation's refreshCatalog actually fetches.
		writeCatalogCache({
			timestamp: Date.now() - CATALOG_CACHE_TTL_MS - 5000,
			opencode: ["m-old"],
			kilo: [],
			models: [fakeModel("m-old")],
			etag: "etag-old",
		});

		const handle = await activate([TEST_PROXY_PORT], (u: string) => {
			if (u.startsWith("https://opencode.ai") && u.includes("/models")) {
				return new Response(JSON.stringify({ data: [{ id: "m-extra-x", name: "Extra X" }] }), {
					status: 200,
					headers: { "content-type": "application/json", etag: "etag-new" },
				});
			}
			return benignExternal(u);
		});
		try {
			// Wait for the background refreshCatalog .then to merge and re-register.
			await flushUntil(() => handle.config?.models.some((m) => m.id === "m-extra-x") === true);

			assert.ok(handle.config, "provider must be registered");
			assert.ok(
				handle.config.models.some((m) => m.id === "m-extra-x"),
				"async refresh must merge the fetched model into the registered provider",
			);
			assert.ok(
				handle.config.models.length >= ALL_MODELS.length,
				"merge must preserve the static models",
			);
			assert.match(handle.config.baseUrl, /127\.0\.0\.1/, "baseUrl must point to loopback");
		} finally {
			await handle.shutdown();
		}
	});
});
