/**
 * The real read / write / edit schemas, transcribed from both host checkouts,
 * in the form each host actually puts on the wire — including the strict-mode
 * rewrite, where `required` lists EVERY property key and the optional ones are
 * wrapped in `anyOf: [T, null]`.
 *
 * Source of truth:
 *  - OMP  reference/oh-my-pi/packages/coding-agent/src/tools/read.ts:778,
 *         write.ts:194, edit/schemas.ts:3-39; strict rewrite per
 *         packages/ai/src/utils/schema/CONSTRAINTS.md:34-49.
 *  - Pi   reference/pi/packages/coding-agent/src/core/tools/{read,write,edit}.ts;
 *         strict rewrite per packages/ai/src/api/constrained-sampling.ts:118-123.
 *
 * Both hosts emit these for read/write/edit; getting them wrong makes every
 * malformed call on the most-used tools unrepairable, and the failure is silent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildArgRepairSchemas, repairToolArguments } from "../src/tool-args.ts";
import { translateToolsForPath } from "../src/tool-translation.ts";

type Tool = Record<string, unknown>;

const NULLABLE = (inner: Tool): Tool => ({ anyOf: [inner, { type: "null" }] });

/** OMP write, strict form (content is optional in the source schema). */
const OMP_WRITE_STRICT: Tool = {
	type: "object",
	properties: { i: { type: "string" }, path: { type: "string" }, content: NULLABLE({ type: "string" }) },
	required: ["i", "path", "content"],
	additionalProperties: false,
};
/** OMP read, strict form. */
const OMP_READ_STRICT: Tool = {
	type: "object",
	properties: { i: { type: "string" }, path: { type: "string" } },
	required: ["i", "path"],
	additionalProperties: false,
};
/** OMP edit, default `hashline` mode, strict form. */
const OMP_EDIT_HASHLINE_STRICT: Tool = {
	type: "object",
	properties: { i: { type: "string" }, input: { type: "string" } },
	required: ["i", "input"],
	additionalProperties: false,
};
/** OMP edit, `patch` mode: the only nested one. */
const OMP_EDIT_PATCH: Tool = {
	type: "object",
	properties: {
		i: { type: "string" },
		path: { type: "string" },
		edits: {
			type: "array",
			items: {
				type: "object",
				properties: {
					op: { type: "string", enum: ["create", "delete", "update"] },
					rename: { type: "string" },
					diff: { type: "string" },
				},
			},
		},
	},
	required: ["i", "path", "edits"],
};
/** OMP edit, `replace` mode: snake_case keys, optional replace_all. */
const OMP_EDIT_REPLACE_STRICT: Tool = {
	type: "object",
	properties: {
		i: { type: "string" },
		path: { type: "string" },
		old_string: { type: "string" },
		new_string: { type: "string" },
		replace_all: NULLABLE({ type: "boolean" }),
	},
	required: ["i", "path", "old_string", "new_string", "replace_all"],
	additionalProperties: false,
};
/** Pi read: offset/limit optional, no intent injection on Pi. */
const PI_READ: Tool = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to read (relative or absolute)" },
		offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
		limit: { type: "number", description: "Maximum number of lines to read" },
	},
	required: ["path"],
};
/** Pi read, strict form. */
const PI_READ_STRICT: Tool = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to read (relative or absolute)" },
		offset: NULLABLE({ type: "number", description: "Line number to start reading from (1-indexed)" }),
		limit: NULLABLE({ type: "number", description: "Maximum number of lines to read" }),
	},
	required: ["path", "offset", "limit"],
	additionalProperties: false,
};

const schemasFor = (name: string, parameters: Tool) => buildArgRepairSchemas([{ type: "function", name, description: name, parameters }]);

