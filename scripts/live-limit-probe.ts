/* Live limit probe for pi-freeflow — validates ctx & max-output caps through the user's relay pool.
 * Read-only against upstreams; aborts streams early; no state mutation.
 * Usage: node --experimental-strip-types scripts/live-limit-probe.ts
 */
import { loadRelayState } from "../src/relay-state.ts";
import { agent } from "../src/relay.ts";

const PROXY = "http://127.0.0.1:28180";

const state = loadRelayState();
console.log(`relay pool: ${state.relays.length} relay(s), mode=${state.mode}, enabled=${state.enabled}`);

interface ProbeResult {
	model: string;
	kind: "ctx" | "max";
	value: number;
	status: number | string;
	verdict: "ACCEPTED" | "REJECTED" | "INCONCLUSIVE";
	detail: string;
}

const results: ProbeResult[] = [];

function filler(nTokens: number): string {
	// ~4 tokens per "word " chunk estimate; 37 chars ≈ 10 tokens → use repeating sentence
	const sent = "The quick brown fox jumps over the lazy dog near the river bank. ";
	const tokensPerSent = 20; // conservative estimate
	const reps = Math.ceil(nTokens / tokensPerSent);
	return sent.repeat(reps);
}

async function postBody(model: string, body: Record<string, unknown>, abortAfterFirst: boolean): Promise<{ status: number; text: string; gotData: boolean }> {
	const controller = new AbortController();
	try {
		const res = await fetch(`${PROXY}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (abortAfterFirst && res.body) {
			const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
			try {
				const first = await reader.read();
				const gotData = first.value ? first.value.toString().includes("data:") : false;
				controller.abort();
				return { status: res.status, text: gotData ? "stream-started" : "", gotData };
			} catch (e) {
				return { status: res.status, text: "read-failed: " + String(e), gotData: false };
			}
		}
		const text = await res.text();
		return { status: res.status, text: text.slice(0, 400), gotData: false };
	} catch (e) {
		const msg = (e as Error).message;
		if (msg.includes("aborted")) return { status: -1, text: "client-abort", gotData: false };
		return { status: -2, text: msg, gotData: false };
	}
}

async function probeMax(model: string, label: string, value: number): Promise<ProbeResult> {
	const body = {
		model,
		messages: [{ role: "user", content: "Reply with the single word: OK" }],
		max_tokens: value,
		stream: true,
	};
	const r = await postBody(model, body, true);
	if (r.status === 200 && r.gotData) return { model, kind: "max", value, status: 200, verdict: "ACCEPTED", detail: "stream started at max_tokens=" + value };
	if (r.status >= 400) return { model, kind: "max", value, status: r.status, verdict: "REJECTED", detail: r.text };
	return { model, kind: "max", value, status: r.status, verdict: "INCONCLUSIVE", detail: r.text };
}

async function probeCtx(model: string, label: string, nTokens: number): Promise<ProbeResult> {
	const body = {
		model,
		messages: [{ role: "user", content: filler(nTokens) }],
		max_tokens: 8,
		stream: true,
	};
	const r = await postBody(model, body, true);
	if (r.status === 200 && r.gotData) return { model, kind: "ctx", value: nTokens, status: 200, verdict: "ACCEPTED", detail: "stream started at ~" + nTokens + " input tokens" };
	if (r.status >= 400) return { model, kind: "ctx", value: nTokens, status: r.status, verdict: "REJECTED", detail: r.text };
	return { model, kind: "ctx", value: nTokens, status: r.status, verdict: "INCONCLUSIVE", detail: r.text };
}

const plan: Array<() => Promise<ProbeResult>> = [
	// ── CONTEXT ladder (expensive, high value) ──
	() => probeCtx("laguna-s-2.1-free", "laguna zen ctx", 270_000),      // >262,144 cap → 1M?
	() => probeCtx("laguna-s-2.1-free", "laguna zen ctx", 520_000),      // beyond half-M → 1M?
	() => probeCtx("liquid/lfm-2.5-2.6b:free", "lfm ctx", 70_000),       // >65,536 cap → 131K?
	() => probeCtx("nvidia/nemotron-3-super-120b-a12b:free", "super ctx", 270_000), // >262,144 cap → 1M?
	() => probeCtx("nvidia/nemotron-3-super-120b-a12b:free", "super ctx", 520_000),
	() => probeCtx("hy3-free", "hy3 zen ctx", 200_000),                  // >190,000 zen view → 262K?
	() => probeCtx("tencent/hy3:free", "hy3 kilo ctx", 270_000),         // >262,144? (marginal)
	// ── MAX OUTPUT ladder (cheap) ──
	() => probeMax("laguna-s-2.1-free", "laguna zen max", 33_000),       // >32,768 cap → 131K?
	() => probeMax("laguna-s-2.1-free", "laguna zen max", 65_000),
	() => probeMax("laguna-s-2.1-free", "laguna zen max", 131_072),
	() => probeMax("liquid/lfm-2.5-2.6b:free", "lfm max", 10_000),       // >8,192 cap → 32K?
	() => probeMax("liquid/lfm-2.5-2.6b:free", "lfm max", 32_768),
	() => probeMax("nvidia/nemotron-3-ultra-550b-a55b:free", "ultra kilo max", 70_000),  // >65,536 cap
	() => probeMax("nvidia/nemotron-3.5-lightning:free", "lightning kilo max", 70_000),
	() => probeMax("nvidia/nemotron-3-super-120b-a12b:free", "super max", 263_000),     // >262,144 cap
	() => probeMax("stepfun/step-3.7-flash:free", "step max", 263_000),  // >262,144 cap
	() => probeMax("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "nano-omni max", 70_000),
];

let idx = 0;
for (const p of plan) {
	idx++;
	console.log(`\n[${idx}/${plan.length}] probing…`);
	try {
		const r = await p();
		results.push(r);
		console.log(`  ${r.verdict} | ${r.model} | ${r.kind}=${r.value} | HTTP ${r.status} | ${r.detail.slice(0, 140)}`);
	} catch (e) {
		console.log(`  FAIL: ${(e as Error).message}`);
	}
}

console.log("\n\n=== SUMMARY ===");
for (const r of results) {
	console.log(`${r.verdict.padEnd(12)} ${r.model.padEnd(48)} ${r.kind}=${String(r.value).padStart(8)} HTTP ${String(r.status).padStart(3)}`);
}

await agent.close();
