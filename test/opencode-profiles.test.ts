import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	OPENCODE_PROJECT,
	OPENCODE_SESSION,
	OPENCODE_V2_VERSION_FALLBACK,
	opencodeHeaders,
	_resetLiveOpenCodeVersionForTest,
} from "../src/config.ts";
import {
	applyOpenAiCompatVariant,
	enforceOpencodeFingerprint,
	ensureFingerprintToolsFor,
	opencodeHeadersFor,
	V1_PROFILE,
	V2_PROFILE,
	withProjectHeader,
} from "../src/opencode-fingerprint.ts";

const READ_V2_PARAM = '{"type":"object","properties":{"path":{"type":"string","description":"File or directory to read"},"offset":{"type":"integer","minimum":0,"description":"The line or directory entry to start reading from (1-based)"},"limit":{"type":"integer","minimum":0,"description":"The maximum number of lines or directory entries to read (defaults to and capped at 2000)"}},"required":["path"],"additionalProperties":false}';
const SHELL_V2_PARAM = '{"type":"object","properties":{"command":{"type":"string","description":"Shell command string to execute"},"workdir":{"type":"string","description":"Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},"timeout":{"type":"integer","minimum":0,"description":"Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."},"background":{"type":"boolean","description":"Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using the shell tool. You will be notified when it completes. DO NOT poll for completion."}},"required":["command"],"additionalProperties":false}';

function namesOf(body: Record<string, unknown>): string[] {
	const tools = body.tools as Array<{ function?: { name?: unknown } }>;
	return tools.map((t) => String(t.function?.name));
}

describe("opencode profiles", () => {
	it("V1_PROFILE headers are byte-identical to opencodeHeaders()", () => {
		assert.deepEqual(opencodeHeadersFor(OPENCODE_SESSION, V1_PROFILE), opencodeHeaders());
	});
	it("sextet appends the six fingerprint names and is idempotent", () => {
		const body: Record<string, unknown> = { tools: [] };
		ensureFingerprintToolsFor(body, "sextet", false);
		assert.deepEqual(namesOf(body).sort(), ["bash", "edit", "glob", "grep", "read", "write"]);
		ensureFingerprintToolsFor(body, "sextet", false);
		assert.equal(namesOf(body).length, 6);
	});
	it("bash-read appends bash+read and is idempotent", () => {
		const body: Record<string, unknown> = { tools: [] };
		ensureFingerprintToolsFor(body, "bash-read", false);
		assert.deepEqual(namesOf(body).sort(), ["bash", "read"]);
		ensureFingerprintToolsFor(body, "bash-read", false);
		assert.equal(namesOf(body).length, 2);
	});
	it("read-shell appends read+shell with verbatim v2 params and is idempotent", () => {
		const body: Record<string, unknown> = { tools: [] };
		ensureFingerprintToolsFor(body, "read-shell", false);
		assert.deepEqual(namesOf(body).sort(), ["read", "shell"]);
		const byName = new Map(
			(body.tools as Array<{ function: { name: string; parameters: unknown } }>).map((t) => [t.function.name, t.function.parameters]),
		);
		assert.equal(JSON.stringify(byName.get("read")), READ_V2_PARAM);
		assert.equal(JSON.stringify(byName.get("shell")), SHELL_V2_PARAM);
		ensureFingerprintToolsFor(body, "read-shell", false);
		assert.equal(namesOf(body).length, 2);
	});
});

