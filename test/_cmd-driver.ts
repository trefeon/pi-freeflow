/**
 * One-off headless driver: exercises every /pi-freeflow subcommand against a sandboxed HOME.
 * Run: node --experimental-strip-types test/_cmd-driver.ts
 */
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "../src/types.ts";

/** Minimal persisted relay-state shape the assertions care about. */
type StateFile = {
	mode?: string;
	enabled?: boolean;
	url?: string;
	relays?: Array<{ url: string; label?: string }>;
};

/** Mock of the TUI surface the command handlers touch. */
type UiLike = {
	notify(message: string, level?: string): void;
	input(prompt: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	setStatus?(...args: unknown[]): void;
};

interface Script {
	input?: string[];
	select?: string[];
}
interface RunResult {
	cmd: string;
	ok: boolean;
	note: string;
}

const home = mkdtempSync(path.join(tmpdir(), "ff-cmd-"));
mkdirSync(home, { recursive: true });
process.env.USERPROFILE = home;
process.env.HOME = home;

// Re-root every data path into this temp home BEFORE importing src/ (paths are
// resolved at module evaluation). Dynamic import is mandatory here despite the
// no-dynamic-import rule: static ESM imports hoist and evaluate src/ BEFORE the
// override above, leaking every path constant to the real ~/.pi/agent. This
// driver exists precisely to exercise that module-loading boundary in
// isolation.
const config = await import("../src/config.ts");
const { createCommandSpec } = await import("../src/commands.ts");

const stateFile = config.RELAY_STATE_FILE;

function makeCtx(script: Script = {}) {
	const msgs: Array<{ level: string; text: string }> = [];
	const inputs = [...(script.input ?? [])];
	const selects = [...(script.select ?? [])];
	const ui: UiLike = new Proxy({} as UiLike, {
		get(_t, prop): unknown {
			if (prop === "notify") {
				return (m: string, level?: string) => {
					msgs.push({ level: level ?? "info", text: String(m) });
				};
			}
			if (prop === "input") {
				return async () => (inputs.length ? inputs.shift() : "");
			}
			if (prop === "select") {
				return async () => (selects.length ? selects.shift() : "");
			}
			return () => {};
		},
	});
	// Unchecked cast: mock covers only the handler-used slice of ExtensionContext.
	const ctx = { ui } as unknown as ExtensionContext;
	return { ctx, msgs };
}

const results: RunResult[] = [];
const readState = (): StateFile | null => {
	if (!existsSync(stateFile)) return null;
	// Unchecked cast: JSON blob narrowed to the assertion-relevant slice of relay-state.json.
	return JSON.parse(readFileSync(stateFile, "utf8")) as StateFile;
};

async function run(
	cmd: string,
	script: Script = {},
	expect?: (msgs: string[], st: StateFile | null) => string | null,
): Promise<void> {
	const spec = createCommandSpec(null as never);
	const { ctx, msgs } = makeCtx(script);
	try {
		await spec.handler(cmd, ctx);
		const texts = msgs.map((m) => m.text);
		const err = expect ? expect(texts, readState()) : null;
		results.push({ cmd, ok: !err, note: err ?? (texts[0]?.slice(0, 90) ?? "(no notify)") });
	} catch (e) {
		results.push({ cmd, ok: false, note: `THREW: ${(e as Error).message}` });
	}
}

// 1. Bare menu — cancel immediately
await run("", { select: [""] }, (_m, st) =>
	st ? "bare menu mutated state on cancel" : null);

// 2-4. Modes on empty pool
await run("status");
await run("list");
await run("on", {}, (_m, st) => (!st || st.mode !== "on" || !st.enabled) ? "on: mode/enabled wrong" : null);
await run("off", {}, (_m, st) => (!st || st.mode !== "off" || st.enabled !== false) ? "off: mode/enabled wrong" : null);
await run("auto", {}, (_m, st) => (!st || st.mode !== "auto" || !st.enabled) ? "auto: mode/enabled wrong" : null);

// 5-7. add (+ duplicate rename semantics)
await run("add https://r1.example.dev alpha", {}, (_m, st) =>
	(!st?.relays?.some((r) => r.url === "https://r1.example.dev") || st.url !== "https://r1.example.dev")
		? "add r1 missing/not active" : null);
await run("add https://r1.example.dev alpha2", {}, (_m, st) => {
	const dupes = st?.relays?.filter((r) => r.url === "https://r1.example.dev") ?? [];
	return dupes.length !== 1 ? `dup add created ${dupes.length} entries` : null;
});
await run("add https://r2.example.dev beta", {}, (_m, st) =>
	st?.relays?.length !== 2 ? "expected 2 relays" : null);

// 8-11. use / label / rename
await run("use 2", {}, (_m, st) => st?.url !== "https://r2.example.dev" ? "use index failed" : null);
await run("use alpha2", {}, (_m, st) => st?.url !== "https://r1.example.dev" ? "use label alias failed" : null);
await run("label 1 gamma", {}, (_m, st) =>
	st?.relays?.find((r) => r.url === "https://r1.example.dev")?.label !== "gamma" ? "label failed" : null);
await run("rename https://r2.example.dev beta2", {}, (_m, st) =>
	st?.relays?.find((r) => r.url === "https://r2.example.dev")?.label !== "beta2" ? "rename failed" : null);
await run("label 99 ghost", {}, (m) =>
	m.some((t) => t.includes("not found")) ? null : "missing not-found warning");

// 12-13. remove guards (active URL computed dynamically from persisted state)
const activeUrl = readState()?.url ?? "";
await run(`remove ${activeUrl}`, {}, (m) =>
	m.some((t) => t.toLowerCase().includes("cannot remove")) ? null : "active-relay removal not blocked");
await run("remove beta2", {}, (_m, st) =>
	st?.relays?.some((r) => r.url === "https://r2.example.dev") ? "remove by label failed" : null);

// 14. url
await run("url https://r3.example.dev", {}, (_m, st) => st?.url !== "https://r3.example.dev" ? "url set failed" : null);

// 15. debug family
await run("debug on");
await run("debug off");
await run("debug level debug");
await run("debug level bogus", {}, (m) =>
	m.some((t) => t.includes("Unknown level")) ? null : "bogus level accepted silently");
await run("debug level audit", {}, (m) =>
	m.some((t) => t.includes("Unknown level")) ? null : "REGRESSION: 'audit' accepted (silences all logging)");
await run("debug");

// 16. logs family (sandbox log empty)
await run("logs");
await run("logs error 10");
await run("trace deadbeef");

// 17. catalog aliases
for (const c of ["refresh", "models", "reload"]) {
	await run(c, {}, (m) =>
		m.some((t) => t.includes("Refreshed")) ? null : `${c}: no refresh confirmation`);
}

// 18. deploy cancel path
await run("deploy", { input: [""] }, (m) =>
	m.some((t) => t.toLowerCase().includes("cancel")) ? null : "deploy without token did not cancel cleanly");

let fail = 0;
for (const r of results) {
	if (!r.ok) fail++;
	console.log(`${r.ok ? "PASS" : "FAIL"}  /pi-freeflow ${r.cmd.padEnd(38)} ${r.note}`);
}
console.log(`\n${results.length - fail}/${results.length} passed | sandbox: ${home}`);
process.exit(fail ? 1 : 0);
