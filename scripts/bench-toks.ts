/* Live tok/s bench for pi-freeflow — direct upstream path only (relay disabled in-memory).
 *
 * Measures what the coordinator asked for, not theory:
 *   TTFBms       = send → first ANSWER delta (not first raw chunk)
 *   sustainedTokS = answerChars/4 / (terminal − firstAnswer), seconds
 *
 * SSE parse (runner parses itself; proxy only forwards + logs diagnostics):
 *   /v1/responses ANSWER = response.output_text.delta `delta` field
 *   /v1/chat/completions ANSWER = choices[0].delta.content
 *   REASONING = reasoning/thinking delta events (sniffThinking match), excluded from answer
 *   TERMINAL  = response.completed|done|failed|incomplete event, or [DONE]
 *
 * Effort contract (wire values, per model):
 *   muse-spark-1.2/1.3 : xhigh→xhigh, high→high (reasoning.effort; NEVER max)
 *   big-pickle         : max→max, high→high (reasoning_effort)
 *   zen chat others    : high→high (reasoning_effort)
 * Fresh prompt_cache_key per attempt (no history → no strip-retry path).
 *
 * Runner discipline: strictly sequential attempts, ≥10s cooldown, ≥60s after any 429.
 * No src/ edits, no disk state mutation (relay disable is in-memory, persist=false).
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench-toks.ts [--quick] [--out <path>]
 *   --quick runs 1 attempt per cell as a plumbing smoke test.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { startProxy } from "../src/proxy.ts";
import { getActiveRelayState, setActiveRelayState } from "../src/relay-state.ts";

const RESPONSES_MODELS: Record<string, true> = {
	"nemotron-3.5-super-vl-free": true,
};
const PORT = 29361;
const PROMPT = "Write a TypeScript LRU cache with JSDoc, ~80 lines, no preamble.";
const MAX_TOKENS = 2048;
const COOLDOWN_MS = 10_000;
const COOLDOWN_429_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 300_000;


interface PlanItem { model: string; effortLabel: string; effortSent: string | null }
interface BenchRow {
	model: string;
	effort: string;
	effortSent: string | null;
	endpoint: string;
	attempt: number;
	ttfbMs: number;
	sustainedTokS: number;
	totalOutChars: number;
	totalReasonChars: number;
	outTokensEst: number;
	path: string;
	servedRelay: string | null;
	rolled: boolean;
	stripped: boolean;
	status429: boolean;
	httpStatus: number;
	notes: string;
}

const FULL_PLAN: PlanItem[] = [
	// muse-spark-1.2: xhigh x3 + high x3, interleaved
	{ model: "nemotron-3.5-super-vl-free", effortLabel: "xhigh", effortSent: "xhigh" },
	{ model: "nemotron-3.5-super-vl-free", effortLabel: "high", effortSent: "high" },
	{ model: "nemotron-3.5-super-vl-free", effortLabel: "xhigh", effortSent: "xhigh" },
	{ model: "nemotron-3.5-super-vl-free", effortLabel: "high", effortSent: "high" },
	{ model: "nemotron-3.5-super-vl-free", effortLabel: "xhigh", effortSent: "xhigh" },
	{ model: "nemotron-3.5-super-vl-free", effortLabel: "high", effortSent: "high" },
	// big-pickle: max x3 + high x3, interleaved
	{ model: "big-pickle", effortLabel: "max", effortSent: "max" },
	{ model: "big-pickle", effortLabel: "high", effortSent: "high" },
	{ model: "big-pickle", effortLabel: "max", effortSent: "max" },
	{ model: "big-pickle", effortLabel: "high", effortSent: "high" },
	{ model: "big-pickle", effortLabel: "max", effortSent: "max" },
	{ model: "big-pickle", effortLabel: "high", effortSent: "high" },
	// one-shot comparison at high x3
	{ model: "nemotron-3.5-lightning-free", effortLabel: "high", effortSent: "high" },
	{ model: "nemotron-3.5-lightning-free", effortLabel: "high", effortSent: "high" },
	{ model: "nemotron-3.5-lightning-free", effortLabel: "high", effortSent: "high" },
];

function sniffThinking(s: string): boolean {
	return (
		s.includes("reasoning") ||
		s.includes("thinking") ||
		s.includes("<think>") ||
		s.includes("reasoning_content") ||
		s.includes('"type":"thinking"') ||
		s.includes("thinking_delta")
	);
}

const TERMINAL_MARKERS = [
	"response.completed",
	"response.done",
	"response.failed",
	"response.incomplete",
	"[DONE]",
];

function strField(obj: unknown, key: string): string | null {
	if (obj && typeof obj === "object" && key in obj) {
		const v = obj[key as keyof typeof obj];
		return typeof v === "string" ? v : null;
	}
	return null;
}

/** Answer text from a string-or-array content field (array = [{type:'text',text}]). */
function textFromContentField(c: unknown): string | null {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		let s = "";
		for (const p of c) {
			if (p && typeof p === "object" && "text" in p && typeof p.text === "string") {
				s += p.text;
			}
		}
		return s.length > 0 ? s : null;
	}
	return null;
}

