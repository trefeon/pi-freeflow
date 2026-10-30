import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
	OPENCODE_VERSION_FALLBACK,
	OPENCODE_VERSION_CACHE_ENV,
	OPENCODE_USER_AGENT_ENV,
	buildOpenCodeUserAgent,
	createOpenCodeSessionId,
	getOpenCodeUserAgent,
	probeInstalledOpenCodeVersion,
	resolveOpenCodeProjectLive,
	stableOpenCodeSessionId,
	_resetLiveOpenCodeVersionForTest,
	_resetStableSessionCacheForTest,
} from "../src/config.ts";
import { enforceOpencodeFingerprint } from "../src/opencode-fingerprint.ts";
import { sanitizeHeaders } from "../src/proxy.ts";

const UA_V2 = "PI_FREEFLOW_OPENCODE_UA_V2";
const PROJECT = "PI_FREEFLOW_OPENCODE_PROJECT";
const CWD = "PI_FREEFLOW_OPENCODE_CWD";
const EXTRA = "PI_FREEFLOW_OPENCODE_EXTRA_HEADERS";
const EMPTY_TOOLS = "PI_FREEFLOW_ZEN_EMPTY_TOOLS";
const OPT_KEYS = [UA_V2, PROJECT, CWD, EXTRA, EMPTY_TOOLS, OPENCODE_USER_AGENT_ENV, OPENCODE_VERSION_CACHE_ENV];

function saveEnv(): Record<string, string | undefined> {
	const saved: Record<string, string | undefined> = {};
	for (const k of OPT_KEYS) saved[k] = process.env[k];
	return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const k of OPT_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	_resetLiveOpenCodeVersionForTest();
	_resetStableSessionCacheForTest();
}

function isolateDefault(): void {
	for (const k of OPT_KEYS) delete process.env[k];
	_resetLiveOpenCodeVersionForTest();
	_resetStableSessionCacheForTest();
	probeInstalledOpenCodeVersion({ spawnImpl: () => ({ status: 1 }) });
}

function envBlocksIn(body: Record<string, unknown>): number {
	const text = JSON.stringify(body);
	const matches = text.match(/<env>/g);
	return matches === null ? 0 : matches.length;
}

test("default UA stays 3-token byte-identical", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		const ua = getOpenCodeUserAgent();
		assert.match(ua, /^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/4\.0\.23 runtime\/bun\/1\.4\.4$/);
		assert.doesNotMatch(ua, /\/latest\//);
		assert.equal(buildOpenCodeUserAgent("1.19.4"), `opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`);
		assert.equal(buildOpenCodeUserAgent(OPENCODE_VERSION_FALLBACK), `opencode/${OPENCODE_VERSION_FALLBACK} ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`);
	} finally {
		restoreEnv(saved);
	}
});

test("4-token builder and UA_V2 opt-in emit latest/cli shape", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		assert.equal(
			buildOpenCodeUserAgent("2.2.0", { channel: "latest", client: "cli" }),
			"opencode/latest/2.2.0/cli ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
		);
		process.env[UA_V2] = "1";
		const ua = getOpenCodeUserAgent();
		assert.match(ua, /^opencode\/latest\/\d+\.\d+\.\d+\/cli ai-sdk\/provider-utils\/4\.0\.23 runtime\/bun\/1\.4\.4$/);
		process.env[UA_V2] = " 1 ";
		const padded = getOpenCodeUserAgent();
		assert.match(padded, /^opencode\/latest\/\d+\.\d+\.\d+\/cli ai-sdk\/provider-utils\/4\.0\.23 runtime\/bun\/1\.4\.4$/);
	} finally {
		restoreEnv(saved);
	}
});

test("29-char session passes through, generation stays 30-char", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		_resetStableSessionCacheForTest();
		const short29 = "ses_0123456789abABCDEFGHIJKLM";
		assert.equal(short29.length, 29);
		assert.equal(stableOpenCodeSessionId(short29), short29);
		const full30 = "ses_0123456789abABCDEFGHIJKLMN";
		assert.equal(full30.length, 30);
		assert.equal(stableOpenCodeSessionId(full30), full30);
		const fresh = createOpenCodeSessionId();
		assert.match(fresh, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		assert.equal(fresh.length, 30);
	} finally {
		restoreEnv(saved);
	}
});

test("project defaults global, cwd opts into sha1", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		assert.equal(resolveOpenCodeProjectLive(undefined), "global");
		const legacyCwd = "/some/cwd";
		assert.equal(resolveOpenCodeProjectLive(legacyCwd), createHash("sha1").update(legacyCwd).digest("hex"));
		process.env[PROJECT] = "global";
		assert.equal(resolveOpenCodeProjectLive(legacyCwd), "global");
		process.env[PROJECT] = "cwd";
		const cwd = "/tmp/proj-x-124";
		const want = createHash("sha1").update(cwd).digest("hex");
		assert.equal(resolveOpenCodeProjectLive(cwd), want);
		process.env[CWD] = cwd;
		assert.equal(resolveOpenCodeProjectLive(), want);
		assert.equal(resolveOpenCodeProjectLive(undefined), want);
	} finally {
		restoreEnv(saved);
	}
});

test("sanitizeHeaders default global project, opt-in cwd hash", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		const cwd = "/tmp/proj-x-124";
		const want = createHash("sha1").update(cwd).digest("hex");
		const dflt = sanitizeHeaders({ "content-type": "application/json" }, "opencode.ai", "conv-1");
		assert.equal(dflt["x-opencode-project"], "global");
		// CWD alone is not an opt-in: only PROJECT=cwd may read it.
		process.env[CWD] = cwd;
		const cwdOnly = sanitizeHeaders({ "content-type": "application/json" }, "opencode.ai", "conv-1");
		assert.equal(cwdOnly["x-opencode-project"], "global");
		process.env[PROJECT] = "cwd";
		const opted = sanitizeHeaders({ "content-type": "application/json" }, "opencode.ai", "conv-1");
		assert.equal(opted["x-opencode-project"], want);
	} finally {
		restoreEnv(saved);
	}
});

