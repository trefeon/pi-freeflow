/**
 * OMP host tool usage: every real OMP tool survives freeflow translation.
 *
 * Fixtures below are literal copies of the real host schemas (SPEC ONLY —
 * never import from reference/): names from BUILTIN_TOOL_NAMES in
 * reference/oh-my-pi packages/coding-agent/src/tools/builtin-names.ts plus
 * the browser/computer tools, hidden names from HIDDEN_TOOL_NAMES in the same
 * module, the `mcp__<server>_<tool>` prefix minted by
 * reference/oh-my-pi packages/coding-agent/src/mcp/tool-bridge.ts, the custom
 * wrap shape from extensibility/custom-tools/wrapper.ts (CustomToolAdapter),
 * and one xd:// device name (settings-schema.ts xd:// Tools). Required params
 * and `strict` match what each host class declares (all strict=true except
 * task which declares strict=false, and browser/computer/yield/goal/xd which
 * declare no strict at all).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildFindGlobRestore,
	restoreToolChoiceForCaller,
	restoreToolNameForCaller,
	retargetToolChoiceForUpstream,
	translateToolsForPath,
	upstreamToolNameFor,
} from "../src/tool-translation.ts";

const PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"] as const;
type Path = (typeof PATHS)[number];
type Style = "chat" | "responses" | "anthropic";

interface Fixture {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict?: boolean;
}

const O = (properties: Record<string, unknown>, required?: string[]): Record<string, unknown> =>
	required ? { type: "object", properties, required } : { type: "object", properties };
const S = (desc: string): Record<string, unknown> => ({ type: "string", description: desc });

// Real OMP inventory: 28 built-ins (builtin-names.ts + browser/computer).
const OMP_FIXTURES: Fixture[] = [
	{
		name: "read",
		description: "Read a file, directory listing, image, document, or internal URL into context",
		parameters: O({ path: S("file, directory, or internal URL to read"), "offset?": S("starting line"), "limit?": S("max lines") }, ["path"]),
		strict: true,
	},
	{
		name: "bash",
		description: "Execute a shell command in the workspace",
		parameters: O({ command: S("command to execute"), "cwd?": S("working directory"), "timeout?": S("timeout ms") }, ["command"]),
		strict: true,
	},
	{
		name: "edit",
		description: "Apply a patch edit to a file on disk",
		parameters: O({ path: S("file path"), edits: S("patch edit entries") }, ["path", "edits"]),
		strict: true,
	},
	{
		name: "ast_grep",
		description: "Search code with AST patterns (structural grep)",
		parameters: O({ pat: S("ast pattern"), "path?": S("file, directory, or glob to search"), "skip?": S("matches to skip") }, ["pat"]),
		strict: true,
	},
	{
		name: "ast_edit",
		description: "Structural AST-aware rewrites across files",
		parameters: O({ ops: S("rewrite ops"), paths: S("files, directories, or globs to rewrite") }, ["ops", "paths"]),
		strict: true,
	},
	{
		name: "ask",
		description: "Ask the user a clarifying question",
		parameters: O({ questions: S("questions to ask") }, ["questions"]),
		strict: true,
	},
	{
		name: "debug",
		description: "Debugger access: breakpoints, stepping, and thread inspection",
		parameters: O({ action: S("debug action"), "program?": S("debug target path") }, ["action"]),
		strict: true,
	},
	{
		name: "eval",
		description: "Run one step of code in a persistent kernel",
		parameters: O({ language: S("runtime: py or js"), code: S("code to run") }, ["language", "code"]),
		strict: true,
	},
	{
		name: "github",
		description: "GitHub operations: repos, PRs, search, checkout, Actions watch",
		parameters: O({ op: S("github operation"), "repo?": S("owner/repo") }, ["op"]),
		strict: true,
	},
	{
		name: "glob",
		description: "Fast file search by glob pattern",
		parameters: O({ "path?": S("glob or directory to search"), "limit?": S("max results") }),
		strict: true,
	},
	{
		name: "grep",
		description: "Search file contents with a regex pattern",
		parameters: O({ pattern: S("regex pattern"), "path?": S("file, directory, or glob to search") }, ["pattern"]),
		strict: true,
	},
	{
		name: "lsp",
		description: "Symbol-aware code intelligence from language servers",
		parameters: O({ action: S("lsp action"), "file?": S("source file") }, ["action"]),
		strict: true,
	},
	{
		name: "checkpoint",
		description: "Create a git-based checkpoint to save session state",
		parameters: O({ goal: S("investigation goal") }, ["goal"]),
		strict: true,
	},
	{
		name: "rewind",
		description: "Rewind to a previously created checkpoint",
		parameters: O({ report: S("investigation findings") }, ["report"]),
		strict: true,
	},
	{
		name: "security_scan",
		description: "Repository security scans: plan, start, inspect, validate",
		parameters: O({ action: S("scan action"), "plan_id?": S("plan id") }, ["action"]),
		strict: true,
	},
	{
		name: "task",
		description: "Spawn subagents to complete delegated tasks",
		parameters: O({ task: S("delegated task instructions"), "agent?": S("agent type") }, ["task"]),
		strict: false,
	},
	{
		name: "hub",
		description: "Message peer agents, control background jobs, supervise processes",
		parameters: O({ op: S("hub operation") }, ["op"]),
		strict: true,
	},
	{
		name: "todo",
		description: "Write a structured todo list to track progress within a session",
		parameters: O({ op: S("todo operation"), "task?": S("task content") }, ["op"]),
		strict: true,
	},
	{
		name: "web_search",
		description: "Search the web for up-to-date information",
		parameters: O({ query: S("search query"), "limit?": S("max results") }, ["query"]),
		strict: true,
	},
	{
		name: "write",
		description: "Create or overwrite a file on disk",
		parameters: O({ path: S("file path"), content: S("file content") }, ["path", "content"]),
		strict: true,
	},
	{
		name: "memory_edit",
		description: "Update, forget, or invalidate stored memories",
		parameters: O({ op: S("memory edit operation"), id: S("memory id from recall output") }, ["op", "id"]),
		strict: true,
	},
	{
		name: "retain",
		description: "Store important facts in long-term memory",
		parameters: O({ items: S("items to remember") }, ["items"]),
		strict: true,
	},
	{
		name: "recall",
		description: "Search memory for relevant prior context",
		parameters: O({ query: S("natural language search query") }, ["query"]),
		strict: true,
	},
	{
		name: "reflect",
		description: "Synthesize an answer from long-term memory",
		parameters: O({ query: S("question to answer") }, ["query"]),
		strict: true,
	},
	{
		name: "learn",
		description: "Capture a reusable lesson to memory (and optionally a managed skill)",
		parameters: O({ memory: S("the durable lesson to remember"), "context?": S("source context") }, ["memory"]),
		strict: true,
	},
	{
		name: "manage_skill",
		description: "Create, update, or delete an isolated managed skill",
		parameters: O({ action: S("skill action"), name: S("kebab-case skill name") }, ["action", "name"]),
		strict: true,
	},
	// browser/computer declare no `strict` on the host: fixtures omit it too.
	{
		name: "browser",
		description: "Drive real Chromium tabs: open, observe, act, run JavaScript",
		parameters: O({ action: S("browser operation"), "url?": S("url to open") }, ["action"]),
	},
	{
		name: "computer",
		description: "Control the host desktop: windows, screenshots, input, AX trees",
		parameters: O({ action: S("computer operation"), "code?": S("js body to run") }, ["action"]),
	},
];

// Hidden tools (HIDDEN_TOOL_NAMES): yield/goal declare no strict, think is strict.
const HIDDEN_FIXTURES: Fixture[] = [
	{
		name: "yield",
		description: "Submit the subagent result",
		parameters: O({ "result?": S("result payload") }),
	},
	{
		name: "goal",
		description: "Record the session goal",
		parameters: O({ goal: S("goal text") }, ["goal"]),
	},
	{
		name: "think",
		description: "Record private scratchpad thoughts",
		parameters: O({ thought: S("thought text") }, ["thought"]),
		strict: true,
	},
];

// MCP (tool-bridge.ts mints `mcp__<server>_<tool>`), custom wrap
// (CustomToolAdapter carries name/description/parameters/strict), xd device.
const EXTRA_FIXTURES: Fixture[] = [
	{
		name: "mcp__github__search_code",
		description: "MCP github tool: search code",
		parameters: O({ query: S("search query") }, ["query"]),
		strict: true,
	},
	{
		name: "my_custom_tool",
		description: "Custom user tool wrapped by CustomToolAdapter",
		parameters: O({ input: S("tool input") }, ["input"]),
		strict: true,
	},
	{
		name: "xd://report_issue",
		description: "Mounted xd device tool",
		parameters: O({ issue: S("issue text") }, ["issue"]),
	},
];

const ALL_FIXTURES: Fixture[] = [...OMP_FIXTURES, ...HIDDEN_FIXTURES, ...EXTRA_FIXTURES];

function inputFor(style: Style, fx: Fixture): Record<string, unknown> {
	const extra = { x_omp_usage: `${fx.name}-marker` };
	if (style === "chat") {
		const tool: Record<string, unknown> = {
			type: "function",
			function: { name: fx.name, description: fx.description, parameters: fx.parameters },
			...extra,
		};
		if (typeof fx.strict === "boolean") tool.strict = fx.strict;
		return tool;
	}
	if (style === "responses") {
		const tool: Record<string, unknown> = {
			type: "function",
			name: fx.name,
			description: fx.description,
			parameters: fx.parameters,
			...extra,
		};
		if (typeof fx.strict === "boolean") tool.strict = fx.strict;
		return tool;
	}
	const tool: Record<string, unknown> = {
		name: fx.name,
		description: fx.description,
		input_schema: fx.parameters,
		...extra,
	};
	if (typeof fx.strict === "boolean") tool.strict = fx.strict;
	return tool;
}

function upstreamNameOf(t: Record<string, unknown>): string {
	if (typeof t.name === "string") return t.name;
	const fn = t.function as Record<string, unknown> | undefined;
	return typeof fn?.name === "string" ? (fn.name as string) : "";
}

function upstreamParamsOf(t: Record<string, unknown>): unknown {
	const fn = t.function as Record<string, unknown> | undefined;
	if (fn && typeof fn.parameters === "object" && fn.parameters !== null) return fn.parameters;
	if (typeof t.parameters === "object" && t.parameters !== null) return t.parameters;
	if (typeof t.input_schema === "object" && t.input_schema !== null) return t.input_schema;
	return undefined;
}

function upstreamDescOf(t: Record<string, unknown>): unknown {
	if (typeof t.description === "string") return t.description;
	const fn = t.function as Record<string, unknown> | undefined;
	return typeof fn?.description === "string" ? fn.description : undefined;
}

const STYLES: Style[] = ["chat", "responses", "anthropic"];
const styleForPath = (path: Path): Style =>
	path.endsWith("/responses") ? "responses" : path.endsWith("/messages") ? "anthropic" : "chat";

for (const fx of ALL_FIXTURES) {
	test(`omp usage: ${fx.name} survives every shape x path verbatim`, () => {
		for (const style of STYLES) {
			for (const path of PATHS) {
				const input = inputFor(style, fx);
				const [out] = translateToolsForPath([input], path);
				const where = `${style} -> ${path} ${fx.name}`;
				assert.ok(out, `${where}: not dropped`);
				assert.equal(upstreamNameOf(out), fx.name, `${where}: name verbatim, never renamed/coerced`);
				assert.equal(upstreamDescOf(out), fx.description, `${where}: description verbatim`);
				assert.deepEqual(upstreamParamsOf(out), fx.parameters, `${where}: params verbatim`);
				if (typeof fx.strict === "boolean") {
					assert.equal(out.strict, fx.strict, `${where}: strict verbatim`);
				} else {
					assert.ok(!("strict" in out), `${where}: no strict invented`);
				}
				assert.equal(out.x_omp_usage, `${fx.name}-marker`, `${where}: extra field intact`);
				assert.ok(
					!JSON.stringify(upstreamParamsOf(out)).includes("additionalProperties"),
					`${where}: never injects additionalProperties`,
				);
				if (style === styleForPath(path)) {
					assert.equal(out, input, `${where}: same shape passes through verbatim (identical reference)`);
				}
			}
		}
	});
}

test("omp usage: full 28-tool OMP inventory survives on all three paths", () => {
	assert.equal(OMP_FIXTURES.length, 28, "28 OMP built-ins incl. browser/computer");
	for (const path of PATHS) {
		const out = translateToolsForPath(OMP_FIXTURES.map((fx) => inputFor("chat", fx)), path);
		assert.equal(out.length, 28, `${path}: no OMP tool dropped`);
		for (const fx of OMP_FIXTURES) {
			const found = out.find((t) => upstreamNameOf(t) === fx.name);
			assert.ok(found, `${path}: keeps ${fx.name}`);
		}
		const again = translateToolsForPath(out, path);
		assert.equal(again.length, 28, `${path}: re-translate idempotent, adds zero`);
	}
});

test("omp usage: dup collapse is case-insensitive, first-seen wins", () => {
	const dupes = [
		inputFor("chat", OMP_FIXTURES[0]),
		{ type: "function", name: "READ", description: "dup", parameters: O({}) },
		{ name: "Read", description: "dup", input_schema: O({}) },
	];
	for (const path of PATHS) {
		const out = translateToolsForPath(dupes, path);
		assert.equal(out.length, 1, `${path}: READ collapses to read`);
		assert.equal(upstreamNameOf(out[0]).toLowerCase(), "read", `${path}: canonical name kept`);
		assert.equal(upstreamDescOf(out[0]), OMP_FIXTURES[0].description, `${path}: first-seen wins`);
	}
});

test("omp usage: OMP glob untouched, never triggers find restore", () => {
	assert.equal(upstreamToolNameFor("glob"), "glob");
	assert.equal(upstreamToolNameFor("Glob"), "Glob", "caller casing preserved, never coerced");
	for (const style of STYLES) {
		for (const path of PATHS) {
			const globFx = OMP_FIXTURES.find((f) => f.name === "glob")!;
			const [out] = translateToolsForPath([inputFor(style, globFx)], path);
			assert.equal(upstreamNameOf(out), "glob", `${style} -> ${path}: OMP glob untouched`);
		}
	}
	const restore = buildFindGlobRestore([inputFor("chat", OMP_FIXTURES.find((f) => f.name === "glob")!)]);
	assert.equal(restore.renamedFindToGlob, false, "OMP glob alone never marks a rename");
	assert.equal(restoreToolNameForCaller("glob", restore), "glob", "no restore without rename");
	assert.equal(restoreToolNameForCaller("read", restore), "read");
});

test("omp usage: tool_choice string + named variants round-trip, never imposed", () => {
	const globOnly = buildFindGlobRestore([inputFor("chat", OMP_FIXTURES.find((f) => f.name === "glob")!)]);
	assert.equal(globOnly.renamedFindToGlob, false);
	assert.equal(retargetToolChoiceForUpstream("auto", globOnly), "auto", "string auto carried");
	assert.equal(retargetToolChoiceForUpstream("read", globOnly), "read", "string tool name carried");
	assert.deepEqual(
		retargetToolChoiceForUpstream({ type: "function", name: "read" }, globOnly),
		{ type: "function", name: "read" },
		"named variant carried upstream",
	);
	assert.deepEqual(
		retargetToolChoiceForUpstream({ type: "function", function: { name: "read" } }, globOnly),
		{ type: "function", function: { name: "read" } },
		"chat named variant carried upstream",
	);
	assert.deepEqual(
		restoreToolChoiceForCaller({ type: "function", name: "read" }, globOnly),
		{ type: "function", name: "read" },
		"named variant restored verbatim",
	);
	assert.deepEqual(
		restoreToolChoiceForCaller({ type: "function", function: { name: "read" } }, globOnly),
		{ type: "function", function: { name: "read" } },
		"chat named variant restored verbatim",
	);
	assert.equal(restoreToolChoiceForCaller("auto", globOnly), "auto", "string choice never rewritten");
});
