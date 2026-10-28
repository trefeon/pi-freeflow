/**
 * OpenCode lane auto-repair regression: drifted inputs are repaired to the
 * live wire, valid inputs pass through byte-identical.
 *
 * Covers the request-time repair axes the lane guarantees:
 * stale UA stamp -> full shape, missing/stale msg/ses/project repaired,
 * affinity + stale x-opencode-* stripped, missing tools injected
 * (missing-only, verbatim 11), env block folded to a single pair,
 * stream/include_usage/tool_choice normalized, and shape 429s surfaced
 * terminally with no relay roll or health mark.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeHeaders } from "../src/proxy.ts";
import { zenUpstreamPathFor } from "../src/config.ts";
import {
	applyOpenAiCompatVariant,
	enforceOpencodeFingerprint,
	ensureEnvBlock,
} from "../src/opencode-fingerprint.ts";
import { FULL11_TOOL_NAMES } from "../src/tool-translation.ts";
import { relayFetch, _resetRollNotifyForTest } from "../src/relay.ts";
import { getRelayHealth, resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const FULL_UA_RE = /^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/4\.0\.23 runtime\/bun\/1\.4\.4$/;
const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const MSG_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const LIVE_KEYS = [
	"x-opencode-client",
	"x-opencode-project",
	"x-opencode-session",
	"x-opencode-session-id",
	"x-opencode-request",
];

test("lane repair: stale UA, stale x-opencode-*, affinity, and caller auth are all repaired", () => {
	const fwd = sanitizeHeaders(
		{
			"user-agent": "opencode/1.0.0",
			"x-opencode-client": "bogus",
			"x-opencode-version": "9.9.9-stale",
			"x-opencode-channel": "stale",
			"x-opencode-session": "ses_stale",
			"x-opencode-request": "msg_stale",
			"x-opencode-foo": "bar",
			"x-session-affinity": "aaa",
			"x-session-id": "bbb",
			authorization: "Bearer sk-evil",
			"content-type": "application/json",
		},
		"opencode.ai",
		"convo-1",
	);
	const ua = fwd["User-Agent"] ?? fwd["user-agent"] ?? "";
	assert.match(ua, FULL_UA_RE, "stale UA stamp must become the full live shape");
	assert.equal(Object.keys(fwd).filter((k) => k.toLowerCase() === "user-agent").length, 1, "exactly one UA");
	assert.equal(fwd["Authorization"], "Bearer public", "caller credential never rides");
	for (const key of LIVE_KEYS) assert.ok(typeof fwd[key] === "string" && fwd[key].length > 0, `${key} present`);
	assert.equal(fwd["x-opencode-client"], "cli");
	assert.equal(fwd["x-opencode-foo"], undefined, "unknown x-opencode-* never rides");
	assert.equal(fwd["x-opencode-version"], undefined, "stale version pin never rides");
	assert.equal(fwd["x-opencode-channel"], undefined, "stale channel pin never rides");
	assert.equal(fwd["x-session-affinity"], undefined, "affinity never rides the opencode lane");
	assert.equal(fwd["x-session-id"], undefined, "affinity id never rides the opencode lane");
	assert.match(fwd["x-opencode-session"] ?? "", SES_RE);
	assert.match(fwd["x-opencode-request"] ?? "", MSG_RE);
	assert.equal(fwd["content-type"], "application/json", "allowlisted headers survive");
});

test("lane repair: session is stable per conversation, request is fresh per call", () => {
	const first = sanitizeHeaders({ "content-type": "application/json" }, "opencode.ai", "convo-A");
	const second = sanitizeHeaders({ "content-type": "application/json" }, "opencode.ai", "convo-A");
	const other = sanitizeHeaders({ "content-type": "application/json" }, "opencode.ai", "convo-B");
	assert.equal(first["x-opencode-session"], second["x-opencode-session"], "same conversation keeps its session");
	assert.notEqual(first["x-opencode-request"], second["x-opencode-request"], "every call mints a fresh request id");
	assert.notEqual(first["x-opencode-session"], other["x-opencode-session"], "conversations never share a session");
});

test("lane repair: drifted chat body is repaired to the live wire", () => {
	const body: Record<string, unknown> = {
		model: "opencode/glm-4.5",
		stream: false,
		tool_choice: "none",
		temperature: 0.7,
		tools: [{ type: "function", function: { name: "Bash", description: "mine", parameters: { type: "object" } } }],
		messages: [{ role: "user", content: "hi" }],
	};
	const fp = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	assert.equal(body.model, "glm-4.5", "opencode/ prefix stripped");
	assert.equal(body.stream, true, "stream forced true");
	assert.equal(body.tool_choice, undefined, "non-auto choice dropped, never translated");
	assert.equal(body.temperature, undefined, "sampling knobs stripped on tool turns");
	assert.deepEqual(body.stream_options, { include_usage: true }, "compat usage accounting");
	const tools = body.tools as Array<{ type: string; function: { name: string; description: string } }>;
	assert.equal(tools.length, 1 + FULL11_TOOL_NAMES.length - 1, "caller tool kept, only missing slots injected");
	assert.equal(tools[0].function.name, "bash", "caller casing normalized for the wire");
	assert.equal(tools[0].function.description, "mine", "caller schema preserved verbatim");
	const names = tools.map((t) => t.function.name);
	for (const name of FULL11_TOOL_NAMES) assert.ok(names.includes(name), `roster carries ${name}`);
	const system = (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === "system");
	assert.ok(system, "system prompt gained for the env block");
	assert.equal(system.content.match(/<env>[\s\S]*?<\/env>/g)?.length, 1, "exactly one env pair");
	assert.match(system.content, /Working directory:/);
	assert.equal(fp.callerHadTools, true);
	assert.equal(fp.addedTools, true);
});

test("lane repair: valid chat body passes through byte-identical", () => {
	const drifted: Record<string, unknown> = {
		model: "glm-4.5",
		stream: false,
		messages: [{ role: "user", content: "hi" }],
	};
	enforceOpencodeFingerprint(drifted, "/v1/chat/completions");
	const snapshot = JSON.stringify(drifted);
	const fp = enforceOpencodeFingerprint(drifted, "/v1/chat/completions");
	assert.equal(JSON.stringify(drifted), snapshot, "a repaired body is a fixed point");
	assert.equal(fp.addedTools, false, "second pass injects nothing");
});

test("lane repair: env block folds to the single good pair, keeping it verbatim", () => {
	const good = "<env>\n  Working directory: /repo\n  Workspace root: /repo\n  Is git: true\n  Platform: linux\n  Today's date: 2026-10-28\n</env>";
	const body: Record<string, unknown> = {
		messages: [
			{ role: "system", content: "stale notes\n<env>\n  Platform: linux\n</env>\nmore\n</env>" },
			{ role: "system", content: `context\n\n${good}` },
		],
	};
	ensureEnvBlock(body, "/v1/chat/completions");
	const texts = (body.messages as Array<{ content: string }>).map((m) => m.content).join("\n");
	assert.equal(texts.match(/<env>[\s\S]*?<\/env>/g)?.length, 1, "exactly one pair survives");
	assert.ok(texts.includes(good), "the good pair rides through verbatim");
	assert.ok(!texts.includes("stale notes") || !texts.includes("Platform: linux\n</env>"), "the keyless block is gone");
});

test("lane repair: compat variant merges without clobbering sibling keys", () => {
	const body: Record<string, unknown> = { stream_options: { include_usage: false, extra: 1 } };
	applyOpenAiCompatVariant(body);
	assert.deepEqual(body.stream_options, { include_usage: true, extra: 1 });
	applyOpenAiCompatVariant(body);
	assert.deepEqual(body.stream_options, { include_usage: true, extra: 1 }, "idempotent");
});

test("lane repair: compat path is the default and a fixed point", () => {
	assert.equal(zenUpstreamPathFor("/v1/chat/completions"), "/inference/openai/v1/chat/completions");
	assert.equal(
		zenUpstreamPathFor("/inference/openai/v1/chat/completions"),
		"/inference/openai/v1/chat/completions",
		"already-compat passes through unchanged",
	);
	assert.equal(zenUpstreamPathFor("/v1/responses"), "/inference/v1/responses", "non-chat lanes keep the plain mapping");
});

const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
const RELAY_A = "https://relay-a.example.com";
const RELAY_B = "https://relay-b.example.com";

function poolState(urls: string[]): RelayState {
	return {
		enabled: true,
		url: urls[0] ?? "",
		relays: urls.map((url) => ({ url })),
		mode: "auto",
	} as unknown as RelayState;
}

/** Response stub with the cancelling/cloneable body the roll branches expect. */
function stubResponse(status: number, body = "{}"): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers({ "content-type": "application/json" }),
		body: { cancel: async () => {} },
		clone() {
			return { text: async () => body };
		},
		text: async () => body,
	} as unknown as Response;
}

