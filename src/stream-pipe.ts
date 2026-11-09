/**
 * Upstream SSE streaming pipeline with thinking sniffing and exception isolation.
 *
 * Prevents upstream stream aborts or timeouts from crashing the host process.
 * Sniffs thinking and reasoning chunks for debug trace logging without payload mutation.
 */

import { randomUUID } from "node:crypto";
import type * as http from "node:http";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isDebugEnabled, log } from "./logger.ts";
import { markRelayFailure } from "./relay-state.ts";
import {
 WATCHDOG_SSE_FAIL_RATE,
 WATCHDOG_SSE_MIN_SAMPLES,
 WATCHDOG_SSE_WINDOW,
} from "./config.ts";
import { looksLikeSse } from "./sse-aggregator.ts";
import type { ToolcallStreamAudit } from "./toolcall-audit.ts";
import {
 createSseStreamCloakState,
 flushBufferedToolArgs,
 rewriteSseBlock,
 shouldBypassStreamCloak,
 type StreamCloakOptions,
} from "./stream-cloak.ts";

export * from "./stream-cloak.ts";

/**
 * A premature stream end counts as "substantial" only when BOTH thresholds
 * are strictly exceeded: more than 50 chunks AND more than 100KB. Substantial
 * truncations are reported as incomplete; smaller drops stay failed.
 */
export const SUBSTANTIAL_MIN_CHUNKS = 50;
export const SUBSTANTIAL_MIN_BYTES = 100 * 1024;
// Body-stall cut for streamed upstream bodies (see pipeUpstreamStream).
// Generous: every healthy stream observed on this proxy re-arms it within a
// few hundred ms; a 120s byte-silence on an open socket is a wedged relay
// leg, not a building model.
let bodyStallCutMs = 120_000;
/** Test-only: override the body-stall cut; returns a restore function. */
export function _setBodyStallCutForTest(ms: number): () => void {
 const prev = bodyStallCutMs;
 bodyStallCutMs = ms;
 return () => { bodyStallCutMs = prev; };
}
// Bounded lookahead for a streaming response whose upstream omitted the
// content-type: the pipe holds at most this many bytes while it waits for SSE
// evidence, then classifies the body itself (raw passthrough on overflow —
// a genuine SSE body opens with its first field line long before this).
const SNIFF_WINDOW_BYTES = 8192;
// Body-kind evidence is the shared `looksLikeSse` predicate (a `data:`/`event:`
// field line at a line start, CRLF-tolerant) — one source of truth with
// convertSseToJson's guard and the proxy's aggregate gates. Consulted only
// while the body kind is undecided (upstream sent no content-type).
// Wire markers proving the forwarded bytes already contain a tool call the
// host may execute (responses + chat shapes). A re-fired turn would
// regenerate those calls, so their presence vetoes the silent resume and
// the turn keeps the synthetic-terminal behavior. Text/reasoning turns are
// safe to resume: nothing was executed yet.
const TOOL_CALL_MARKERS = [
 '"type":"function_call"',
 '"type":"custom_tool_call"',
 '"type":"tool_use"',
 "function_call_arguments",
 "custom_tool_call_input",
 '"tool_calls"',
];
// Same wire evidence for the tool-call audit gate, plus the Anthropic
// argument-fragment event: those deltas carry no tool_use marker of their own
// (the `content_block_start` did), yet the recorder needs every fragment to
// classify the call, so they must reach observe() too.
const AUDIT_TOOL_MARKERS = [...TOOL_CALL_MARKERS, '"type":"input_json_delta"'];
// Turn-end frames carry the finish reason but no tool marker. They are the
// only evidence a tool turn ended in plain text, so the audit gate must let
// them through; matching the populated form (not the ubiquitous
// `"finish_reason":null` delta) keeps the gate at one extra block per turn.
const AUDIT_TURN_END_MARKERS = [
 '"finish_reason":"stop"',
 '"finish_reason":"tool_calls"',
 '"finish_reason":"length"',
 '"finish_reason":"content_filter"',
 '"stop_reason":"end_turn"',
 '"stop_reason":"tool_use"',
 '"stop_reason":"max_tokens"',
 '"stop_reason":"stop_sequence"',
 '"response.completed"',
 '"response.incomplete"',
 '"response.failed"',
];
const AUDIT_MARKERS = [...AUDIT_TOOL_MARKERS, ...AUDIT_TURN_END_MARKERS];

export function isSubstantial(chunks: number, bytes: number): boolean {
 return chunks > SUBSTANTIAL_MIN_CHUNKS && bytes > SUBSTANTIAL_MIN_BYTES;
}
// Markers identifying an upstream-issued mid-stream model failure worth one
// silent resume on a sibling relay (transient model flake, not a caller or
// upstream verdict). Kept narrow on purpose: anything shaped like a request,
// auth, quota, or reasoning-reference problem stays terminal and is
// forwarded untouched.
const TRANSIENT_MODEL_FAILURE_MARKERS = [
 "server_error",
 "failed to generate",
 "overloaded",
];
// Deterministic verdicts that must NEVER resume: retrying would replay the
// same refusal while masking a quota/auth/gate problem as relay trouble.
const DETERMINISTIC_FAILURE_MARKERS = [
 "invalid_request",
 "invalid_response",
 "invalid_reasoning",
 "previous_response",
 "FreeTierError",
 "rate_limit",
 "quota",
 "billing",
 "authentication",
 "invalid_api_key",
 "permission",
 "moderation",
];

/**
 * A 429-shaped mid-stream error frame is a per-egress rate limit, not a
 * terminal verdict: another relay IP may serve the same turn immediately.
 * Kept separate from isTransientModelFailureFrame (which owns model flakes),
 * and still vetoed by hard request/auth/quota verdicts so a billable or
 * malformed request is never replayed as relay trouble.
 */
const RATE_LIMIT_MARKERS = [
 "rate_limit",
 "rate limit",
 "too many requests",
 '"status":429',
 '"code":429',
 "shared free-tier ip quota",
];
const RATE_LIMIT_HARD_MARKERS = [
 "invalid_request",
 "invalid_response",
 "invalid_reasoning",
 "previous_response",
 "freetiererror",
 "insufficient_quota",
 "billing",
 "authentication",
 "invalid_api_key",
 "permission",
 "moderation",
];