function deltaContent(json: unknown): { content: string | null; reasoning: string | null } {
	if (json && typeof json === "object" && "choices" in json && Array.isArray(json.choices)) {
		const first = json.choices[0];
		if (first && typeof first === "object") {
			const holder = "delta" in first ? first.delta : ("message" in first ? first.message : null);
			if (holder && typeof holder === "object") {
				const content = "content" in holder ? textFromContentField(holder.content) : null;
				let reasoning: string | null = null;
				if ("reasoning_content" in holder && typeof holder.reasoning_content === "string") {
					reasoning = holder.reasoning_content;
				} else if ("reasoning" in holder && typeof holder.reasoning === "string") {
					reasoning = holder.reasoning;
				}
				return { content, reasoning };
			}
		}
	}
	return { content: null, reasoning: null };
}

/** First non-empty answer-ish string field on a Responses event (delta/text/content/output_text). */
function responsesAnswerText(json: unknown): string | null {
	if (!json || typeof json !== "object" || Array.isArray(json)) return null;
	if ("delta" in json && typeof json.delta === "string" && json.delta.length > 0) return json.delta;
	if ("text" in json && typeof json.text === "string" && json.text.length > 0) return json.text;
	if ("content" in json && typeof json.content === "string" && json.content.length > 0) return json.content;
	if ("output_text" in json && typeof json.output_text === "string" && json.output_text.length > 0) {
		return json.output_text;
	}
	return null;
}

/** Walk a response.completed response object → output[].content[] text (mirrors sseToResponsesJson). */
function walkCompletedResponse(resp: unknown): string {
	if (!resp || typeof resp !== "object" || Array.isArray(resp)) return "";
	if ("output_text" in resp && typeof resp.output_text === "string" && resp.output_text.length > 0) {
		return resp.output_text;
	}
	if (!("output" in resp) || !Array.isArray(resp.output)) return "";
	let s = "";
	for (const item of resp.output) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		if (!("content" in item)) continue;
		const content = item.content;
		if (typeof content === "string") { s += content; continue; }
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object" || Array.isArray(part)) continue;
			if (!("text" in part) || typeof part.text !== "string") continue;
			if ("type" in part && typeof part.type === "string" && !part.type.includes("text")) continue;
			s += part.text;
		}
	}
	return s;
}

function buildBody(model: string, effortSent: string | null, cacheKey: string): { endpoint: string; body: Record<string, unknown> } {
	if (RESPONSES_MODELS[model] === true) {
		const reasoning = effortSent ? { effort: effortSent } : undefined;
		return {
			endpoint: "/v1/responses",
			body: {
				model,
				input: PROMPT,
				stream: true,
				store: false,
				include: ["reasoning.encrypted_content"],
				prompt_cache_key: cacheKey,
				max_output_tokens: MAX_TOKENS,
				...(reasoning ? { reasoning } : {}),
			},
		};
	}
	return {
		endpoint: "/v1/chat/completions",
		body: {
			model,
			messages: [{ role: "user", content: PROMPT }],
			stream: true,
			max_tokens: MAX_TOKENS,
			...(effortSent ? { reasoning_effort: effortSent } : {}),
		},
	};
}

/** Force the direct path for this process only; never persists to disk. */
function forceDirectPath(): "direct" | "relay" {
	const cur = getActiveRelayState();
	setActiveRelayState({ ...cur, mode: "off", enabled: false }, false);
	const s = getActiveRelayState();
	const shouldUseRelay =
		s.mode !== "off" &&
		s.enabled !== false &&
		Boolean(s.url || (s.relays && s.relays.length > 0));
	return shouldUseRelay ? "relay" : "direct";
}