describe("opencode A/B variants (opt-in only, defaults unchanged)", () => {
	it("V2_PROFILE emits the CLI v2 shape byte-exact", () => {
		_resetLiveOpenCodeVersionForTest();
		const headers = opencodeHeadersFor(OPENCODE_SESSION, V2_PROFILE);
		assert.equal(headers["x-opencode-request"], undefined, "v2 omits the request header like the default lane");
		assert.deepEqual(headers, {
			Authorization: "Bearer public",
			"User-Agent": `opencode/latest/${OPENCODE_V2_VERSION_FALLBACK}/cli`,
			"x-opencode-client": "cli",
			"x-opencode-project": OPENCODE_PROJECT,
			"x-opencode-session": OPENCODE_SESSION,
			"x-opencode-session-id": OPENCODE_SESSION,
			"x-session-affinity": OPENCODE_SESSION,
			"x-session-id": OPENCODE_SESSION,
		});
	});

	it("V2_PROFILE differs from V1_PROFILE only in the User-Agent", () => {
		_resetLiveOpenCodeVersionForTest();
		const v1 = opencodeHeadersFor(OPENCODE_SESSION, V1_PROFILE);
		const v2 = opencodeHeadersFor(OPENCODE_SESSION, V2_PROFILE);
		assert.match(v2["User-Agent"], /^opencode\/latest\/2\.\d+\.\d+\/cli$/);
		delete v1["User-Agent"];
		delete v2["User-Agent"];
		assert.deepEqual(v2, v1, "headers beyond the UA are identical, so the A/B isolates the UA");
	});

	it("project variants resolve fixed/global/cwd without mutating the profile", () => {
		const fixed = withProjectHeader(V2_PROFILE, "fixed");
		assert.equal(fixed.project, OPENCODE_PROJECT);
		const global = withProjectHeader(V2_PROFILE, "global");
		assert.equal(global.project, "global");
		const cwd = withProjectHeader(V2_PROFILE, "cwd", "/repo/pi-freeflow");
		assert.equal(cwd.project, createHash("sha1").update("/repo/pi-freeflow").digest("hex"));
		assert.match(cwd.project, /^[0-9a-f]{40}$/, "cwd variant is a sha1 hex digest like the CLI sends");
		const emptyCwd = withProjectHeader(V2_PROFILE, "cwd");
		assert.equal(emptyCwd.project, OPENCODE_PROJECT, "missing cwd falls back to the fixed pin");
		assert.equal(V2_PROFILE.project, OPENCODE_PROJECT, "the profile itself is never mutated");
		assert.equal(V1_PROFILE.project, OPENCODE_PROJECT, "the default profile is untouched");
	});

	it("env block stays exactly one pair with every toolset variant active", () => {
		for (const tools of ["sextet", "bash-read", "read-shell"] as const) {
			const body: Record<string, unknown> = {
				model: "m",
				messages: [
					{ role: "system", content: "You are a coding agent." },
					{ role: "user", content: "hi" },
				],
				tools: [],
			};
			ensureFingerprintToolsFor(body, tools, false);
			enforceOpencodeFingerprint(body, "/v1/chat/completions");
			const system = (body.messages as Array<{ content: string }>)[0].content;
			assert.equal(system.match(/<env>[\s\S]*?<\/env>/g)?.length, 1, `exactly one pair with ${tools}`);
			assert.match(system, /Working directory:/, `load-bearing key present with ${tools}`);
		}
	});

	it("openai-compat body variant marks usage accounting and keeps the env block", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: [
				{ role: "system", content: "You are a coding agent." },
				{ role: "user", content: "hi" },
			],
		};
		enforceOpencodeFingerprint(body, "/v1/chat/completions");
		assert.equal(body.stream_options, undefined, "the default lane never sends stream_options");
		applyOpenAiCompatVariant(body);
		assert.deepEqual(body.stream_options, { include_usage: true });
		const system = (body.messages as Array<{ content: string }>)[0].content;
		assert.equal(system.match(/<env>[\s\S]*?<\/env>/g)?.length, 1, "variant preserves the single env pair");
		applyOpenAiCompatVariant(body);
		assert.deepEqual(body.stream_options, { include_usage: true }, "idempotent");
	});

	it("openai-compat variant merges into an existing stream_options object", () => {
		const body: Record<string, unknown> = { stream_options: { include_usage: false } };
		applyOpenAiCompatVariant(body);
		assert.deepEqual(body.stream_options, { include_usage: true });
	});
});
