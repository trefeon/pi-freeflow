/**
	* Lock the two shipped latency cuts with loopback-only tests (no upstream network):
	* 1. the direct streaming leg forces anti-buffer headers even when upstream omits them;
	* 2. the relay-leg dispatcher gate tracks the bundled-undici compat rule and both
	*    legs share the one warm agent (connection reuse).
	*/
import test from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "../src/proxy.ts";
import {
	_closeRelayDispatcherForTest,
	canUseRelayDispatcher,
	relayFetch,
} from "../src/relay.ts";
import {
	getActiveRelayState,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
// Disk isolation (relay state, .bak, pin mirror) comes from the shared helper,
// which resolves every path through src/config.ts — setup.mjs re-roots those
// into the per-run sandbox, so isolation holds against unpatched src too.
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const STREAM_MODEL = "muse-spark-1.2-contributor-free";
const SSE_BODY = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

/** Upstream SSE stub with a body but deliberately no anti-buffer headers. */
function sseStub(): Response {
	const encoder = new TextEncoder();
	return {
		status: 200,
		ok: true,
		headers: new Headers({ "content-type": "text/event-stream" }),
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(SSE_BODY));
				controller.close();
			},
		}),
	} as unknown as Response;
}

test("direct streaming forces anti-buffer headers even when upstream omits them", async () => {
	const memBefore = getActiveRelayState();
	await withIsolatedRelayFiles(async () => {
		const { server, port } = await startProxy(0);
		const localPrefix = `http://127.0.0.1:${port}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		try {
			setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
			resetAllRelayHealth();
			const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) return realFetch(u, init);
				assert.ok(u.includes("opencode.ai"), `direct upstream URL: ${u}`);
				return sseStub();
			});
			try {
				const res = await fetch(`${localPrefix}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: STREAM_MODEL, stream: true, messages: [{ role: "user", content: "hi" }] }),
				});
				assert.equal(res.status, 200);
				assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "streaming leg must stay SSE (not buffered JSON)");
				assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
				assert.equal(res.headers.get("x-accel-buffering"), "no");
				const text = await res.text();
				assert.ok(text.includes("hi"), "SSE payload must flow through the pipe");
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, { pin: true, onRestore: () => {
		setActiveRelayState(memBefore, false);
		resetAllRelayHealth();
		return _closeRelayDispatcherForTest();
	} });
});

test("relay dispatcher gate matches the bundled-undici rule and legs share one warm agent", async (t) => {
	const memBefore = getActiveRelayState();
	await withIsolatedRelayFiles(async () => {
		const expected = Number((process.versions.undici ?? "0").split(".")[0]) >= 7;
		assert.equal(canUseRelayDispatcher, expected, "gate must track the bundled undici major (npm undici 7 needs bundled 7+)");

		const state: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay1.example.com",
			relays: [{ url: "https://relay1.example.com" }],
		};
		setActiveRelayState(state, false);
		resetAllRelayHealth();
		const dispatchers: unknown[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
			dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
			return new Response("ok", { status: 200 });
		});
		try {
			const first = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "dispatch-a");
			assert.equal(first.status, 200);
			const second = await relayFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST" }, "dispatch-b");
			assert.equal(second.status, 200);
			assert.equal(fetchMock.mock.callCount(), 2, "one relay-leg fetch per call, no rolls on 200");
			if (canUseRelayDispatcher) {
				assert.ok(dispatchers[0], "relay leg must attach a dispatcher");
				assert.ok(dispatchers[1], "relay leg must attach a dispatcher");
				assert.strictEqual(dispatchers[0], dispatchers[1], "both legs must share the one warm agent (connection reuse)");
			} else {
				assert.equal(dispatchers[0], undefined, "older bundled undici keeps the built-in dispatcher");
				assert.equal(dispatchers[1], undefined, "older bundled undici keeps the built-in dispatcher");
			}
		} finally {
			fetchMock.mock.restore();
		}
	}, { pin: true, onRestore: () => {
		setActiveRelayState(memBefore, false);
		resetAllRelayHealth();
		return _closeRelayDispatcherForTest();
	} });
});