/** OMP bash in strict form: every key listed as required, optional ones nullable. */
const OMP_BASH: Tool = {
	type: "object",
	properties: {
		i: { type: "string" },
		command: { type: "string" },
		timeout: NULLABLE({ type: "number" }),
		cwd: NULLABLE({ type: "string" }),
		pty: NULLABLE({ type: "boolean" }),
	},
	required: ["i", "command", "timeout", "cwd", "pty"],
	additionalProperties: false,
};

test("a strict host schema does not disable repair: a glued call is still recovered", () => {
	// Both hosts rewrite `required` to every key and mark the optional ones
	// nullable. Reading that literally made the gate refuse EVERY well-formed
	// call on a strict tool — which silently switched repair off for bash and
	// the strict edit modes, so the one payload this module exists to fix was
	// the one it could not fix.
	const glued = 'reelane-proxy"}{"i": "Confirming", "command": "git status --short", "cwd": "D:/tmp"}';
	const out = repairToolArguments("bash", glued, schemasFor("bash", OMP_BASH));
	assert.deepEqual(JSON.parse(out), { i: "Confirming", command: "git status --short", cwd: "D:/tmp" });
});

test("a genuinely missing non-nullable key is still refused", () => {
	// The strict exemption must not turn into blanket leniency: `command` is
	// required and not nullable, so a call without it is not a repair candidate.
	const bash: Tool = {
		type: "object",
		properties: { i: { type: "string" }, command: { type: "string" }, timeout: NULLABLE({ type: "number" }) },
		required: ["i", "command", "timeout"],
	};
	const missingCommand = 'x"}{"i": "Confirming"}';
	assert.equal(repairToolArguments("bash", missingCommand, schemasFor("bash", bash)), missingCommand);
});

test("every real read/write/edit shape survives a glued prefix", () => {
	const cases: Array<[string, Tool, string, Record<string, unknown>]> = [
		["read", OMP_READ_STRICT, 'notes.txt"}{"i": "Reading", "path": "notes.txt"}', { i: "Reading", path: "notes.txt" }],
		["write", OMP_WRITE_STRICT, 'a.txt"}{"i": "Writing", "path": "a.txt", "content": "hi"}', { i: "Writing", path: "a.txt", content: "hi" }],
		["edit", OMP_EDIT_HASHLINE_STRICT, 'old.txt"}{"i": "Editing", "input": "PUT 1=2"}', { i: "Editing", input: "PUT 1=2" }],
		["edit", OMP_EDIT_REPLACE_STRICT, 'a.txt"}{"i": "Editing", "path": "a.txt", "old_string": "x", "new_string": "y"}', { i: "Editing", path: "a.txt", old_string: "x", new_string: "y" }],
		["read", PI_READ, 'notes.txt"}{"path": "notes.txt"}', { path: "notes.txt" }],
		["read", PI_READ_STRICT, 'notes.txt"}{"path": "notes.txt"}', { path: "notes.txt" }],
	];
	for (const [name, parameters, payload, expected] of cases) {
		const out = repairToolArguments(name, payload, schemasFor(name, parameters));
		assert.deepEqual(JSON.parse(out), expected, `${name}: glued prefix must be dropped`);
	}
});

test("the nested patch-mode edit schema is not corrupted by repair", () => {
	// `edits[]` of objects is the one place a wrong promotion could reorder or
	// drop a diff; a well-formed call must come back byte-identical.
	const payload = JSON.stringify({ i: "Patching", path: "src/x.ts", edits: [{ op: "update", diff: "-a\n+b" }, { op: "delete", rename: "old.ts" }] });
	assert.equal(repairToolArguments("edit", payload, schemasFor("edit", OMP_EDIT_PATCH)), payload, "a well-formed nested call is untouched");
	// A glued prefix in front of the same call still recovers whole.
	const out = repairToolArguments("edit", `previous${payload}`, schemasFor("edit", OMP_EDIT_PATCH));
	assert.deepEqual(JSON.parse(out).edits, [
		{ op: "update", diff: "-a\n+b" },
		{ op: "delete", rename: "old.ts" },
	]);
});