test("lane repair: shape 429 surfaces terminally with no roll and no health mark", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A, RELAY_B]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();
		const shape = JSON.stringify({
			error: { code: "FreeUsageLimitError", message: "usage limited, retry after 3600s" },
		});
		const calls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			calls.push(String(input));
			return stubResponse(429, shape);
		});
		try {
			const failures: unknown[] = [];
			const res = await relayFetch(UPSTREAM, { method: "POST", body: "{}" }, "shape-429", {}, (info) => {
				failures.push(info);
			});
			assert.equal(res.status, 429);
			assert.equal(calls.length, 1, "a fingerprint fault must not burn the sibling relay");
			assert.deepEqual(failures, [], "no roll is attempted, so no attempt failure is reported");
			assert.equal(await res.text(), shape, "the verdict body survives byte-identical");
			const health = getRelayHealth(RELAY_A);
			assert.ok(!health || (health.consecutiveFailures ?? 0) === 0, "no quota accounting lands on the relay");
		} finally {
			fetchMock.mock.restore();
		}
	});
});

test("lane repair: quota 429 still rolls to the sibling", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A, RELAY_B]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();
		const quota = JSON.stringify({
			error: { code: "FreeUsageLimitError", message: "Free usage quota exceeded for today; resets at 00:00 UTC" },
		});
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			if (String(input) === RELAY_A) return stubResponse(429, quota);
			return stubResponse(200, '{"id":"served"}');
		});
		try {
			const res = await relayFetch(UPSTREAM, { method: "POST", body: "{}" }, "quota-429", {}, () => {});
			assert.equal(res.status, 200, "genuine quota pressure still fails over to the sibling egress");
			assert.equal(fetchMock.mock.callCount(), 2);
		} finally {
			fetchMock.mock.restore();
		}
	});
});
