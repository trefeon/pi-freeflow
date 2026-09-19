import test from "node:test";
import assert from "node:assert/strict";
import {
	PI_TOOL_NAMES,
	buildFindGlobRestore,
	restoreToolNameForCaller,
	retargetToolChoiceForUpstream,
	translateToolsForPath,
	upstreamToolNameFor,
} from "../src/tool-translation.ts";

// Real Pi host schemas copied as literals from
// reference/pi packages/coding-agent/src/core/tools/{bash,powershell,read,write,edit,grep,find,ls}.ts
// (TypeBox param keys + descriptions; required = non-optional keys; TypeBox emits no
// additionalProperties by default). Custom envelope from core/extensions/types.ts
// ToolDefinition (name/label/description/parameters/constrainedSampling/prepareArguments).
// Strict rules from reference/pi packages/ai/src/api/constrained-sampling.ts:
// constrainedSampling { type: "json_schema", strict: "prefer" | "require" } resolves to wire
// strict: true when the provider supports it; the translator carries the wire flag verbatim
// and never injects additionalProperties: false itself.

const PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"] as const;
const STYLES = ["chat", "responses", "anthropic"] as const;
type Style = (typeof STYLES)[number];

// Literal truncation math from reference/pi tools/truncate.ts + per-tool DEFAULT_LIMIT:
// DEFAULT_MAX_LINES 2000, DEFAULT_MAX_BYTES 50KB, grep limit 100 / line 500 chars,
// find limit 1000, ls limit 500.
const BASH_DESC =
	"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";
const POWERSHELL_DESC =
	"Execute a PowerShell command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";
const READ_DESC =
	"Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.";
const WRITE_DESC =
	"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";
const EDIT_DESC =
	"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.";
const GREP_DESC =
	"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.";
const FIND_DESC =
	"Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).";
const LS_DESC =
	"List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).";

// bashSchema (bash.ts) doubles as the powershell schema (powershell.ts reuses
// createShellToolDefinition with the same { command, timeout? } shape).
const SHELL_PARAMS = {
	type: "object",
	properties: {
		command: { type: "string", description: "Shell command to execute" },
		timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
	},
	required: ["command"],
};

const PI_FIXTURES: Record<string, { description: string; parameters: Record<string, unknown> }> = {
	read: {
		description: READ_DESC,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to read (relative or absolute)" },
				offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
				limit: { type: "number", description: "Maximum number of lines to read" },
			},
			required: ["path"],
		},
	},
	bash: { description: BASH_DESC, parameters: SHELL_PARAMS },
	powershell: { description: POWERSHELL_DESC, parameters: SHELL_PARAMS },
	edit: {
		description: EDIT_DESC,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
				edits: {
					type: "array",
					description:
						"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
					items: {
						type: "object",
						properties: {
							oldText: {
								type: "string",
								description:
									"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
							},
							newText: { type: "string", description: "Replacement text for this targeted edit." },
						},
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		},
	},
	write: {
		description: WRITE_DESC,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to write (relative or absolute)" },
				content: { type: "string", description: "Content to write to the file" },
			},
			required: ["path", "content"],
		},
	},
	grep: {
		description: GREP_DESC,
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Search pattern (regex or literal string)" },
				path: { type: "string", description: "Directory or file to search (default: current directory)" },
				glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
				ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
				literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
				context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
				limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
			},
			required: ["pattern"],
		},
	},
	find: {
		description: FIND_DESC,
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
				path: { type: "string", description: "Directory to search in (default: current directory)" },
				limit: { type: "number", description: "Maximum number of results (default: 1000)" },
			},
			required: ["pattern"],
		},
	},
	ls: {
		description: LS_DESC,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory to list (default: current directory)" },
				limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
			},
			required: [],
		},
	},
};

function mkTool(
	style: Style,
	name: string,
	description: string,
	params: Record<string, unknown>,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	if (style === "chat") return { type: "function", function: { name, description, parameters: params }, ...extra };
	if (style === "responses") return { type: "function", name, description, parameters: params, ...extra };
	return { name, description, input_schema: params, ...extra };
}

function upstreamNameOf(t: Record<string, unknown>): unknown {
	if (typeof t.name === "string") return t.name;
	return (t.function as Record<string, unknown>).name;
}

