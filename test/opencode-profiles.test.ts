import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	opencodeHeaders,
	openCodeProjectForCwd,
	OPENCODE_PROJECT_GLOBAL,
	_resetLiveOpenCodeVersionForTest,
} from "../src/config.ts";
import {
	applyOpenAiCompatVariant,
	enforceOpencodeFingerprint,
	ensureChatFull11Tools,
} from "../src/opencode-fingerprint.ts";
import { FULL11_TOOL_NAMES } from "../src/tool-translation.ts";

function namesOf(body: Record<string, unknown>): string[] {
	const tools = body.tools as Array<{ function?: { name?: unknown } }>;
	return tools.map((t) => String(t.function?.name));
}

describe("opencode live lane", () => {
	it("headers match the live lane (full UA, request id, no affinity)", () => {
		_resetLiveOpenCodeVersionForTest();
		const headers = opencodeHeaders("conv-live");
		assert.match(
			headers["User-Agent"],
			/^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/4\.0\.23 runtime\/bun\/1\.4\.4$/,
			"full CLI UA",
		);
		assert.equal(headers["Authorization"], "Bearer public");
		assert.equal(headers["x-opencode-client"], "cli");
		assert.equal(headers["x-opencode-project"], "global", "global outside a repo");
		assert.match(headers["x-opencode-session"] ?? "", /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "ses_* session");
		assert.equal(headers["x-opencode-session-id"], headers["x-opencode-session"], "session pair matches");
		assert.match(headers["x-opencode-request"] ?? "", /^msg_[0-9A-Za-z]{26}$/, "fresh msg_* request id per prepare");
		assert.equal(headers["x-session-affinity"], undefined, "no affinity on the opencode lane");
		assert.equal(headers["x-session-id"], undefined, "no affinity on the opencode lane");
	});

	it("same conversation key reuses the session, fresh keys and calls get fresh ids", () => {
		const a = opencodeHeaders("conv-reuse");
		const b = opencodeHeaders("conv-reuse");
		assert.equal(a["x-opencode-session"], b["x-opencode-session"], "stable per-conversation session");
		assert.notEqual(a["x-opencode-request"], b["x-opencode-request"], "fresh request id per prepare");
		const other = opencodeHeaders("conv-other");
		assert.notEqual(other["x-opencode-session"], a["x-opencode-session"], "fresh session per conversation");
		const anon = opencodeHeaders();
		assert.match(anon["x-opencode-session"] ?? "", /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "omitted key allocates fresh");
	});

	it("project header is global-or-cwd like the CLI sends", () => {
		assert.equal(opencodeHeaders(undefined, "/repo/pi-freeflow")["x-opencode-project"], openCodeProjectForCwd("/repo/pi-freeflow"));
		assert.match(
			opencodeHeaders(undefined, "/repo/pi-freeflow")["x-opencode-project"] ?? "",
			/^[0-9a-f]{40}$/,
			"cwd project is a sha1 hex digest like the CLI sends",
		);
		assert.equal(opencodeHeaders()["x-opencode-project"], OPENCODE_PROJECT_GLOBAL);
		assert.equal(createHash("sha1").update("/repo/pi-freeflow").digest("hex"), openCodeProjectForCwd("/repo/pi-freeflow"));
	});

	it("full11 appends the eleven live roster names with verbatim schemas and is idempotent", () => {
		const body: Record<string, unknown> = { tools: [] };
		ensureChatFull11Tools(body);
		assert.deepEqual(namesOf(body).sort(), [...FULL11_TOOL_NAMES].sort());
		const byName = new Map(
			(body.tools as Array<{ function: { name: string; parameters: unknown } }>).map((t) => [t.function.name, t.function.parameters]),
		);
		for (const [slot, want] of [["bash", ["command"]], ["read", ["filePath"]], ["edit", ["filePath", "oldString", "newString"]]] as Array<[string, unknown]>) {
			const params = byName.get(slot);
			assert.ok(params && typeof params === "object" && "required" in params, `${slot} carries required`);
			assert.deepEqual(params.required, want, `${slot} verbatim CLI schema`);
		}
		ensureChatFull11Tools(body);
		assert.equal(namesOf(body).length, 11);
	});

	it("env block stays exactly one pair on the live lane", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: [
				{ role: "system", content: "You are a coding agent." },
				{ role: "user", content: "hi" },
			],
			tools: [],
		};
		ensureChatFull11Tools(body);
		enforceOpencodeFingerprint(body, "/v1/chat/completions");
		const system = (body.messages as Array<{ content: string }>)[0].content;
		assert.equal(system.match(/<env>[\s\S]*?<\/env>/g)?.length, 1, "exactly one pair");
		assert.match(system, /Working directory:/, "load-bearing key present");
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
		assert.deepEqual(body.stream_options, { include_usage: true }, "the default compat lane sends usage accounting");
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