/**
 * True when an SSE block carries an upstream-issued rate-limit error (HTTP
 * 429 / rate_limit_exceeded / "too many requests"). Requires an error-shaped
 * frame so ordinary model prose mentioning "rate limit" never triggers a
 * replay; hard billing/auth/request verdicts always win.
 */
export function isRetriableRateLimitFrame(s: string): boolean {
 const lower = s.toLowerCase();
 // A successful terminal echoes the full response object, whose `error` is
 // null; it can contain the model's prose ("HTTP 429 means rate limit") and
 // must never be replayed. Only a real error object/event may be held.
 if (lower.includes('"type":"response.completed"') || lower.includes('"status":"completed"')) {
  return false;
 }
 if (
  !lower.includes('"error":{') &&
  !lower.includes('"error":"') &&
  !lower.includes('"status":"failed"') &&
  !lower.includes("response.failed") &&
  !lower.includes('"type":"error"')
 ) {
  return false;
 }
 if (RATE_LIMIT_HARD_MARKERS.some((m) => lower.includes(m))) return false;
 return RATE_LIMIT_MARKERS.some((m) => lower.includes(m));
}


/**
 * True when scanned SSE text carries an upstream-issued response.failed frame
 * for a TRANSIENT model fault (server_error class). Text-only turns holding
 * such a frame may offer one silent re-fire; anything else (clean terminals,
 * deterministic verdicts, chat shapes) keeps existing behavior.
 */
export function isTransientModelFailureFrame(s: string): boolean {
 if (!s.includes("response.failed") && !s.includes('"status":"failed"')) return false;
 for (const m of DETERMINISTIC_FAILURE_MARKERS) if (s.includes(m)) return false;
 for (const m of TRANSIENT_MODEL_FAILURE_MARKERS) if (s.includes(m)) return true;
 return false;
}

/**
 * True when a trailing (framing-less) SSE block ends on a finished field line:
 * the upstream FIN'd right after a complete `data:`/`event:` value and only the
 * closing blank line is missing. Such a block carries a real event the client
 * was owed — dropping it lost the turn's last delta (probe: `data:
 * {"delta":"hello"}\n\n` then `data: {"delta":"world"}` + FIN delivered hello
 * and a synthetic [DONE], never world).
 *
 * A block cut inside its value (`data: {"a":`) or ending on anything other
 * than a `data:`/`event:` line stays dropped: forwarding it would put the
 * host's parser on a broken frame.
 */
function endsOnFinishedSseLine(tail: string): boolean {
 const lines = tail.split(/\r?\n/);
 // A trailing newline terminates the last line; judge the last non-empty one.
 let index = lines.length - 1;
 if (index > 0 && lines[index] === "") index -= 1;
 const line = lines[index] ?? "";
 if (line.startsWith("data:")) {
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return true;
  try {
   JSON.parse(payload);
   return true;
  } catch {
   // Not a complete JSON value: the block was cut mid-payload.
   return false;
  }
 }
 if (line.startsWith("event:")) return line.slice(6).trim().length > 0;
 return false;
}

// Mid-stream fault split (observability only, never routing): upstream-issued
// model-fault frames vs relay-fault truncations. Relay-health marks stay the
// rotation mechanism; these counters attribute blame for status/logs.
let midStreamModelFaults = 0;
let midStreamRateLimitFaults = 0;
let midStreamRelayTruncations = 0;

/** Current mid-stream fault split. */
export function getMidStreamFaultStats(): { modelFaults: number; rateLimitFaults: number; relayTruncations: number } {
 return { modelFaults: midStreamModelFaults, rateLimitFaults: midStreamRateLimitFaults, relayTruncations: midStreamRelayTruncations };
}

/** Test-only: reset the mid-stream fault split. */
export function _resetMidStreamFaultStatsForTest(): void {
 midStreamModelFaults = 0;
 midStreamRateLimitFaults = 0;
 midStreamRelayTruncations = 0;
}

/**
 * Failed-SSE rolling window (client watchdog input).
 *
 * The last WATCHDOG_SSE_WINDOW stream outcomes are kept (true = failed,
 * false = ok). Client disconnects and proxy-internal aborts never record —
 * only genuine upstream-side truncation/failure counts as failed, and a
 * clean terminal marker counts as ok. Degraded = at least
 * WATCHDOG_SSE_MIN_SAMPLES outcomes and a failure rate above
 * WATCHDOG_SSE_FAIL_RATE. Exposed on /_health via src/health.ts.
 */
const sseOutcomes: boolean[] = [];
let lastForwardedByteAt = 0;

export function recordSseOutcome(failed: boolean): void {
 sseOutcomes.push(failed);
 if (sseOutcomes.length > WATCHDOG_SSE_WINDOW) sseOutcomes.shift();
}

export function getSseStats(): {
 failures: number;
 total: number;
 rate: number;
 degraded: boolean;
} {
 const total = sseOutcomes.length;
 const failures = sseOutcomes.filter(Boolean).length;
 const rate = total === 0 ? 0 : failures / total;
 return {
  failures,
  total,
  rate,
  degraded: total >= WATCHDOG_SSE_MIN_SAMPLES && rate > WATCHDOG_SSE_FAIL_RATE,
 };
}

/** Timestamp (Date.now()) of the last forwarded stream byte, 0 when no stream has flowed yet. */
export function getLastForwardedByteAt(): number {
 return lastForwardedByteAt;
}

/** Test-only: clear the rolling window and byte timestamp. */
export function _resetSseStatsForTest(): void {
 sseOutcomes.length = 0;
 lastForwardedByteAt = 0;
}



export type MidStreamRefireReason = "truncation" | "model" | "rate_limit";
/**
 * Options for pipeUpstreamStream.
 */
