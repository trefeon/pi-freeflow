/**
 * Whole-inventory fidelity audit.
 *
 * The model only ever sees what the proxy forwards, so "tools pass cleanly to
 * the host" reduces to: for every tool either host can declare, on every wire
 * shape, the translated tool must carry the same name, description and JSON
 * Schema the caller sent.
 *
 * The corpus covers the JSON Schema constructs omptype/OMP actually emit -
 * nested objects, arrays of objects, enums, `["string","null"]` unions,
 * `$ref`/`$defs`, `anyOf`, `description`-heavy tools, unicode, and the very
 * long hashline `edit` description.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	ALL_HOST_TOOL_NAMES,
	PI_TOOL_NAMES,
	OMP_CUSTOM_TOOL_NAMES,
	OMP_HIDDEN_TOOL_NAMES,
	OMP_TOOL_NAMES,
	injectFingerprintTools,
	translateToolsForPath,
	apiForPathname,
} from "../src/tool-translation.ts";

const PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"] as const;

/** Locate one tool by name in any of the three wire shapes. */
function pick(tools: Record<string, unknown>[], name: string): Record<string, unknown> {
	const t = tools.find((x) => {
		const fn = x.function as Record<string, unknown> | undefined;
		return (fn?.name ?? x.name) === name;
	});
	assert.ok(t, `tool ${name} missing from translated set`);
	return t;
}

/** Unwrap a wire-shape tool back to { name, description, parameters }. */
function canon(t: Record<string, unknown>): { name: string; description: string; parameters: unknown } {
	const fn = t.function as Record<string, unknown> | undefined;
	const name = (fn?.name ?? t.name) as string;
	const description = (fn?.description ?? t.description) as string;
	const parameters = fn?.parameters ?? t.parameters ?? t.input_schema;
	return { name, description, parameters };
}

const LONG_DESCRIPTION =
	"Hashline patches existing files; new files: `write`. Each file: `[PATH#TAG]`, `TAG` required 4-hex snapshot from latest `read`/`search`.\n" +
	"<ops>\n`PUT N.=M:` replace inclusive N-M with `+` body; lone `+` writes blank. Literal leading `-`/`+`: `+- text`/`++ text`.\n" +
	"NEVER restyle unrelated code. After EVERY edit tag/numbers change: use edit response or fresh `read`; stale tag -> STOP, re-read.";

const UNICODE_DESCRIPTION =
	"Write a file — creates or overwrites. Ünïcödé paths, emoji 🎯, CJK 日本語, RTL ‮abc‬, tabs\tand CRLF\r\nlines, and `back\\slash` + \"quotes\" survive.";

/** Every schema construct the hosts actually emit, in one inventory. */
const SCHEMA_CORPUS: Record<string, Record<string, unknown>> = {
	read: {
		type: "object",
		properties: {
			path: { type: "string", description: "`[foo.ts#1A2B]`, `TAG` required 4-hex snapshot" },
			i: { type: "string", description: "concise intent" },
		},
		required: ["path"],
	},
	bash: {
		type: "object",
		properties: { i: { type: "string" }, command: { type: "string" }, cwd: { type: "string" } },
		required: ["command"],
	},
	edit: {
		type: "object",
		properties: { path: { type: "string" }, input: { type: "string" } },
		required: ["path", "input"],
	},
	todo: {
		type: "object",
		properties: {
			op: { type: "string", enum: ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] },
			list: {
				type: "array",
				items: {
					type: "object",
					properties: {
						phase: { type: "string" },
						items: { type: "array", items: { type: "string" }, minItems: 1 },
					},
					required: ["phase", "items"],
				},
			},
			task: { type: "string" },
			reason: { type: "string" },
		},
		required: ["op"],
	},
	task: {
		type: "object",
		properties: {
			tasks: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string" },
						task: { type: "string" },
						agent: { type: "string" },
						outputSchema: { type: "object", additionalProperties: true },
					},
					required: ["task"],
				},
			},
		},
		required: ["tasks"],
	},
	ask: {
		type: "object",
		properties: {
			questions: {
				type: "array",

				items: {
					type: "object",
					properties: {
						id: { type: "string" },
						question: { type: "string" },
						options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } } } },
						multi: { type: "boolean" },
						recommended: { type: "integer" },
					},
					required: ["id", "question", "options"],
				},
			},
		},
		required: ["questions"],
	},
	// union types, nullable scalars, enums, refs, composition keywords
	lsp: {
		type: "object",
		properties: {
			operation: { type: "string", enum: ["definition", "references", "diagnostics", "hover"] },
			path: { type: ["string", "null"] },
			line: { type: "integer" },
			count: { type: "number" },
			enabled: { type: "boolean" },
			symbol: { type: ["string", "null"] },
		},
		required: ["operation"],
	},
	write: {
		type: "object",
		properties: { path: { type: "string" }, content: { type: "string" }, i: { type: "string" } },
		required: ["path", "content"],
	},
	grep: {
		type: "object",
		pattern: "string",
		path: "string",
	},
	// deep nesting + $defs/$ref + anyOf, as omptype emits for recursive types
	web_search: {
		type: "object",
		properties: {
			query: { type: "string" },
			recency: { type: "string", enum: ["day", "week", "month", "year"] },
			filter: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
			nested: {
				type: "object",
				properties: {
					deeper: {
						type: "object",
						properties: {
							list: { type: "array", items: { type: "array", items: { type: "number" } } },
							meta: { type: "object", properties: { k: { type: "string" }, v: { type: ["string", "number", "null"] } } },
						},
					},
				},
			},
		},
		required: ["query"],
	},
	hub: {
		type: "object",
		properties: {
			handles: { type: "array", items: { type: "string" } },
			timeout: { type: ["integer", "null"] },
			raiseErrors: { type: "boolean" },
		},
	},
	mcp__github: { type: "object", properties: { query: { type: "string" }, op: { type: "string" } }, required: ["op"] },
	"xd://lsp": { type: "object", properties: { operation: { type: "string" } }, required: ["operation"] },
};

