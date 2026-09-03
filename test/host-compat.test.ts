/**
 * Host-compatibility + install/distribution contract tests for pi-freeflow.
 *
 * Verifies the extension degrades gracefully on a MINIMAL Pi host — no
 * `pi.on`, a `ui` exposing only `notify` (no setStatus/select/input, no
 * widget-click handlers) — while still fully working on a full OMP host, and
 * that the published package shape (manifest fields, wrapper entry, symlink
 * detection) is intact.
 *
 * Purely hermetic: global fetch is mocked, and test/setup.mjs re-roots every
 * data file under a fresh tmp dir, so no real network, no real 28180/18080
 * binding, and no ~/.pi/agent writes. user-flow-env.ts (imported first) points
 * the extension at a dedicated TEST_PROXY_PORT so activation never probes a
 * live daemon.
 */
// MUST be literal first import: sets the proxy-port env (TEST_PROXY_PORT) so
// src/config.ts resolves PORT to a dedicated test port, avoiding 28180/18080.
import "./user-flow-env.ts";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import defaultExtension, {
	bindWidgetClick,
	buildProviderConfig,
} from "../src/index.ts";
import { createCommandSpec, updateStatusBar } from "../src/commands.ts";
import { isLinkedInstall } from "../src/update-checker.ts";
import wrapperDefault from "../extensions/index.ts";
import {
	HOST,
	PKG_VERSION,
	PORT,
	UPDATE_CACHE_FILE,
	ONBOARDED_FLAG_FILE,
} from "../src/config.ts";
import { ALL_MODELS, KILO_MODEL_IDS } from "../src/models.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ProviderConfig,
	RegisteredCommand,
	RegisteredModel,
} from "../src/types.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Shared helpers ────────────────────────────────────────────────────────────

type RegistryMode = "reject" | { version: string };

/**
 * URL-aware fetch mock. The activation "reuses" an already-running daemon
 * (instead of binding a real server) by answering the /v1/models probe as
 * alive and /_health with the current PKG_VERSION; the registry is the only
 * other endpoint consulted and can be made to reject (offline) or answer.
 */
function makeFetchHandler(registry: RegistryMode = "reject") {
	return async (input: RequestInfo | URL): Promise<unknown> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: ((input as Request)?.url ?? "");
		if (url.startsWith(`http://${HOST}:${PORT}/v1/models`)) {
			return { ok: true, headers: { get: () => "application/json" }, json: async () => [] };
		}
		if (url.startsWith(`http://${HOST}:${PORT}/_health`)) {
			return {
				ok: true,
				headers: { get: () => "application/json" },
				json: async () => ({ version: PKG_VERSION, activeRequests: 0 }),
			};
		}
		if (url.includes("registry.npmjs.org")) {
			if (registry === "reject") throw new Error("mocked offline");
			const v = registry.version;
			if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error("mocked offline");
			return {
				ok: true,
				status: 200,
				headers: { get: () => "application/json" },
				json: async () => ({ version: v }),
			};
		}
		throw new Error("mocked offline");
	};
}