test("tool-less body: default injects 11, opt-in sends 0, stream+env preserved", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		const chatPath = "/v1/chat/completions";
		const freshBody = (): Record<string, unknown> => ({
			model: "glm-4.6-free",
			messages: [{ role: "user", content: "hi" }],
		});
		const dflt = freshBody();
		const fpDflt = enforceOpencodeFingerprint(dflt, chatPath);
		assert.equal(fpDflt.callerHadTools, false);
		assert.equal(Array.isArray(dflt.tools), true);
		assert.equal((dflt.tools as unknown[]).length, 11);
		assert.equal(dflt.stream, true);
		assert.equal((dflt.stream_options as Record<string, unknown>).include_usage, true);
		assert.equal(envBlocksIn(dflt), 1);
		process.env[EMPTY_TOOLS] = "1";
		const opted = freshBody();
		const fpOpt = enforceOpencodeFingerprint(opted, chatPath);
		assert.equal(fpOpt.callerHadTools, false);
		assert.equal(fpOpt.addedTools, false);
		assert.deepEqual(fpOpt.injected, []);
		const toolCount = Array.isArray(opted.tools) ? (opted.tools as unknown[]).length : 0;
		assert.equal(toolCount, 0);
		assert.equal(opted.stream, true);
		assert.equal((opted.stream_options as Record<string, unknown>).include_usage, true);
		assert.equal(envBlocksIn(opted), 1);
		const text = JSON.stringify(opted);
		assert.match(text, /Working directory:/);
	} finally {
		restoreEnv(saved);
	}
});

test("promptCacheKey normalizes to prompt_cache_key, neither stripped on Zen lane", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		const chatPath = "/v1/chat/completions";
		const dflt: Record<string, unknown> = {
			model: "glm-4.6-free",
			messages: [{ role: "user", content: "hi" }],
			promptCacheKey: "conv-camel-1",
		};
		enforceOpencodeFingerprint(dflt, chatPath);
		assert.equal(dflt.prompt_cache_key, "conv-camel-1");
		assert.equal(dflt.promptCacheKey, "conv-camel-1");
		const emptySnake: Record<string, unknown> = {
			model: "glm-4.6-free",
			messages: [{ role: "user", content: "hi" }],
			promptCacheKey: "conv-camel-empty",
			prompt_cache_key: "",
		};
		enforceOpencodeFingerprint(emptySnake, chatPath);
		assert.equal(emptySnake.prompt_cache_key, "conv-camel-empty");
		process.env[EMPTY_TOOLS] = "1";
		const opted: Record<string, unknown> = {
			model: "glm-4.6-free",
			messages: [{ role: "user", content: "hi" }],
			promptCacheKey: "conv-camel-2",
		};
		enforceOpencodeFingerprint(opted, chatPath);
		assert.equal(opted.prompt_cache_key, "conv-camel-2");
		assert.equal(opted.promptCacheKey, "conv-camel-2");
	} finally {
		restoreEnv(saved);
	}
});

test("sanitizeHeaders extra allowlist and accept default are opt-in only", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		const incoming = {
			"content-type": "application/json",
			b3: "abc123",
			traceparent: "00-tp",
		} as unknown as IncomingHttpHeaders;
		const dflt = sanitizeHeaders(incoming, "opencode.ai", "conv-1");
		assert.equal(dflt["b3"], undefined);
		assert.equal(dflt["traceparent"], undefined);
		assert.equal(dflt["accept"], undefined);
		assert.equal(dflt["accept-encoding"], "identity");
		process.env[EXTRA] = "b3,traceparent,accept";
		const opted = sanitizeHeaders(incoming, "opencode.ai", "conv-1");
		assert.equal(opted["b3"], "abc123");
		assert.equal(opted["traceparent"], "00-tp");
		assert.equal(opted["accept"], "*/*");
		assert.equal(opted["accept-encoding"], "identity");
		const withAccept = sanitizeHeaders(
			{ "content-type": "application/json", accept: "application/json" } as unknown as IncomingHttpHeaders,
			"opencode.ai",
			"conv-1",
		);
		assert.equal(withAccept["accept"], "application/json");
	} finally {
		restoreEnv(saved);
	}
});

test("extra allowlist can never forward credentials, cookies, or framing headers", () => {
	const saved = saveEnv();
	try {
		isolateDefault();
		process.env[EXTRA] = "cookie,proxy-authorization,transfer-encoding,host,authorization,b3";
		const incoming = {
			"content-type": "application/json",
			cookie: "session=secret",
			"proxy-authorization": "Basic abc",
			"transfer-encoding": "chunked",
			host: "evil.example",
			authorization: "Bearer client-token",
			b3: "abc123",
		} as unknown as IncomingHttpHeaders;
		const h = sanitizeHeaders(incoming, "opencode.ai", "conv-1");
		assert.equal(h["cookie"], undefined);
		assert.equal(h["proxy-authorization"], undefined);
		assert.equal(h["transfer-encoding"], undefined);
		assert.equal(h["host"], "opencode.ai", "target host is always owned by the proxy");
		assert.equal(h["authorization"], undefined, "a caller credential must never be copied");
		assert.equal(h["Authorization"], "Bearer public", "upstream auth is always the lane's own");
		assert.equal(h["b3"], "abc123", "non-sensitive extras still pass");
	} finally {
		restoreEnv(saved);
	}
});