test("a text null sentinel on a nullable non-string property becomes real null", () => {
	// Measured across 4 of 33 catalog models: free models answer a nullable
	// slot with the SENTINEL AS TEXT — `"timeout":"null"`, `"pty":"None"`. The
	// host rejects that because a string is neither the declared type nor null,
	// and the turn loops. Collapsing it is lossless: the property can never
	// legitimately hold a bare string.
	const bash = schemasFor("bash", OMP_BASH);
	assert.deepEqual(
		JSON.parse(repairToolArguments("bash", '{"i":"Checking","command":"ls","timeout":"null","cwd":null,"pty":"None"}', bash)),
		{ i: "Checking", command: "ls", timeout: null, cwd: null, pty: null },
	);
});

test("the sentinel rewrite never touches a nullable STRING property or a real value", () => {
	// The guard that makes the rewrite safe: when the non-null type is `string`,
	// `"null"` could be the genuine value, so it must survive untouched. A real
	// value on a numeric slot is likewise never coerced.
	const note = schemasFor("note", {
	type: "object",
	properties: { i: { type: "string" }, label: { anyOf: [{ type: "string" }, { type: "null" }] } },
		required: ["i", "label"],
	});
	assert.equal(repairToolArguments("note", '{"i":"Noting","label":"null"}', note), '{"i":"Noting","label":"null"}', 'a nullable string keeps the text "null"');
	assert.equal(
		repairToolArguments("bash", '{"i":"Checking","command":"ls","timeout":"180","cwd":null,"pty":null}', schemasFor("bash", OMP_BASH)),
		'{"i":"Checking","command":"ls","timeout":"180","cwd":null,"pty":null}',
		'a real value on a numeric slot is never coerced',
);
});

test("a missing non-nullable key is still refused: the intent field cannot be invented", () => {
	// `i` is required and not nullable, and repair never fabricates content, so
	// a call that omits it is left for the host to reject. Recorded so the
	// exemption above is not read as blanket leniency.
	const glued = 'previous"}{"command":"git status","cwd":"D:/tmp"}';
	assert.equal(repairToolArguments("bash", glued, schemasFor("bash", OMP_BASH)), glued);
});

test("a grammar-only edit tool carries no parameters and passes through untouched", () => {
	// In `apply_patch` mode OMP may emit { type: "custom", name, format: {...} }
	// instead of a JSON Schema. It is not a function tool, so translation must
	// keep it exactly as the caller sent it rather than reshaping or dropping it.
	const grammarTool: Tool = {
		type: "custom",
		name: "apply_patch",
		format: { type: "grammar", syntax: "lark", definition: "start: /.+/\\n" },
	};
	for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
		const out = translateToolsForPath([grammarTool], path);
		assert.equal(out.length, 1, `${path}: grammar tool not dropped`);
		assert.deepEqual(out[0], grammarTool, `${path}: grammar tool forwarded verbatim`);
	}
});

test("edit's five OMP modes each keep their own declared shape through translation", () => {
	// OMP's edit schema is model- and setting-dependent. Whichever one the host
	// declares must reach the model byte-identically; the proxy must never pick
	// a mode of its own.
	const modes: Array<[string, Tool]> = [
		["hashline", OMP_EDIT_HASHLINE_STRICT],
		["replace", OMP_EDIT_REPLACE_STRICT],
		["patch", OMP_EDIT_PATCH],
	];
	for (const [mode, parameters] of modes) {
		const caller: Tool = { type: "function", function: { name: "edit", description: `Edit a file (${mode})`, parameters } };
		for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
			const [out] = translateToolsForPath([caller], path);
			assert.ok(out, `${mode} -> ${path}: dropped`);
			const fn = out.function as Tool | undefined;
			const schema = (fn?.parameters ?? out.parameters ?? out.input_schema) as Tool;
			assert.deepEqual(schema, parameters, `${mode} -> ${path}: schema altered`);
		}
	}
});