async function flushAsync(): Promise<void> {
	// Deterministic microtask drain — every async continuation (catalog refresh,
	// fire-and-forget update check) settles within a handful of microtask hops,
	// so no real wall-clock timer is needed and nothing is left pending.
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

interface Capture {
	providerName: string | null;
	providerConfig: ProviderConfig | null;
	commands: Map<string, Omit<RegisteredCommand, "name">>;
	events: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>;
}

function makeCapture(): { captured: Capture; pi: ExtensionAPI } {
	const captured: Capture = {
		providerName: null,
		providerConfig: null,
		commands: new Map(),
		events: new Map(),
	};
	const pi: ExtensionAPI = {
		registerProvider(name: string, config: ProviderConfig) {
			captured.providerName = name;
			captured.providerConfig = config;
		},
		registerCommand(name: string, spec: Omit<RegisteredCommand, "name">) {
			captured.commands.set(name, spec);
		},
	};
	return { captured, pi };
}

// ── A. Minimal Pi host: no pi.on, notify-only ui ──────────────────────────────

test("A: activation completes on a MINIMAL Pi host (no pi.on, ui notify-only) and registers provider + command with no listeners", async (t) => {
	t.mock.method(globalThis, "fetch", makeFetchHandler("reject"));
	const { captured, pi } = makeCapture(); // NOTE: no `on` member at all

	await defaultExtension(pi);
	await flushAsync();

	assert.equal(captured.providerName, "freeflow");
	assert.ok(captured.providerConfig, "provider config must be registered");
	assert.ok(
		captured.providerConfig!.models.length >= 26,
		"static catalog must expose at least 26 models",
	);
	assert.ok(captured.commands.has("freeflow"), "/freeflow command must be registered");
	assert.equal(
		captured.events.size,
		0,
		"no lifecycle listeners may be attached when the host exposes no pi.on",
	);
});

// ── B. Full pi.on, notify-only ui (no setStatus/select/input) ─────────────────

test("B: session_start with a notify-only ui degrades gracefully (status-hide path never calls setStatus)", async (t) => {
	t.mock.method(globalThis, "fetch", makeFetchHandler("reject"));
	fs.rmSync(ONBOARDED_FLAG_FILE, { force: true });

	const { captured, pi } = makeCapture();
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	pi.on = (event, handler) => {
		captured.events.set(event, handler);
		if (event === "session_start") sessionStart = handler;
	};

	await defaultExtension(pi);
	await flushAsync();

	assert.ok(sessionStart, "session_start handler must be attached when pi.on is present");

	const notifications: Array<{ msg: string; type?: string }> = [];
	// A MINIMAL host may expose only notify — the extension must tolerate that
	// via optional-chaining at runtime, so the literal is widened past the
	// full ExtensionUIContext shape.
	const ui = {
		notify(msg: string, type?: "info" | "warning" | "error") {
			notifications.push({ msg, type });
		},
	} as unknown as ExtensionUIContext; // no setStatus, no select, no input, no widget-click handlers
	const ctx: ExtensionContext = {
		ui,
		model: { provider: "other", id: "other-model" },
	};

	await assert.doesNotReject(async () => {
		await sessionStart!(null, ctx);
	});

	// onboarding fires through notify (guarded); the non-freeflow hide path is
	// reached and must not call setStatus on the ui that lacks it.
	assert.ok(notifications.length > 0, "notify-only ui must still receive onboarding message");
	assert.equal(notifications.filter((n) => n.msg.includes("freeflow ready")).length, 1);
});

// ── C. setStatus-absent guard ─────────────────────────────────────────────────

test("C: status-bar update and the status command tolerate a ui without setStatus", async (t) => {
	t.mock.method(globalThis, "fetch", makeFetchHandler("reject"));

	// updateStatusBar guards an absent ui entirely.
	assert.doesNotThrow(() => updateStatusBar(undefined));

	// The /freeflow status command surface uses notify (never setStatus), so a
	// host exposing only notify works without throwing.
	const mockPi: ExtensionAPI = {
		registerProvider: () => {},
		registerCommand: () => {},
		on: () => {},
	};
	const cmd = createCommandSpec(mockPi, () => {});
	const notifications: Array<{ msg: string; type?: string }> = [];
	const ui = {
		notify(msg: string, type?: "info" | "warning" | "error") {
			notifications.push({ msg, type });
		},
	} as unknown as ExtensionUIContext; // no setStatus

	await assert.doesNotReject(async () => {
		await cmd.handler("status", { ui });
	});
	assert.ok(notifications.length > 0, "status command must report via notify");
});

// ── D. widget-click feature-detect miss ───────────────────────────────────────

test("D: bindWidgetClick on a ui with no widget-click handlers is a no-op", () => {
	const ui = {
		notify: () => {},
		// no onStatusClick / onStatusBarClick / onWidgetClick
		onStatusClick: undefined as unknown,
		onStatusBarClick: undefined as unknown,
		onWidgetClick: undefined as unknown,
	};
	assert.doesNotThrow(() => bindWidgetClick(ui as unknown as ExtensionUIContext));

	// A host that DOES expose one gets a handler registered (feature-detect hit).
	const seen: Array<(h: () => void | Promise<void>) => unknown> = [];
	const hitUi = {
		notify: () => {},
		onStatusClick(h: () => void | Promise<void>) {
			seen.push(h);
		},
	};
	assert.doesNotThrow(() => bindWidgetClick(hitUi as unknown as ExtensionUIContext));
	assert.equal(seen.length, 1, "present onStatusClick must be wired as the widget-click handler");
});

// ── E. notify-vs-print host surface ───────────────────────────────────────────

test("E: session_start on a print-only ui (no notify/setStatus) does not throw and never calls notify", async (t) => {
	t.mock.method(globalThis, "fetch", makeFetchHandler("reject"));
	fs.rmSync(ONBOARDED_FLAG_FILE, { force: true });

	const { captured, pi } = makeCapture();
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	pi.on = (event, handler) => {
		captured.events.set(event, handler);
		if (event === "session_start") sessionStart = handler;
	};

	await defaultExtension(pi);
	await flushAsync();
	assert.ok(sessionStart);

	const ui = {
		// host surface a Pi host may expose instead of `notify`
		print: (_msg: string) => {},
	} as unknown as ExtensionUIContext;
	const ctx: ExtensionContext = {
		ui,
		model: { provider: "other", id: "other-model" },
	};

	await assert.doesNotReject(async () => {
		await sessionStart!(null, ctx);
	});
});

// ── F. registerProvider contract shape (buildProviderConfig) ──────────────────

test("F: buildProviderConfig emits the host-compatible provider contract", () => {
	const port = 29751;
	const cfg = buildProviderConfig(
		ALL_MODELS.map((m) => ({
			...m,
			source: KILO_MODEL_IDS.has(m.id) ? "kilo" : "opencode",
		})),
		port,
	);

	// top-level contract
	assert.ok(
		cfg.baseUrl.startsWith("http://127.0.0.1"),
		"baseUrl must be loopback",
	);
	assert.ok(cfg.baseUrl.includes(`:${port}/v1`), `baseUrl must point at the test port ${port}`);
	assert.equal(cfg.apiKey, "public");
	assert.equal(cfg.api, "openai-completions");
	assert.equal(cfg.compat?.supportsDeveloperRole, false);
	assert.ok(cfg.models.length >= 26, "at least 26 static models registered");

	// every model carries the minimal {id, name} shape the host picker needs
	for (const m of cfg.models) {
		assert.ok(typeof m.id === "string" && m.id.length > 0, "model id must be present");
		assert.ok(typeof m.name === "string" && m.name.length > 0, "model name must be present");
		assert.equal(m.cost?.input, 0);
		assert.equal(m.cost?.output, 0);
		assert.equal(m.cost?.cacheRead, 0);
		assert.equal(m.cost?.cacheWrite, 0);
	}

	// known model: OpenCode Zen responses model with a thinkingLevelMap
	const muse = cfg.models.find((m) => m.id === "muse-spark-1.2-contributor-free");
	assert.ok(muse, "muse model must be present");
	assert.equal(muse!.reasoning, true);
	assert.equal(muse!.api, "openai-responses");
	assert.equal(muse!.thinking?.mode, "effort");
	assert.ok(
		Array.isArray(muse!.thinking?.efforts) && muse!.thinking!.efforts!.length > 0,
		"efforts must be derived from the non-null thinkingLevelMap",
	);
	assert.equal(muse!.compat?.sessionAffinityFormat, "openai-nosession");
	assert.equal(muse!.compat?.supportsDeveloperRole, undefined);

	// known model: Kilo model with thinkingFormat
	const kilo = cfg.models.find((m) => m.id === "dots-studio/dots-3-note-preview:free");
	assert.ok(kilo, "kilo model must be present");
	assert.equal(kilo!.compat?.thinkingFormat, "openrouter");
	assert.equal(kilo!.compat?.supportsDeveloperRole, false);
});

// ── G. Package manifest contract ──────────────────────────────────────────────

test("G: package.json satisfies the install/distribution contract", () => {
	const pkgPath = path.join(repoRoot, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;

	assert.equal(pkg.main, "extensions/index.ts", "main must be the extension wrapper entry");

	const omp = pkg.omp as { extensions?: string[] };
	const pi = pkg.pi as { extensions?: string[] };
	assert.ok(Array.isArray(omp.extensions) && omp.extensions.includes("./extensions"));
	assert.ok(Array.isArray(pi.extensions) && pi.extensions.includes("./extensions"));

	const files = pkg.files as string[];
	for (const f of ["extensions", "src", "README.md", "CHANGELOG.md", "LICENSE"]) {
		assert.ok(files.includes(f), `files must include ${f}`);
	}

	const engines = pkg.engines as { node?: string };
	assert.ok(typeof engines?.node === "string", "engines.node must be declared");
	const nodeMajor = Number(engines.node.match(/\d+/)?.[0]);
	assert.ok(nodeMajor >= 22, `engines.node major ${nodeMajor} must be >= 22`);

	assert.equal("bin" in pkg, false, "package must not expose a bin entry");
});

// ── H. Wrapper fire-and-forget ────────────────────────────────────────────────

test("H: extensions/index.ts wrapper never blocks activation and only writes the update cache when the registry answers", async (t) => {
	// H1 — registry rejects (offline): activation completes but the cache is not written.
	t.mock.method(globalThis, "fetch", makeFetchHandler("reject"));
	fs.rmSync(UPDATE_CACHE_FILE, { force: true });
	const h1 = makeCapture();
	await wrapperDefault(h1.pi);
	await flushAsync();

	assert.equal(h1.captured.providerName, "freeflow", "activation must complete even offline");
	assert.ok(h1.captured.commands.has("freeflow"));
	assert.equal(
		fs.existsSync(UPDATE_CACHE_FILE),
		false,
		"offline registry must not write the update cache",
	);

	t.mock.restoreAll();

	// H2 — registry answers: activation completes and the cache is written.
	t.mock.method(globalThis, "fetch", makeFetchHandler({ version: "2.0.0" }));
	fs.rmSync(UPDATE_CACHE_FILE, { force: true });
	const h2 = makeCapture();
	await wrapperDefault(h2.pi);
	await flushAsync();

	// background update check is fire-and-forget; the microtask drain in
	// flushAsync settles its fetch/.then chain before we inspect the cache.
	const cached = fs.existsSync(UPDATE_CACHE_FILE)
		? (JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, "utf8")) as { latest?: string })
		: null;
	assert.equal(h2.captured.providerName, "freeflow", "activation must still complete with registry up");
	assert.equal(cached?.latest, "2.0.0", "valid registry response must write the update cache");
});

// ── I. isLinkedInstall symlink vs regular file ────────────────────────────────

test("I: isLinkedInstall distinguishes a symlinked entry from a regular file", async () => {
	// node:fs named exports cannot be monkey-patched in this runtime, so the
	// two branches are exercised against the real filesystem: a regular file
	// (unlinked) and a temporary symlink swapped in for the repo entry, then
	// restored in `finally` so the working tree is left untouched.

	const entry = path.join(repoRoot, "extensions", "index.ts");
	assert.equal(isLinkedInstall(), false, "a regular file must not be treated as a linked install");

	// Linked install: swap the entry for a symlink, run, then restore.
	const backup = fs.readFileSync(entry, "utf8");
	const linkTarget = path.join(repoRoot, "extensions", ".host-compat-link-target");
	fs.writeFileSync(linkTarget, backup);
	try {
		fs.rmSync(entry, { force: true });
		fs.symlinkSync(linkTarget, entry, "file");
		assert.equal(isLinkedInstall(), true, "a symlinked entry must be detected as a linked install");
	} finally {
		fs.rmSync(entry, { force: true });
		fs.writeFileSync(entry, backup);
		fs.rmSync(linkTarget, { force: true });
	}
});