async function runAttempt(
	port: number,
	item: PlanItem,
	attempt: number,
): Promise<BenchRow> {
	const cacheKey = randomUUID();
	const { endpoint, body } = buildBody(item.model, item.effortSent, cacheKey);
	const path = forceDirectPath();
	const notes: string[] = [];
	const row: BenchRow = {
		model: item.model,
		effort: item.effortLabel,
		effortSent: item.effortSent,
		endpoint,
		attempt,
		ttfbMs: -1,
		sustainedTokS: 0,
		totalOutChars: 0,
		totalReasonChars: 0,
		outTokensEst: 0,
		path,
		servedRelay: null,
		rolled: false,
		stripped: false,
		status429: false,
		httpStatus: 0,
		notes: "",
	};

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(new Error("attempt-timeout")), ATTEMPT_TIMEOUT_MS);
	const sendAt = Date.now();
	let firstAnswerAt: number | null = null;
	let terminalAt: number | null = null;
	let terminalSeen = false;
	const markAnswer = (n: number): void => {
		if (firstAnswerAt === null) firstAnswerAt = Date.now();
		row.totalOutChars += n;
	};

	try {
		const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		row.httpStatus = res.status;
		if (res.status === 429) {
			row.status429 = true;
			notes.push("HTTP 429 (upstream rate limit); 60s cooldown follows");
		}
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => "");
			notes.push(`HTTP ${res.status}: ${text.slice(0, 160)}`);
			row.notes = notes.join("; ");
			return row;
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		const isResponses = endpoint === "/v1/responses";
		/** Split off complete CRLF-tolerant SSE blocks; keep the tail buffered. */
		const takeBlocks = (flush: boolean): string[] => {
			if (flush) {
				const tail = buf;
				buf = "";
				return tail === "" ? [] : [tail];
			}
			const parts = buf.split(/\r?\n\r?\n/);
			buf = parts.pop() ?? "";
			return parts;
		};
		/** Handle one parsed SSE data payload. Mutates row/terminal state. */
		const handlePayload = (json: unknown, block: string, eventName: string | null): void => {
			if (!json || typeof json !== "object") return;
			if (isResponses) {
				const t = strField(json, "type") ?? eventName ?? "";
				if (t.includes("reasoning") || t.includes("thinking")) {
					const txt = responsesAnswerText(json);
					if (txt !== null) row.totalReasonChars += txt.length;
					return;
				}
				if (t.includes("completed") || t.includes("response.done") || t.includes("incomplete") || t.includes("failed")) {
					// Fallback: full-text walk, only when no delta seen (no double-count).
					if (firstAnswerAt === null) {
						const withResp = "response" in json ? json.response : json;
						const full = walkCompletedResponse(withResp);
						if (full.length > 0) {
							notes.push("completed-fallback");
							markAnswer(full.length);
						}
					}
					return;
				}
				const txt = responsesAnswerText(json);
				if (txt !== null) {
					if (sniffThinking(block) && t !== "response.output_text.delta") {
						row.totalReasonChars += txt.length;
					} else {
						markAnswer(txt.length);
					}
				}
			} else {
				const { content, reasoning } = deltaContent(json);
				// Reasoning-only deltas carry content:"" during thinking; only
				// non-empty content is ANSWER (TTFB source).
				if (content !== null && content.length > 0) markAnswer(content.length);
				if (reasoning !== null) row.totalReasonChars += reasoning.length;
			}
		};
		const handleBlock = (block: string): void => {
			if (block.trim() === "") return;
			if (block.trim() === "[DONE]") { terminalSeen = true; terminalAt = terminalAt ?? Date.now(); return; }
			// Upstream keepalives (": keep-alive") ride this framing — skip them.
			if (block.trim().split(/\r?\n/).every((l) => l.trimStart().startsWith(":"))) return;
			if (!terminalSeen) {
				for (const m of TERMINAL_MARKERS) {
					if (block.includes(m)) { terminalSeen = true; terminalAt = Date.now(); break; }
				}
			}
			let eventName: string | null = null;
			const dataLines: string[] = [];
			for (const line of block.split(/\r?\n/)) {
				const tl = line.trimStart();
				if (tl.startsWith("event:")) eventName = tl.slice(6).trim();
				else if (tl.startsWith("data:")) dataLines.push(tl.slice(5).trimStart());
			}
			if (eventName !== null && /response\.(completed|done|failed|incomplete)/.test(eventName)) {
				terminalSeen = true;
				terminalAt = terminalAt ?? Date.now();
			}
			if (dataLines.length === 0) return;
			const joined = dataLines.join("\n").trim();
			if (joined === "[DONE]") { terminalSeen = true; terminalAt = terminalAt ?? Date.now(); return; }
			if (!joined) return;
			let parsed = false;
			try {
				handlePayload(JSON.parse(joined), block, eventName);
				parsed = true;
			} catch { /* try per-line below */ }
			if (!parsed) {
				for (const dl of dataLines) {
					const p = dl.trim();
					if (!p || p === "[DONE]") continue;
					try { handlePayload(JSON.parse(p), block, eventName); } catch { /* non-JSON keepalive */ }
				}
			}
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (value && value.length > 0) buf += decoder.decode(value, { stream: !done });
			for (const block of takeBlocks(false)) handleBlock(block);
			if (done) break;
		}
		for (const block of takeBlocks(true)) handleBlock(block);
		try { await reader.cancel().catch(() => {}); } catch { /* already closed */ }
	} catch (e) {
		notes.push(`fetch error: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
	} finally {
		clearTimeout(timeoutId);
	}
	if (terminalAt === null) terminalAt = Date.now();
	if (firstAnswerAt !== null) {
		row.ttfbMs = firstAnswerAt - sendAt;
		const durS = (terminalAt - firstAnswerAt) / 1000;
		row.sustainedTokS = durS > 0 ? row.totalOutChars / 4 / durS : 0;
	} else {
		notes.push("no-answer-delta");
	}
	row.outTokensEst = Math.round(row.totalOutChars / 4);
	row.notes = notes.join("; ");
	return row;
}

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdev(xs: number[]): number {
	if (xs.length < 2) return 0;
	const m = xs.reduce((a, b) => a + b, 0) / xs.length;
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const quick = args.includes("--quick");
	const outIdx = args.indexOf("--out");
	const outPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : "scripts/bench-results/bench-toks." + new Date().toISOString().slice(0, 10) + ".json";

	const plan = quick
		? [...new Map(FULL_PLAN.map((p) => [`${p.model}|${p.effortLabel}`, p])).values()]
		: FULL_PLAN;
	console.log(`bench-toks: ${plan.length} attempt(s)${quick ? " (quick smoke)" : " (full matrix)"}, direct path only`);

	const { server, port } = await startProxy(PORT);
	if (server === null) throw new Error(`port ${PORT} already held; refusing to attach (relay state would be foreign)`);
	console.log(`proxy up on 127.0.0.1:${port}; relay disabled in-memory (no disk writes)`);

	const rows: BenchRow[] = [];
	const attemptNo = new Map<string, number>();
	try {
		for (let i = 0; i < plan.length; i++) {
			const item = plan[i];
			const key = `${item.model}|${item.effortLabel}`;
			const n = (attemptNo.get(key) ?? 0) + 1;
			attemptNo.set(key, n);
			console.log(`\n[${i + 1}/${plan.length}] ${item.model} effort=${item.effortLabel} (wire=${item.effortSent}) attempt=${n}`);
			const row = await runAttempt(port, item, n);
			rows.push(row);
			console.log(`  TTFB=${row.ttfbMs}ms tokS=${row.sustainedTokS.toFixed(2)} out=${row.totalOutChars}ch reason=${row.totalReasonChars}ch http=${row.httpStatus} path=${row.path}${row.notes ? ` notes=${row.notes}` : ""}`);
			if (i < plan.length - 1) {
				const wait = row.status429 ? COOLDOWN_429_MS : COOLDOWN_MS;
				console.log(`  cooldown ${(wait / 1000).toFixed(0)}s…`);
				await sleep(wait);
			}
		}
	} finally {
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await promise;
	}

	// Aggregate per cell (successful-answer rows only for medians).
	const cells = new Map<string, BenchRow[]>();
	for (const r of rows) {
		const k = `${r.model}|${r.effort}`;
		if (!cells.has(k)) cells.set(k, []);
		cells.get(k)!.push(r);
	}
	console.log("\n=== PER-CELL MEDIANS (within-model comparison only) ===");
	console.log("model | effort (wire) | n/nOk | median TTFBms | median tok/s | stdev tok/s | median outCh | median reasonCh");
	for (const [k, rs] of cells) {
		const ok = rs.filter((r) => r.ttfbMs >= 0);
		const line = `${rs[0].model} | ${rs[0].effort} (${rs[0].effortSent}) | ${rs.length}/${ok.length}` +
			` | ${median(ok.map((r) => r.ttfbMs)).toFixed(0)}` +
			` | ${median(ok.map((r) => r.sustainedTokS)).toFixed(2)}` +
			` | ${stdev(ok.map((r) => r.sustainedTokS)).toFixed(2)}` +
			` | ${median(ok.map((r) => r.totalOutChars)).toFixed(0)}` +
			` | ${median(ok.map((r) => r.totalReasonChars)).toFixed(0)}`;
		console.log(line);
		void k;
	}

	fs.mkdirSync(outPath.split("/").slice(0, -1).join("/"), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify({ meta: { prompt: PROMPT, maxTokens: MAX_TOKENS, cooldownMs: COOLDOWN_MS, cooldown429Ms: COOLDOWN_429_MS, at: new Date().toISOString() }, rows }, null, 2));
	console.log(`\nraw rows → ${outPath}`);
	process.exit(0);
}

await main();