function upstreamParamsOf(t: Record<string, unknown>): unknown {
	const fn = t.function as Record<string, unknown> | undefined;
	if (fn && typeof fn === "object" && "parameters" in fn) return fn.parameters;
	if ("parameters" in t) return t.parameters;
	return (t as Record<string, unknown>).input_schema;
}

function upstreamDescOf(t: Record<string, unknown>): unknown {
	const fn = t.function as Record<string, unknown> | undefined;
	if (fn && typeof fn === "object" && "description" in fn) return fn.description;
	return t.description;
}


test("pi inventory: ToolNames union is exactly the 8 host tools", () => {
	assert.deepEqual([...PI_TOOL_NAMES], ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
	for (const name of Object.keys(PI_FIXTURES)) assert.ok((PI_TOOL_NAMES as readonly string[]).includes(name));
});

// One row per Pi tool per path: every real schema survives translation with params,
// description, and required keys verbatim; the translator never injects
// additionalProperties. find is the only rename (find -> glob).
for (const name of PI_TOOL_NAMES) {
	for (const path of PATHS) {
		test(`pi usage: ${name} survives ${path}`, () => {
			const fixture = PI_FIXTURES[name];
			for (const style of STYLES) {
				const input = mkTool(style, name, fixture.description, fixture.parameters, { x_pi: `x-${name}` });
				const [out] = translateToolsForPath([input], path);
				assert.ok(out, `${style} -> ${path} ${name}: not dropped`);
				assert.equal(upstreamNameOf(out), name === "find" ? "glob" : name, `${style} -> ${path} ${name}: name`);
				assert.equal(upstreamDescOf(out), fixture.description, `${style} -> ${path} ${name}: description verbatim`);
				assert.deepEqual(upstreamParamsOf(out), fixture.parameters, `${style} -> ${path} ${name}: params verbatim`);
				assert.equal((out as Record<string, unknown>).x_pi, `x-${name}`, `${style} -> ${path} ${name}: extra carried`);
				assert.ok(
					!JSON.stringify(upstreamParamsOf(out)).includes("additionalProperties"),
					`${style} -> ${path} ${name}: no additionalProperties injected`,
				);
				assert.ok(!("strict" in out), `${style} -> ${path} ${name}: strict never imposed`);
				const targetShape = path.endsWith("/responses") ? "responses" : path.endsWith("/messages") ? "anthropic" : "chat";
				if (name !== "find" && style === targetShape) {
					assert.equal(out, input, `${style} -> ${path} ${name}: same shape passes by reference`);
				}
				if (name === "find") {
					assert.notEqual(out, input, `${style} -> ${path} find: rename always produces a new object`);
				}
			}
		});
	}
}

test("pi usage: powershell and ls pass through verbatim, never dropped or folded into bash", () => {
	for (const path of PATHS) {
		const ps = mkTool("chat", "powershell", POWERSHELL_DESC, SHELL_PARAMS);
		const ls = mkTool("chat", "ls", LS_DESC, PI_FIXTURES.ls.parameters);
		const out = translateToolsForPath([ps, ls], path);
		assert.equal(out.length, 2, `${path}: powershell + ls both kept`);
		assert.equal(upstreamNameOf(out[0]), "powershell", `${path}: powershell keeps its own name`);
		assert.equal(upstreamNameOf(out[1]), "ls", `${path}: ls kept verbatim`);
		assert.deepEqual(upstreamParamsOf(out[0]), SHELL_PARAMS, `${path}: powershell params verbatim`);
		if (path === "/v1/chat/completions") {
			assert.equal(out[0], ps, "powershell same-shape passes by reference");
			assert.equal(out[1], ls, "ls same-shape passes by reference");
		}
	}
});

test("pi usage: find renames to glob on all paths and shapes, restore map brings find back", () => {
	for (const style of STYLES) {
		for (const path of PATHS) {
			const input = mkTool(style, "find", FIND_DESC, PI_FIXTURES.find.parameters);
			const [out] = translateToolsForPath([input], path);
			assert.equal(upstreamNameOf(out), "glob", `${style} -> ${path}: find becomes glob`);
			assert.equal(upstreamDescOf(out), FIND_DESC, `${style} -> ${path}: find description verbatim`);
			assert.deepEqual(upstreamParamsOf(out), PI_FIXTURES.find.parameters, `${style} -> ${path}: find params verbatim`);
		}
	}
	assert.equal(upstreamToolNameFor("find"), "glob");
	assert.equal(upstreamToolNameFor("Find"), "glob", "rename is case-insensitive");
	const renamed = buildFindGlobRestore([
		{ type: "function", name: "find", description: FIND_DESC, parameters: PI_FIXTURES.find.parameters },
	]);
	assert.equal(renamed.renamedFindToGlob, true);
	assert.equal(restoreToolNameForCaller("glob", renamed), "find", "restore map brings find back");
	assert.equal(restoreToolNameForCaller("read", renamed), "read", "non-glob names untouched by restore");
	// tool_choice is carried across the rename, never imposed.
	assert.deepEqual(
		retargetToolChoiceForUpstream({ type: "function", name: "find" }, renamed),
		{ type: "function", name: "glob" },
	);
	assert.equal(retargetToolChoiceForUpstream("auto", renamed), "auto", "auto choice never retargeted");
	assert.equal(retargetToolChoiceForUpstream(undefined, renamed), undefined, "absent choice never imposed");
});

test("pi usage: OMP-style glob fixture is untouched and never restores to find", () => {
	const globParams = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] };
	for (const style of STYLES) {
		for (const path of PATHS) {
			const [out] = translateToolsForPath([mkTool(style, "glob", "g", globParams)], path);
			assert.equal(upstreamNameOf(out), "glob", `${style} -> ${path}: OMP glob untouched`);
		}
	}
	const globOnly = buildFindGlobRestore([
		{ type: "function", name: "glob", description: "g", parameters: globParams },
	]);
	assert.equal(globOnly.renamedFindToGlob, false, "glob alone never restores");
	assert.equal(restoreToolNameForCaller("glob", globOnly), "glob");
	const both = buildFindGlobRestore([
		{ type: "function", name: "find", description: FIND_DESC, parameters: PI_FIXTURES.find.parameters },
		{ type: "function", name: "glob", description: "g", parameters: globParams },
	]);
	assert.equal(both.renamedFindToGlob, false, "find + glob together collapses with no restore");
	const collapsed = translateToolsForPath(
		[
			{ type: "function", name: "find", description: FIND_DESC, parameters: PI_FIXTURES.find.parameters },
			{ type: "function", name: "glob", description: "g", parameters: globParams },
		],
		"/v1/chat/completions",
	);
	assert.equal(collapsed.length, 1, "find collapses with glob first-seen-wins");
});