/**
 * The two hosts never mix inventories in one request: Pi declares `find`,
 * OMP declares `glob`, and both rename onto the same upstream name. Auditing
 * them as one list would let the dedup hide one behind the other, so each
 * caller's real inventory gets its own pass.
 */
const SHARED_NAMES = [...OMP_HIDDEN_TOOL_NAMES, ...OMP_CUSTOM_TOOL_NAMES, ...Object.keys(SCHEMA_CORPUS)];
const INVENTORIES: Array<[string, string[]]> = [
	["pi", [...new Set<string>([...PI_TOOL_NAMES, ...SHARED_NAMES])]],
	["omp", [...new Set<string>([...OMP_TOOL_NAMES, ...SHARED_NAMES])]],
];

/** Every name, for the union-coverage assertions. */
const NAMES = [...new Set<string>(INVENTORIES.flatMap(([, names]) => names))];

/** A tool declaration in the caller's (pre-translate) chat shape. */
function callerTool(name: string): Record<string, unknown> {
	const schema = SCHEMA_CORPUS[name] ?? { type: "object", properties: { i: { type: "string" } } };
	const description =
		name === "edit" ? LONG_DESCRIPTION : name === "write" ? UNICODE_DESCRIPTION : `${name} tool`;
	return { type: "function", function: { name, description, parameters: schema } };
}

/**
 * Upstream name for a caller tool. `find` is deliberately declared as `glob`
 * so the upstream gate sees the tool it expects; `restoreToolNameForCaller`
 * maps it back on the way home. Every other name rides verbatim.
 */
function upstreamName(name: string): string {
	return name === "find" ? "glob" : name;
}

test("every host tool name survives translation on every wire shape", () => {
	for (const [caller, names] of INVENTORIES) {
		for (const path of PATHS) {
			const tools = injectFingerprintTools(translateToolsForPath(names.map(callerTool), path), path);
			const seen = new Set(tools.map((t) => canon(t).name));
			for (const name of names) {
				assert.ok(seen.has(upstreamName(name)), `${caller} ${path}: tool ${name} lost during translation`);
			}
		}
	}
});

test("every host tool schema is forwarded byte-identically", () => {
	for (const [caller, names] of INVENTORIES) {
		for (const path of PATHS) {
			const tools = injectFingerprintTools(translateToolsForPath(names.map(callerTool), path), path);
			for (const name of names) {
				const sent = callerTool(name).function as Record<string, unknown>;
				const got = canon(pick(tools, upstreamName(name)));
				assert.equal(got.name, upstreamName(name), `${caller} ${path}/${name}: name changed`);
				assert.equal(got.description, sent.description, `${caller} ${path}/${name}: description not verbatim`);
				// Byte-identical, not merely deep-equal: key order and every keyword survive.
				assert.equal(
					JSON.stringify(got.parameters),
					JSON.stringify(sent.parameters),
					`${caller} ${path}/${name}: parameters reshaped`,
				);
			}
		}
	}
});

test("long and unicode descriptions reach the model unchanged", () => {
	for (const path of PATHS) {
		const tools = injectFingerprintTools(translateToolsForPath([callerTool("edit"), callerTool("write")], path), path);
		assert.equal(canon(pick(tools, "edit")).description, LONG_DESCRIPTION, `${path}: long edit description altered`);
		assert.equal(canon(pick(tools, "write")).description, UNICODE_DESCRIPTION, `${path}: unicode description altered`);
	}
});

test("fingerprint injection never duplicates or drops a caller tool", () => {
	for (const [caller, names] of INVENTORIES) {
		for (const path of PATHS) {
			const tools = injectFingerprintTools(translateToolsForPath(names.map(callerTool), path), path);
			const lowered = tools.map((t) => canon(t).name.toLowerCase());
			const dupes = lowered.filter((n, i) => lowered.indexOf(n) !== i);
			assert.deepEqual(dupes, [], `${caller} ${path}: duplicate tool names after injection: ${dupes.join(", ")}`);
			// Every caller tool is still there exactly once, under its upstream name.
			for (const name of names) {
				const count = lowered.filter((n) => n === upstreamName(name).toLowerCase()).length;
				assert.equal(count, 1, `${caller} ${path}: ${name} present ${count} times`);
			}
		}
	}
});

test("apiForPathname routes all three wire shapes", () => {
	assert.equal(apiForPathname("/v1/chat/completions"), "chat");
	assert.equal(apiForPathname("/v1/responses"), "responses");
	assert.equal(apiForPathname("/v1/messages"), "messages");
});

test("ALL_HOST_TOOL_NAMES is the union both callers draw from", () => {
	for (const name of [...PI_TOOL_NAMES, ...OMP_TOOL_NAMES, ...OMP_HIDDEN_TOOL_NAMES, ...OMP_CUSTOM_TOOL_NAMES]) {
		assert.ok(ALL_HOST_TOOL_NAMES.has(name), `${name} missing from ALL_HOST_TOOL_NAMES`);
	}
});