export interface StreamPipeOptions {
 /**
  * Mid-stream resume hook. Invoked at most once per turn when the upstream
  * truncates (clean FIN without a terminal marker, premature socket close,
  * or a genuine stream error), emits a transient model-failure frame, or
  * emits a retriable rate-limit frame, while the client is still attached.
  * Return a replacement upstream readable to continue THIS turn on it — no
  * synthetic terminal is injected and the client response stays open.
  * Return null (or throw) to keep the existing terminate behavior: a held
  * failure frame is released, a synthetic response.incomplete/failed is
  * injected when needed, and the response is ended exactly once.
  * Client aborts and clean terminal markers never reach this hook.
  */
 refire?: (reason?: MidStreamRefireReason) => Promise<Readable | null>;
 /**
  * Content-type the upstream sent for this response, passed through verbatim.
  * A value that is present and not an SSE type (text/event-stream) switches
  * the pipe to byte-for-byte passthrough: no SSE scanner, no synthetic
  * terminal, no re-fire — a JSON answer or error page on a streaming request
  * must reach the client exactly as received. Absent, null, or empty means
  * upstream omitted it; the pipe then classifies the buffered start itself.
  */
 upstreamContentType?: string | null;
 /**
  * Per-turn tool-call audit recorder (see toolcall-audit.ts). `observe` gets
  * every forwarded SSE block that carries a tool marker — cloaked and
  * bypassed streams alike, after any rewrite; `finish` is idempotent and the
  * pipe calls it exactly once per turn (raw non-SSE bodies finish with
  * `terminal: false`). Cloak rewrites also report through its `repair`.
  */
 audit?: ToolcallStreamAudit;
}
/**
 * Pipes an upstream readable stream to a client HTTP response.
 *
 * - Flushes HTTP headers immediately for low Time-to-First-Byte (TTFB).
 * - Detects thinking/reasoning tokens in chunks for diagnostic logs.
 * - Handles upstream errors (returns 502 if headers unsent) and ends response.
 * - Cleans up resources and destroys upstream stream on client disconnect/abort.
 * - Optional per-request `cloak`: rewrites SSE events inline (placeholder
 *   strip + caller-name restore); bypassed streams flow byte-identical.
 * - Optional `opts.refire`: one silent mid-stream resume on upstream
 *   truncation (see StreamPipeOptions); without it the turn ends with a
 *   synthetic terminal event exactly as before.
 * - `opts.upstreamContentType` (see StreamPipeOptions): a non-SSE body is
 *   forwarded byte-for-byte — scanner, synthetic terminals, and re-fire only
 *   ever apply to real event streams.
 */