test("pi usage: grep glob param is not confused with the glob tool", () => {
	for (const path of PATHS) {
		const out = translateToolsForPath(
			[
				mkTool("chat", "grep", GREP_DESC, PI_FIXTURES.grep.parameters),
				mkTool("chat", "glob", "g", { type: "object", properties: {}, required: [] }),
			],
			path,
		);
		assert.equal(out.length, 2, `${path}: grep and glob coexist`);
		const grep = out.find((t) => upstreamNameOf(t) === "grep");
		assert.ok(grep, `${path}: grep keeps its name`);
		const props = (upstreamParamsOf(grep!) as Record<string, Record<string, unknown>>).properties;
		assert.deepEqual(
			props.glob,
			{ type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
			`${path}: grep inner glob key verbatim, not treated as the glob tool`,
		);
	}
});

test("pi usage: edit legacy { oldText, newText } shim input passes through as the caller sent it", () => {
	// prepareArguments (edit.ts) folds top-level oldText/newText into edits[] at host
	// execution time. The translator must preserve the caller-sent shape so the host
	// shim still sees it; it never normalizes legacy keys itself.
	const legacyParams = {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
			oldText: { type: "string", description: "Legacy single-edit old text" },
			newText: { type: "string", description: "Legacy single-edit new text" },
		},
		required: ["path"],
	};
	const legacyChat = mkTool("chat", "edit", EDIT_DESC, legacyParams);
	const [same] = translateToolsForPath([legacyChat], "/v1/chat/completions");
	assert.equal(same, legacyChat, "legacy edit shape passes by reference on its native path");
	for (const path of ["/v1/responses", "/v1/messages"] as const) {
		const [converted] = translateToolsForPath([legacyChat], path);
		assert.deepEqual(upstreamParamsOf(converted), legacyParams, `${path}: legacy oldText/newText keys intact, not folded into edits[]`);
		assert.equal(upstreamNameOf(converted), "edit");
	}
});

