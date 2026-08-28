/**
 * Command-level coverage for the P0/P1/P2 /freeflow wiring:
 * test subcommand, status banner, list health badges, logs relay filter,
 * and the deploy picker/confirm flow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCommandSpec } from "../src/commands.ts";
import { LOG_FILE, RELAY_STATE_FILE } from "../src/config.ts";
import {
	markRelayFailure,
	markRelaySuccess,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RelayState,
} from "../src/types.ts";

async function withSavedDiskState(fn: () => Promise<void> | void): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(`${RELAY_STATE_FILE}.bak`);
	try {
		await fn();
	} finally {
		const restore = (p: string, before: string | null): void => {
			if (before !== null) {
				fs.writeFileSync(p, before, "utf8");
			} else {
				try {
					fs.rmSync(p, { force: true });
				} catch {}
			}
		};
		restore(RELAY_STATE_FILE, mainBefore);
		restore(`${RELAY_STATE_FILE}.bak`, bakBefore);
	}
}

function createMockContext(opts: {
	inputValues?: Array<string | undefined>;
	selectValue?: string | null;
	confirmValue?: boolean;
} = {}): {
	ctx: ExtensionContext;
	notifications: Array<{ message: string; type?: string }>;
	statuses: Array<{ key: string; status?: string }>;
} {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; status?: string }> = [];
	const inputValues = opts.inputValues ?? [];
	let inputIdx = 0;

	const ui: ExtensionUIContext = {
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		setStatus(key: string, status: string | undefined) {
			statuses.push({ key, status });
		},
		input(_prompt: string, defaultValue?: string) {
			const v = inputValues[inputIdx++];
			return Promise.resolve(v !== undefined ? v : (defaultValue ?? ""));
		},
		select(_prompt: string, options: string[]) {
			const v = opts.selectValue;
			if (v === undefined) return Promise.resolve(options[0]);
			return Promise.resolve(v === null ? undefined : v);
		},
		confirm(_title: string, _message?: string) {
			return Promise.resolve(opts.confirmValue ?? true);
		},
	};

	return {
		ctx: { ui },
		notifications,
		statuses,
	};
}

const mockApi: ExtensionAPI = {
	registerProvider() {},
	registerCommand() {},
};

function singleRelayState(): RelayState {
	return {
		mode: "auto",
		enabled: true,
		url: "https://relay1.example.com",
		relays: [{ url: "https://relay1.example.com", label: "relay1" }],
	};
}

const VERCEL_OPTION = "Vercel (1M req/mo — recommended)";

// ── /freeflow test ───────────────────────────────────────────────────

test("command spec: /freeflow test reports ok (HTTP 200) for a reachable relay", async (t) => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		setActiveRelayState(singleRelayState(), false);
		t.mock.method(globalThis, "fetch", async () => {
			return {
				status: 200,
				ok: true,
				headers: new Headers(),
				text: async () => "",
				body: null,
			} as unknown as Response;
		});
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("test relay1", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("ok (HTTP 200")),
			`expected ok (HTTP 200) notify, got: ${JSON.stringify(notifications)}`,
		);
	});
});

test("command spec: /freeflow test unknown target notifies not-in-saved-list", async () => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		setActiveRelayState(singleRelayState(), false);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("test nope", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("not in saved list")),
			`expected not-in-saved-list notify, got: ${JSON.stringify(notifications)}`,
		);
	});
});

test("command spec: /freeflow test failure reports failed on fetch error", async (t) => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		setActiveRelayState(singleRelayState(), false);
		t.mock.method(globalThis, "fetch", async () => {
			throw new Error("ECONNREFUSED");
		});
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("test relay1", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("failed")),
			`expected failed notify, got: ${JSON.stringify(notifications)}`,
		);
	});
});

// ── /freeflow status ─────────────────────────────────────────────────

test("command spec: /freeflow status banner shows mode, pool size and state file", async () => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		const state: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [
				{ url: "https://relay1.example.com", label: "relay1" },
				{ url: "https://relay2.example.com", label: "relay2" },
			],
		};
		setActiveRelayState(state, false);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("status", ctx);

		assert.ok(
			notifications.some(
				(n) =>
					n.message.includes("Mode: auto") &&
					n.message.includes("2 relay(s)") &&
					n.message.includes("State file:"),
			),
			`expected status banner, got: ${JSON.stringify(notifications)}`,
		);
	});
});

// ── /freeflow list ───────────────────────────────────────────────────

test("command spec: /freeflow list shows latency badge and ok/fail counters", async () => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		setActiveRelayState(singleRelayState(), false);
		markRelayFailure("https://relay1.example.com", 503, "boom");
		markRelaySuccess("https://relay1.example.com", 250);

		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("list", ctx);

		const msg = notifications.find((n) => n.message.includes("Saved Relays"));
		assert.ok(msg, `expected list header, got: ${JSON.stringify(notifications)}`);
		assert.ok(
			msg.message.includes("[250ms]"),
			`expected [250ms] latency badge, got: ${msg.message}`,
		);
		assert.ok(
			msg.message.includes("ok / "),
			`expected ok/fail counters, got: ${msg.message}`,
		);
	});
});

// ── /freeflow logs relay <text> ──────────────────────────────────────

test("command spec: /freeflow logs relay <text> sets filterText, not a level", async () => {
	const hadLog = fs.existsSync(LOG_FILE);
	const backup = hadLog ? fs.readFileSync(LOG_FILE, "utf8") : null;
	try {
		fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
		fs.writeFileSync(
			LOG_FILE,
			"[INFO] relay1 round trip ok\n[INFO] unrelated line\n",
		);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext();

		await spec.handler("logs relay relay1", ctx); // must not throw

		const header = notifications.find((n) => n.message.includes("text=relay1"));
		assert.ok(
			header,
			`expected relay text filter in logs notify, got: ${JSON.stringify(notifications)}`,
		);
		// The 'relay' flag must be consumed as a filter marker, never parsed
		// as a log level (which would surface as level=relay).
		assert.ok(
			!header.message.includes("level=relay"),
			`relay flag leaked into level filter: ${header.message}`,
		);
	} finally {
		if (hadLog && backup !== null) {
			fs.writeFileSync(LOG_FILE, backup);
		} else if (!hadLog) {
			try { fs.unlinkSync(LOG_FILE); } catch {}
		}
	}
});

// ── /freeflow deploy picker + confirm ────────────────────────────────

type StubResponse = { status?: number; body?: unknown; reject?: string };

function scriptedFetch(
	responder: (url: string, init: RequestInit | undefined, call: number) => StubResponse,
): typeof fetch {
	let call = 0;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const r = responder(url, init, call++);
		if (r.reject) throw new Error(r.reject);
		const status = r.status ?? 200;
		const payload = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
		return new Response(payload, {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

test("command spec: /freeflow deploy vercel picker + confirm deploys and probes reachable", async (t) => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
		t.mock.method(
			globalThis,
			"fetch",
			scriptedFetch((url, init) => {
				if (url.endsWith("/v1/models")) {
					return { status: 200, body: {} }; // post-deploy probe
				}
				if (url.includes("/v13/deployments/")) {
					return { body: { readyState: "READY", url: "relay-my-relay.vercel.app" } };
				}
				if (url.includes("/v13/deployments") && init?.method === "POST") {
					return { body: { id: "dep1", projectId: "proj1" } };
				}
				if (url.includes("/v9/projects/")) {
					return { body: {} };
				}
				return { status: 500, body: { error: { message: `unexpected ${init?.method} ${url}` } } };
			}),
		);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext({
			selectValue: VERCEL_OPTION,
			inputValues: ["fake-token", "my-relay"],
			confirmValue: true,
		});

		await spec.handler("deploy", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("Deployed & active")),
			`expected Deployed & active notify, got: ${JSON.stringify(notifications)}`,
		);
		assert.ok(
			notifications.some((n) => n.message.includes("reachable")),
			`expected reachable probe note, got: ${JSON.stringify(notifications)}`,
		);
	});
});

test("command spec: /freeflow deploy picker cancelled does not deploy", async () => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext({
			selectValue: null, // picker cancelled
		});

		await spec.handler("deploy", ctx);

		assert.equal(
			notifications.some((n) => n.message.includes("Deploy")),
			false,
			`no Deploy notify expected after cancelled picker, got: ${JSON.stringify(notifications)}`,
		);
	});
});

test("command spec: /freeflow deploy confirm declined notifies Deploy cancelled", async () => {
	await withSavedDiskState(async () => {
		resetAllRelayHealth();
		setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
		const spec = createCommandSpec(mockApi);
		const { ctx, notifications } = createMockContext({
			selectValue: VERCEL_OPTION,
			inputValues: ["fake-token", "my-relay"],
			confirmValue: false,
		});

		await spec.handler("deploy", ctx);

		assert.ok(
			notifications.some((n) => n.message.includes("Deploy cancelled")),
			`expected Deploy cancelled notify, got: ${JSON.stringify(notifications)}`,
		);
	});
});