export function pipeUpstreamStream(
 nodeStream: Readable,
 res: http.ServerResponse,
 req: http.IncomingMessage,
 reqId?: string,
 relayUrl?: string,
 cloak?: StreamCloakOptions,
 opts?: StreamPipeOptions,
): void {
 const rid = reqId || randomUUID().slice(0, 8);
 let totalChunks = 0;
 let totalBytes = 0;
 let thinkingChunks = 0;
 let thinkingBytes = 0;
 let firstChunkAt: number | null = null;
 const startAt = Date.now();
 const isResponsesApi = req.url?.includes("/responses") ?? false;
 let hasTerminalEvent = false;
 // Abort-cause tracking: only genuine upstream-side truncation may penalize
 // relay health. Client disconnects and clean upstream ends must not.
 let upstreamEnded = false;
 let clientAborted = false;
 // Set once forwarded bytes carry a tool call (see TOOL_CALL_MARKERS): a
 // resumed turn would regenerate — and the host would re-execute — those
 // calls, so tryRefire refuses while this is set.
 let sawToolCall = false;
 // Terminal-marker scan carry: holds the tail of the previously scanned
 // view so a marker split across adjacent chunks ("[DO" | "NE]") is still
 // recognized. Longest marker is "response.completed" (18 bytes); 32
 // gives comfortable headroom.
 let terminalScanCarry = Buffer.alloc(0);
 // True while a replacement stream is being fetched: the stalled close of the
 // truncated stream must not inject a terminal or end res mid-rescue (its
 // `end` already ran; `close` always trails it on a later tick).
 let refirePending = false;
 // Streaming cloak: per-stream rewrite state (null = byte-identical passthrough).
 // The repair sink is wrapped because a throwing sink must never drop a chunk.
 const auditRepairs = opts?.audit
  ? {
    repair: (kind: string, detail?: string): void => {
     try {
      opts.audit!.repair(kind, detail);
     } catch { }
    },
   }
  : undefined;
 const cloakState = cloak && !shouldBypassStreamCloak(cloak) ? createSseStreamCloakState(auditRepairs) : null;
 // Holds the trailing incomplete SSE block across chunks; complete blocks are
 // rewritten and forwarded, so a function_call name split across chunks still
 // matches its injected record.
 let sseBuffer = "";
 // Byte-to-string join for the buffer: a multi-byte character split
 // across two TCP chunks must decode as one, never as replacement
 // characters. `end()` flushes a trailing partial sequence at stream end.
 let sseDecoder = new StringDecoder("utf8");
 // Body-kind gate. "sse" runs the event-stream pipeline; "raw" forwards bytes
 // verbatim (a non-SSE body answered on a streaming request — see
 // StreamPipeOptions.upstreamContentType); "undecided" (upstream omitted the
 // content-type) holds a bounded lookahead until SSE proves itself.
 const upstreamCt = (opts?.upstreamContentType ?? "").trim().toLowerCase();
 let bodyGate: "sse" | "raw" | "undecided" =
  upstreamCt === ""
   ? "undecided"
   : upstreamCt.includes("text/event-stream")
    ? "sse"
    : "raw";
 // Held lookahead while the gate is undecided, bounded by SNIFF_WINDOW_BYTES.
 let gateChunks: Buffer[] = [];
 let gateBytes = 0;
 // Watchdog outcome: recorded exactly once per stream. Client disconnects
 // and proxy-internal aborts set clientAborted first, so the ensure path
 // below skips them and the window only reflects upstream-side results.
 let outcomeRecorded = false;
 const recordOnce = (failed: boolean): void => {
  if (outcomeRecorded) return;
  outcomeRecorded = true;
  recordSseOutcome(failed);
 };
 // One-shot resume guard: the refire hook below fires at most once per turn.
 let refireUsed = false;
 // Tool-call audit completion: exactly one finish per turn. A normal stream
 // reports from both `end` and `close`, and a rescue hands the turn to a
 // replacement stream — the guard keeps the report single (the recorder is
 // idempotent; an external sink need not be).
 let auditFinished = false;
 const finishAudit = (terminal: boolean, unclassifiable = false): void => {
  if (auditFinished) return;
  auditFinished = true;
  // An external sink must never change what the client receives.
  try {
   opts?.audit?.finish(unclassifiable ? { terminal, unclassifiable: true } : { terminal });
  } catch { }
 };

 // Body-stall watchdog: after response headers a streaming body has no fixed
 // total deadline (See relay.ts: the per-attempt timer is headers-only).
 // The only failure left is a wedged leg that keeps the socket open
 // and sends nothing — protected by a per-stream idle cut well above every
 // observed healthy inter-chunk gap (thinking-heavy streams emit sub-second,
 // even the slowest logged TTFB is tens of seconds). On expiry the CURRENT
 // stream is destroyed with a relay-fault error so the truncation path
 // (health mark + one mid-stream refire) owns the turn. Every forwarded byte
 // re-arms it; end/close/error disarm it; a rescue re-arms the replacement.
 let stallCutTimer: NodeJS.Timeout | undefined;
 let stallCutStream: Readable | null = null;
 const fireStallCut = (target: Readable): void => {
  stallCutTimer = undefined;
  stallCutStream = null;
  if (target.destroyed || clientAborted || target !== nodeStream) return;
  const stallErr = new Error(
   `upstream body idle (no data for ${bodyStallCutMs}ms)`,
  ) as Error & { code?: string };
  stallErr.code = "FF_BODY_STALL";
  stallErr.name = "TimeoutError";
  target.destroy(stallErr);
 };
 const scheduleStallCut = (s: Readable): void => {
  clearTimeout(stallCutTimer);
  stallCutStream = s;
  const timer = setTimeout(() => fireStallCut(s), bodyStallCutMs);
  timer.unref?.();
  stallCutTimer = timer;
 };
 const breatheStallCut = (): void => {
  if (stallCutTimer !== undefined && stallCutStream === nodeStream) {
   scheduleStallCut(nodeStream);
  }
 };
 const disarmStallCut = (): void => {
  clearTimeout(stallCutTimer);
  stallCutTimer = undefined;
  stallCutStream = null;
 };

 const sniffThinking = (chunk: Buffer | string): boolean => {
  const s =
   typeof chunk === "string"
    ? chunk
    : chunk.toString("utf8", 0, Math.min(chunk.length, 4000));
  return (
   s.includes("reasoning") ||
   s.includes("thinking") ||
   s.includes("<think>") ||
   s.includes("reasoning_content") ||
   s.includes('"type":"thinking"') ||
   s.includes("thinking_delta")
  );
 };

 const checkTerminalEvent = (s: string): boolean => {
  return (
   s.includes("response.completed") ||
   s.includes("response.done") ||
   s.includes("response.failed") ||
   s.includes("response.incomplete") ||
   s.includes("[DONE]")
  );
 };
 // Held transient failure frame (raw chunk or rewritten block text):
 // withheld from the client while one silent resume is attempted. Dropped on
 // success, forwarded verbatim (as the genuine upstream verdict) when the
 // resume is vetoed, unavailable, or fails. Null outside a hold.
 let heldFailureChunk: string | Buffer | null = null;
 let heldFailureReason: "model" | "rate_limit" = "model";
 /**
  * Hold an upstream-issued transient failure frame for one silent resume on
  * a sibling relay. Returns true when held (caller must NOT forward the
  * frame); false keeps the existing terminate behavior. Tool turns always
  * veto: a regenerated turn would re-execute forwarded calls.
  */
 const holdFailureForRefire = (
  chunk: string | Buffer,
  reason: "model" | "rate_limit",
 ): boolean => {
  if (refirePending || heldFailureChunk !== null || sawToolCall) {
   // Audit: the only veto worth recording is the tool-turn one — a resume
   // would regenerate calls the host already received.
   if (sawToolCall) opts?.audit?.refireSkipped();
   return false;
  }
  if (clientAborted || refireUsed || !opts?.refire || res.writableEnded || res.destroyed) return false;
  refireUsed = true;
  refirePending = true;
  heldFailureChunk = chunk;
  heldFailureReason = reason;
  if (reason === "rate_limit") {
   midStreamRateLimitFaults += 1;
   log(
    "info",
    "upstream rate-limited this turn mid-stream — retrying once on the next relay",
    { totalChunks, totalBytes },
    rid,
   );
  } else {
   midStreamModelFaults += 1;
   log(
    "warn",
    "upstream model failed this turn mid-stream (model fault) — retrying once on the next relay",
    { totalChunks, totalBytes },
    rid,
   );
  }
  void rescueHeldFailure(heldFailureReason);
  return true;
 };
 /**
  * Deliver a held failure frame after the resume failed: the same
  * scan/mark/forward as a normal chunk, minus any further hold (the
  * one-resume budget is spent). Never penalizes relay health — the failure
  * is an upstream model verdict, not a relay fault.
  */
 const releaseHeldFailure = (): void => {
  const held = heldFailureChunk;
  heldFailureChunk = null;
  if (held === null || res.writableEnded) return;
  const buf = typeof held === "string" ? Buffer.from(held, "utf8") : held;
  const scanBuf =
   terminalScanCarry.length > 0
    ? Buffer.concat([terminalScanCarry, buf])
    : buf;
  const scanned = scanBuf.toString("utf8");
  if (!hasTerminalEvent && checkTerminalEvent(scanned)) hasTerminalEvent = true;
  if (!sawToolCall && TOOL_CALL_MARKERS.some((m) => scanned.includes(m))) sawToolCall = true;
  terminalScanCarry = Buffer.from(scanBuf.subarray(Math.max(0, scanBuf.length - 32)));
  try {
   res.write(held);
   const maybeFlush = res as unknown as { flush?: () => void };
   if (typeof maybeFlush.flush === "function") maybeFlush.flush();
  } catch { }
 };
 /**
  * Resume a held transient-failure turn on the replacement stream from
  * opts.refire (rotation marking lives there, shared with the truncation
  * path). Success drops the held frame; the stale cut stream's later
  * events are neutered by the generation check in watch().
  */
 const rescueHeldFailure = async (reason: "model" | "rate_limit"): Promise<void> => {
  const refire = opts?.refire;
  let next: Readable | null = null;
  try {
   next = refire ? await refire(reason) : null;
  } catch {
   next = null;
  }
  refirePending = false;
  if (!next || next.destroyed || clientAborted || res.writableEnded || res.destroyed) {
   try {
    next?.destroy();
   } catch { }
   releaseHeldFailure();
   // The cut stream's FIN/close may already have been consumed while the
   // rescue was in flight (both handlers return early on refirePending), so
   // nothing else will terminate this response. A held terminal frame sets
   // hasTerminalEvent in releaseHeldFailure; a non-terminal chat/error frame
   // still gets the synthetic terminal before the socket closes.
   if (!hasTerminalEvent) {
    ensureTerminalEvent(false, "mid-stream rescue failed", false, true);
   }
   try {
    if (!res.writableEnded) res.end();
   } catch { }
   // The cut stream's own end/close may already have passed while this
   // rescue was in flight, so completion is reported here instead (idempotent
   // across the later close).
   finishAudit(hasTerminalEvent);
   return;
  }
  heldFailureChunk = null;
  const cut = nodeStream;
  upstreamEnded = false;
  nodeStream = next;
  sseBuffer = "";
  sseDecoder = new StringDecoder("utf8");
  terminalScanCarry = Buffer.alloc(0);
  watch(next);
  scheduleStallCut(next);
  try {
   if (!cut.destroyed) cut.destroy();
  } catch { }
  log(
   "debug",
   `mid-stream ${reason === "rate_limit" ? "rate-limit" : "model-fault"} refire: continuing turn on replacement stream`,
   { totalChunks, totalBytes },
   rid,
  );
 };
 /**
  * Write one payload to the client with the shared backpressure/flush
  * handling, so the SSE and raw paths keep identical delivery guarantees.
  */
 const deliver = (data: string | Buffer): void => {
  const canContinue = res.write(data);
  if (canContinue === false && !nodeStream.destroyed) {
   nodeStream.pause();
   const onDrain = () => {
    res.off("drain", onDrain);
    if (!nodeStream.destroyed) nodeStream.resume();
   };
   res.once("drain", onDrain);
  }
  const maybeFlush = res as unknown as { flush?: () => void };
  if (typeof maybeFlush.flush === "function") {
   maybeFlush.flush();
  }
 };
 /**
  * Verbatim passthrough for a non-SSE body: the exact bytes upstream sent —
  * no scanner, no synthetic terminal, no re-fire (a complete document, not an
  * event stream).
  */
 const forwardRaw = (chunk: Buffer): void => {
  lastForwardedByteAt = Date.now();
  deliver(chunk);
 };
 /** Release the held lookahead into the raw path and close the gate. */
 const flushGateRaw = (): void => {
  const held = gateChunks;
  gateChunks = [];
  gateBytes = 0;
  for (const buffered of held) forwardRaw(buffered);
 };
 /**
  * Forward one rewritten SSE block: terminal-marker scan plus the shared
  * backpressure/flush handling, so cloaked streams keep the raw path's
  * delivery guarantees.
  */
 const forwardText = (text: string): void => {
  // A hold/refire can start inside a multi-block chunk; the cut stream's
  // remaining blocks must not interleave with the replacement turn.
  if (refirePending) return;
  const buf = Buffer.from(text, "utf8");
  const scanBuf =
   terminalScanCarry.length > 0
    ? Buffer.concat([terminalScanCarry, buf])
    : buf;
  const scanned = scanBuf.toString("utf8");
  if (!sawToolCall && TOOL_CALL_MARKERS.some((m) => scanned.includes(m))) sawToolCall = true;
  // A 429-shaped frame is a per-egress rate limit: hold it for one silent
  // resume on a sibling relay before the client ever sees a rate-limit error.
  // Classify the CURRENT complete block, not the terminal scan carry: the
  // carry may splice a previous block's "error" key into this one.
  // Tool turns, a spent resume budget, or a hard verdict keep it terminal.
  if (!hasTerminalEvent && isRetriableRateLimitFrame(text) && holdFailureForRefire(text, "rate_limit")) {
   return;
  }
  if (!hasTerminalEvent && checkTerminalEvent(scanned)) {
   // Upstream-issued transient model failure on a text-only turn: hold the
   // frame for one silent resume instead of terminating (tool turns veto
   // inside holdFailureForRefire and keep the terminal below).
   if (isTransientModelFailureFrame(scanned) && holdFailureForRefire(text, "model")) return;
   hasTerminalEvent = true;
  }
  terminalScanCarry = Buffer.from(scanBuf.subarray(Math.max(0, scanBuf.length - 32)));
  // Per-turn tool-call audit: hand over the EXACT forwarded bytes of any block
  // that carries a tool call (chat deltas, responses items, messages
  // tool_use + argument fragments) or a populated turn-end marker (so a tool
  // turn that ended in plain text records its finish reason). The recorder
  // parses the block itself, so plain text/reasoning blocks are never copied.
  // Dropped blocks returned before this point and are therefore never observed.
  if (opts?.audit !== undefined && AUDIT_MARKERS.some((m) => text.includes(m))) {
   try {
    opts.audit.observe(text);
   } catch { }
  }
  deliver(text);
 };
 const sseBoundary = /\r?\n\r?\n/;
 const ensureTerminalEvent = (
  isError = false,
  errorMsg?: string,
  penalizeRelay = true,
  // Watchdog-window verdict for this stream. Defaults to the relay-health
  // verdict; the marker-less FIN below overrides it: that truncation is
  // exactly what the failed-SSE window exists to catch, so it must count as a
  // failure even though a clean endpoint (not a relay fault) produced it.
  recordFailed = penalizeRelay || isError,
 ) => {
  if (hasTerminalEvent || res.writableEnded) return;
  if (!clientAborted) recordOnce(recordFailed);
  // Only genuine upstream-side truncation penalizes relay health.
  // Client disconnects and clean upstream ends leave it untouched.
  if (penalizeRelay && relayUrl && relayUrl !== "direct") {
   // Relay-fault side of the mid-stream split (model faults never reach here).
   midStreamRelayTruncations += 1;
   markRelayFailure(relayUrl, 0, errorMsg || "stream truncated prematurely");
  }
  if (isResponsesApi && totalChunks > 0) {
   try {
    if (isError) {
     res.write(
      `\n\nevent: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"stream_error","message":${JSON.stringify(errorMsg || "Upstream stream disconnected unexpectedly")}}}}\n\n`,
     );
    } else {
     res.write(
      `\n\nevent: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"cancelled"}}}\n\n`,
     );
    }
    hasTerminalEvent = true;
    log(
     "warn",
     `injected synthetic response.${isError ? "failed" : "incomplete"} for prematurely truncated stream`,
     { totalChunks, totalBytes, isError, errorMsg },
     rid,
    );
   } catch { }
  } else if (!isResponsesApi && totalChunks > 0) {
   try {
    res.write("\n\ndata: [DONE]\n\n");
    hasTerminalEvent = true;
   } catch { }
  }
 };
 /**
  * One silent mid-stream resume. When the upstream truncates with the client
  * still attached, asks the proxy (via opts.refire) for a replacement stream
  * and continues THIS turn on it — no synthetic terminal, res stays open.
  * Returns true when the turn continues; false keeps the existing
  * terminate-with-synthetic-terminal behavior at the call site. At most one
  * resume per turn; the proxy additionally budgets re-fires, so a dying pool
  * degrades to one synthetic terminal instead of a retry storm.
  */
 const tryRefire = async (): Promise<boolean> => {
  if (clientAborted || refireUsed || !opts?.refire) return false;
  if (sawToolCall) {
   // Audit: the resume budget was not spent because the turn already
   // forwarded tool calls (a regeneration would duplicate them).
   try {
    opts?.audit?.refireSkipped();
   } catch { }
   log("debug", "mid-stream refire skipped: turn already forwarded tool calls", { totalChunks, totalBytes }, rid);
   return false;
  }
  if (res.writableEnded || res.destroyed) return false;
  refireUsed = true;
  refirePending = true;
  let next: Readable | null = null;
  try {
   next = await opts.refire("truncation");
  } catch {
   next = null;
  }
  refirePending = false;
  if (!next || next.destroyed || clientAborted || res.writableEnded || res.destroyed) {
   try {
    next?.destroy();
   } catch { }
   return false;
  }
  upstreamEnded = false;
  nodeStream = next;
  sseBuffer = "";
  sseDecoder = new StringDecoder("utf8");
  terminalScanCarry = Buffer.alloc(0);
  watch(next);
  scheduleStallCut(next);
  log("debug", "mid-stream refire: continuing turn on replacement stream", { totalChunks, totalBytes }, rid);
  return true;
 };

 try {
  if (typeof res.flushHeaders === "function") {
   res.flushHeaders();
  }
 } catch { }
 /**
  * SSE pipeline for one received chunk: thinking sniff plus the
  * double-newline block scanner. Only reached once the body is known to be
  * an event stream (upstream content-type, or sniffed `data:`/`event:`
  * evidence).
  */
 const processSseChunk = (chunk: Buffer | string): void => {
  const chunkSize =
   typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
  if (sniffThinking(chunk)) {
   thinkingChunks++;
   thinkingBytes += chunkSize;
   if (isDebugEnabled() && thinkingChunks <= 3) {
    const preview =
     typeof chunk === "string"
      ? chunk.slice(0, 600)
      : chunk.toString("utf8", 0, 600);
    log(
     "debug",
     `thinking chunk #${thinkingChunks}`,
     { preview: preview.slice(0, 400) },
     rid,
    );
   }
  }
  // Buffer across chunks into complete SSE blocks delimited by double-newline.
  // Forwarding only complete blocks guarantees that network chunk boundaries
  // never split JSON strings on the wire or leave unterminated syntax when
  // mid-stream refire or truncation occurs.
  sseBuffer += typeof chunk === "string" ? chunk : sseDecoder.write(chunk);
  let boundary = sseBoundary.exec(sseBuffer);
  while (boundary) {
   const block = sseBuffer.slice(0, boundary.index);
   sseBuffer = sseBuffer.slice(boundary.index + boundary[0].length);
   if (cloakState && cloak) {
    const rewritten = rewriteSseBlock(block, cloakState, cloak);
    if (rewritten !== null) forwardText(`${rewritten}\n\n`);
   } else {
    forwardText(`${block}\n\n`);
   }
   boundary = sseBoundary.exec(sseBuffer);
  }
 };
 const onData = (chunk: Buffer | string): void => {
  try {
   breatheStallCut();
   // While a replacement stream is being fetched the cut stream is stale:
   // its late frames must not interleave with the rescued turn.
   if (refirePending) return;
   if (firstChunkAt === null) {
    firstChunkAt = Date.now();
    const ttfb = firstChunkAt - startAt;
    log("debug", `stream first chunk in ${ttfb}ms`, undefined, rid);
   }
   totalChunks++;
   const chunkSize =
    typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
   totalBytes += chunkSize;
   lastForwardedByteAt = Date.now();

   if (bodyGate === "undecided") {
    // Upstream sent no content-type: classify the body from its start. SSE
    // evidence switches to the normal pipeline and replays the held
    // lookahead into it; the bounded window filling with no evidence
    // classifies the body as raw passthrough.
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    gateChunks.push(buf);
    gateBytes += buf.length;
    const isSse = looksLikeSse(Buffer.concat(gateChunks, gateBytes).toString("utf8"));
    if (!isSse && gateBytes < SNIFF_WINDOW_BYTES) return;
    if (!isSse) {
     bodyGate = "raw";
     flushGateRaw();
     return;
    }
    bodyGate = "sse";
    const held = gateChunks;
    gateChunks = [];
    gateBytes = 0;
    for (const buffered of held) processSseChunk(buffered);
    return;
   }
   if (bodyGate === "raw") {
    forwardRaw(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    return;
   }
   processSseChunk(chunk);
  } catch { }
 };

 const onError = async (e: unknown): Promise<void> => {
  disarmStallCut();
  // A rescue is already in flight (its outcome decides the turn): a late
  // error from the cut stream must not inject a terminal mid-rescue.
  if (refirePending) return;
  const errorMsg = (e as Error)?.message || String(e);
  // An abort (client disconnect or a proxy-internal header timeout marked
  // FF_INTERNAL_ABORT) is not a relay fault — never penalize relay health,
  // and behave like a client abort for the terminal marker. Only genuine
  // upstream-side failures (socket errors, truncation) penalize.
  // Stream errors are always Error subclasses (node/undici).
  const streamErr = e as Error & { code?: string };
  const isInternalAbort =
   streamErr?.name === "AbortError" || streamErr?.code === "FF_INTERNAL_ABORT";
  log(
   isInternalAbort ? "warn" : "error",
   isInternalAbort
    ? "upstream stream aborted (internal cancel/timeout)"
    : "upstream stream error",
   { error: errorMsg, totalChunks, thinkingChunks, hasTerminalEvent },
   rid,
  );
  try {
   if (!res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
   } else if (bodyGate !== "sse") {
    // Non-SSE passthrough: no event-stream contract to terminate — release
    // the held lookahead and end without a synthetic terminal. A genuine
    // upstream-side failure still marks the relay exactly like the SSE
    // truncation path, so health keeps attributing cut streams.
    flushGateRaw();
    if (!isInternalAbort && relayUrl && relayUrl !== "direct") {
     midStreamRelayTruncations += 1;
     markRelayFailure(relayUrl, 0, errorMsg || "stream failed mid-body");
    }
   } else if (isInternalAbort) {
    clientAborted = true;
    sseBuffer = "";
    terminalScanCarry = Buffer.alloc(0);
    ensureTerminalEvent(false, errorMsg || "stream interrupted", false);
   } else {
    if (await tryRefire()) return;
    if (cloakState && cloak) {
     const flushed = flushBufferedToolArgs(cloakState, cloak);
     if (flushed !== null) forwardText(flushed);
    }
    sseBuffer = "";
    terminalScanCarry = Buffer.alloc(0);
    ensureTerminalEvent(!isSubstantial(totalChunks, totalBytes), errorMsg, true);
   }
   if (!res.writableEnded) {
    res.end();
   }
   // Audit completion: no terminal SSE event was forwarded on this path (or
   // one was, before the error); a rescue returned above and owns the report.
   finishAudit(hasTerminalEvent);
  } catch { }
 };

 const onEnd = async (): Promise<void> => {
  disarmStallCut();
  // A rescue is in flight (its outcome owns the turn): the cut stream's FIN
  // must neither inject a terminal nor end res mid-rescue.
  if (refirePending) return;
  upstreamEnded = true;
  if (bodyGate !== "sse") {
   // Non-SSE passthrough ("undecided" here means upstream sent no
   // content-type and no SSE field line ever appeared): the held lookahead
   // is the tail of a complete non-SSE body — flush it verbatim, then end.
   // No synthetic terminal, no re-fire, no watchdog sample: this was never
   // an event stream.
   try {
    flushGateRaw();
   } catch { }
   try {
    if (!res.writableEnded) res.end();
   } catch { }
   // Audit: a raw (non-SSE) body carries no event stream to inspect, so the
   // turn is not classifiable: the summary says `remap: "unknown"` rather
   // than accusing the model of answering without tools.
   finishAudit(false, true);
   log(
    "debug",
    `non-SSE upstream body passed through verbatim — ${totalChunks} chunks (${(totalBytes / 1024).toFixed(1)}KB)`,
    undefined,
    rid,
   );
   return;
  }
  // The final chunk may end mid-character: only the decoder knows whether
  // bytes are still pending, and those bytes are part of the last block.
  sseBuffer += sseDecoder.end();
  // Cloaked streams hold the trailing incomplete block: flush it (rewritten)
  // ahead of the terminal-marker check so a coalesced final event still counts.
  if (sseBuffer.trim() !== "") {
   const tail = sseBuffer;
   sseBuffer = "";
   const isCutTerminal =
    (tail.includes("response.completed") ||
     tail.includes("response.incomplete") ||
     tail.includes("response.failed")) &&
    !endsOnFinishedSseLine(tail);
   if (!isCutTerminal && checkTerminalEvent(tail)) {
    if (cloakState && cloak) {
     const rewritten = rewriteSseBlock(tail, cloakState, cloak);
     if (rewritten !== null) forwardText(`${rewritten}\n\n`);
    } else {
     forwardText(tail.endsWith("\n") ? `${tail}\n` : `${tail}\n\n`);
    }
   } else if (endsOnFinishedSseLine(tail)) {
    // A complete final event that merely lost its trailing blank line: forward
    // it, framed as a finished block, so neither the synthetic terminal below
    // nor a re-fire's replacement bytes can splice onto its last line. A
    // genuinely partial block was refused above and stays dropped.
    if (cloakState && cloak) {
     const rewritten = rewriteSseBlock(tail, cloakState, cloak);
     if (rewritten !== null) forwardText(`${rewritten}\n\n`);
    } else {
     forwardText(tail.endsWith("\n") ? `${tail}\n` : `${tail}\n\n`);
    }
   }
  }
 // Buffered tool arguments are released on the call's terminal event, which a
 // cut stream never sends. Flush them here: the client already saw the call
 // announced, so it must receive the arguments too rather than a name with no
 // payload. Runs before the terminal-marker decision and before the re-fire
 // offer, because a rescue regenerates the turn and would double the calls.
 if (cloakState && cloak) {
  const flushed = flushBufferedToolArgs(cloakState, cloak);
  if (flushed !== null) forwardText(flushed);
 }
  // A tail-framed failure frame may have started a hold during the flush
  // above; the rescue owns the turn now. Do not inject a terminal or end.
  if (refirePending || heldFailureChunk !== null) return;
  if (hasTerminalEvent) recordOnce(false);
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  if (!hasTerminalEvent && totalChunks > 0) {
   // Upstream FIN without a terminal marker: offer the proxy one silent
   // re-fire on a sibling relay before falling back to the synthetic
   // terminal below. A resumed turn keeps streaming into the same client
   // response; the final outcome is logged when that stream ends.
   if (await tryRefire()) return;
   // A FIN with no terminal marker is the truncation the failed-SSE window
   // exists to catch, so the watchdog counts it as a failure (the relay is
   // still never blamed — the endpoint completed the connection cleanly, it
   // just never said the turn was done). Keep the host contract with a
   // synthetic terminal.
   ensureTerminalEvent(
    false,
    "upstream ended without terminal marker",
    false,
    true,
   );
  }
  if (thinkingChunks > 0) {
   log(
    "info",
    `stream ended in ${elapsed}s — ${totalChunks} chunks (${(totalBytes / 1024).toFixed(1)}KB), thinking: ${thinkingChunks} chunks (${(thinkingBytes / 1024).toFixed(1)}KB)`,
    undefined,
    rid,
   );
  } else if (isDebugEnabled()) {
   log(
    "debug",
    `stream ended in ${elapsed}s — ${totalChunks} chunks (${(totalBytes / 1024).toFixed(1)}KB), no thinking detected`,
    undefined,
    rid,
   );
  }
  try {
   if (!res.writableEnded) res.end();
  } catch { }
  // Audit completion for the turn (idempotent; `close` trails this call).
  finishAudit(hasTerminalEvent);
 };

 const onClose = async (): Promise<void> => {
  disarmStallCut();
  // A stalled `close` trailing an `end` that is mid-rescue must neither
  // inject a terminal nor end res — the replacement stream owns the turn now.
  if (refirePending) return;
  try {
  // Same obligation as the clean-end flush: the client already saw the call
  // announced, so its buffered arguments must still arrive before the turn is
  // terminated — and before the re-fire offer, since a rescue regenerates the
  // turn and would double the calls.
  if (cloakState && cloak) {
   const flushed = flushBufferedToolArgs(cloakState, cloak);
   if (flushed !== null) forwardText(flushed);
  }
   // A tail-framed failure frame may have started a hold during the flush
   // above; the rescue owns the turn now.
   if (refirePending || heldFailureChunk !== null) return;
   if (bodyGate !== "sse") {
    // Non-SSE passthrough: same relay-fault accounting as the SSE path's
    // mid-body close (a genuine upstream socket death, not a client
    // disconnect), but no terminal is owed on raw bytes.
    flushGateRaw();
    if (!clientAborted && !upstreamEnded && relayUrl && relayUrl !== "direct") {
     midStreamRelayTruncations += 1;
     markRelayFailure(relayUrl, 0, "stream closed prematurely");
    }
   } else if (!hasTerminalEvent && totalChunks > 0) {
    if (clientAborted || upstreamEnded) {
     // Client disconnect teardown or post-end cleanup — the relay
     // is not at fault; still give the host a terminal event. The
     // watchdog verdict is a failure either way: a clean FIN with no
     // terminal marker is the truncation the failed-SSE window catches
     // (and a real client abort is skipped inside ensureTerminalEvent).
     sseBuffer = "";
     terminalScanCarry = Buffer.alloc(0);
     ensureTerminalEvent(false, "stream interrupted by client", false, true);
    } else {
     // Same offer as the clean-end path above: one silent re-fire before
     // marking this relay and terminating the turn.
     if (await tryRefire()) return;
     sseBuffer = "";
     terminalScanCarry = Buffer.alloc(0);
     // Upstream socket died mid-stream with no error event.
     // For muse-spark large payloads: raxtant 514KB failed but feoni 802KB
     // succeeded with same 2.6MB in — so this is edge-specific, not pure
     // provider token limit. Keep penalize=true to rotate failing relay,
     // but inject incomplete (not failed) for substantial to avoid alarming
     // stream_error. Small premature (<50 chunks) stays failed+penalize.
     ensureTerminalEvent(!isSubstantial(totalChunks, totalBytes), "stream closed prematurely", true);
    }
   }
   if (!res.writableEnded) res.end();
   // Audit completion: `end` normally already reported (the guard makes this
   // a no-op then); a socket death or rescue teardown reports from here. Raw
   // (non-SSE) bodies carry no event stream, so they are never terminal and
   // never classifiable (`remap: "unknown"`).
   finishAudit(bodyGate === "sse" && hasTerminalEvent, bodyGate !== "sse");
  } catch { }
 };
 const watch = (s: Readable): void => {
  // Generation check: after a rescue swaps nodeStream, the cut stream's
  // late events are stale and must not touch the rescued turn.
  s.on("data", (c) => { if (s === nodeStream) onData(c); });
  s.on("error", (e) => { if (s === nodeStream) void onError(e); });
  s.on("end", () => { if (s === nodeStream) void onEnd(); });
  s.on("close", () => { if (s === nodeStream) void onClose(); });
 };
 watch(nodeStream);
 scheduleStallCut(nodeStream);

 req.on("aborted", () => {
  clientAborted = true;
  log("warn", "client aborted — destroying upstream", { totalChunks }, rid);
  if (!nodeStream.destroyed) nodeStream.destroy();
 });

 req.on("close", () => {
  if ((!upstreamEnded || refirePending) && !nodeStream.destroyed) {
   clientAborted = true;
   nodeStream.destroy();
  }
 });

 res.on("close", () => {
  if (
   (!upstreamEnded || refirePending) &&
   !res.writableEnded &&
   !nodeStream.destroyed
  ) {
   clientAborted = true;
   nodeStream.destroy();
  }
 });

 res.on("error", () => {
  if ((!upstreamEnded || refirePending) && !nodeStream.destroyed) {
   clientAborted = true;
   nodeStream.destroy();
  }
 });
}