test("pi usage: ls all-optional schema keeps required [] and carries strict uncoerced", () => {
	assert.deepEqual(
		(PI_FIXTURES.ls.parameters as Record<string, unknown>).required,
		[],
		"ls fixture is all-optional per ls.ts",
	);
	for (const path of PATHS) {
		const [absent] = translateToolsForPath([mkTool("chat", "ls", LS_DESC, PI_FIXTURES.ls.parameters)], path);
		assert.ok(!("strict" in absent), `${path}: absent strict stays absent`);
		const [on] = translateToolsForPath(
			[mkTool("chat", "ls", LS_DESC, PI_FIXTURES.ls.parameters, { strict: true })],
			path,
		);
		assert.equal((on as Record<string, unknown>).strict, true, `${path}: strict true rides along`);
		assert.deepEqual(upstreamParamsOf(on), PI_FIXTURES.ls.parameters, `${path}: required [] intact under strict`);
		const [off] = translateToolsForPath(
			[mkTool("chat", "ls", LS_DESC, PI_FIXTURES.ls.parameters, { strict: false })],
			path,
		);
		assert.equal((off as Record<string, unknown>).strict, false, `${path}: strict false never coerced to true`);
	}
});

test("pi usage: custom registerTool envelope keeps unbounded name with constrainedSampling prefer/require", () => {
	// ToolDefinition (extensions/types.ts) allows any name; constrainedSampling
	// { type: "json_schema", strict } resolves to wire strict (constrained-sampling.ts
	// resolveJsonSchemaStrictSampling). Both the resolved wire flag and the envelope
	// field must survive translation verbatim.
	const customParams = {
		type: "object",
		properties: { diff: { type: "string", description: "Unified diff to review" } },
		required: ["diff"],
	};
	const cases = [
		{ name: "my_org__code_review", constrainedSampling: { type: "json_schema", strict: "prefer" } },
		{ name: "Review-Bot v2", constrainedSampling: { type: "json_schema", strict: "require" } },
	];
	for (const { name, constrainedSampling } of cases) {
		for (const path of PATHS) {
			const [out] = translateToolsForPath(
				[mkTool("responses", name, "custom review", customParams, { strict: true, constrainedSampling })],
				path,
			);
			assert.equal(upstreamNameOf(out), name, `${path}: unbounded custom name verbatim`);
			assert.deepEqual(upstreamParamsOf(out), customParams, `${path}: custom params verbatim`);
			assert.equal((out as Record<string, unknown>).strict, true, `${path}: resolved strict rides along`);
			assert.deepEqual(
				(out as Record<string, unknown>).constrainedSampling,
				constrainedSampling,
				`${path}: constrainedSampling ${(constrainedSampling as Record<string, unknown>).strict} carried`,
			);
			assert.ok(
				!JSON.stringify(upstreamParamsOf(out)).includes("additionalProperties"),
				`${path}: custom params gain no additionalProperties`,
			);
		}
	}
});

test("pi usage: addedToolNames and terminate result fields are never stripped", () => {
	// AgentToolResult (agent/src/types.ts) carries addedToolNames + terminate; the
	// translator only reshapes request tools, so result envelopes pass through by
	// reference on every path.
	const envelopes = [
		{
			role: "tool",
			tool_call_id: "call_1",
			content: [{ type: "text", text: "ok" }],
			addedToolNames: ["my_org__code_review"],
			terminate: true,
		},
		{
			role: "tool",
			tool_call_id: "call_2",
			content: [{ type: "text", text: "done" }],
			addedToolNames: [],
			terminate: false,
		},
	];
	for (const path of PATHS) {
		const out = translateToolsForPath(envelopes, path);
		assert.equal(out.length, 2, `${path}: result envelopes kept`);
		assert.equal(out[0], envelopes[0], `${path}: result passes by reference`);
		assert.deepEqual(
			(out[0] as Record<string, unknown>).addedToolNames,
			["my_org__code_review"],
			`${path}: addedToolNames intact`,
		);
		assert.equal((out[0] as Record<string, unknown>).terminate, true, `${path}: terminate intact`);
		assert.equal((out[1] as Record<string, unknown>).terminate, false, `${path}: terminate false never coerced`);
	}
});
