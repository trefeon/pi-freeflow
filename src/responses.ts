/**
 * Responses-API reasoning portability.
 *
 * Reasoning items can carry an opaque `encrypted_content` blob. Upstream binds
 * each blob to the caller that issued it, and that caller is upstream-internal.
 * Measured, not inferred: on 2026-09-13 the same relay returned 200 at
 * 06:28:11 and 400 at 06:28:12 (and 200 again one second later), the identical
 * 400 also came back on the relay-bypassed direct path at 06:28:58, and a 45s
 * burst hit ten different conversations before all requests went back to 200.
 * A blob issued by one upstream service instance is unreadable to another, so
 * neither the relay nor the client egress explains the rejection.
 *
 * When it happens the host re-sends the same rejected history until the session
 * dies, because the rejection is a 400 (never retried by the relay pool) and
 * nothing in the host learns which items poisoned the request.
 *
 * Recovery, daemon-side: on that exact 400, retry once with every blob stripped
 * (messages, item ids, tool calls and `include` all survive; verified live), then
 * remember the hashes of the blobs that were present. Later turns strip only
 * those rejected blobs, so blobs the current instance issued keep flowing and
 * the conversation keeps its recent reasoning.
 */

import { createHash } from "node:crypto";

/** Upstream rejection for a reasoning blob issued to a different caller. */
const CALLER_MISMATCH_PATTERN =
 /encrypted_content[\s\S]{0,32}?was not issued to this caller/i;

/** Upstream rejection for a reasoning reference that aged out server-side. */
const EXPIRED_REASONING_PATTERN =
 /referenced reasoning item[\s\S]{0,256}?was not found or has expired/i;

/** Reasoning reference ids (`rs_...`; colon-joined pairs yield two tokens). */
const REASONING_ID_PATTERN = /rs_[A-Za-z0-9_]+/g;

/** Marker field on reasoning items. */
const ENCRYPTED_CONTENT = "encrypted_content";

/** How long a conversation remembers its rejected blobs. */
const REJECTED_TTL_MS = 12 * 60 * 60 * 1_000;
/** Conversations tracked before the oldest entry is dropped. */
const MAX_TRACKED_CONVERSATIONS = 1_024;
/** Rejected blob hashes kept per conversation before the oldest are dropped. */
const MAX_REJECTED_BLOBS_PER_CONVERSATION = 4_096;
/** Hash length kept per blob; a collision only strips one extra item. */
const HASH_LENGTH = 32;

/** How long a conversation remembers which path issued its reasoning. */
const ISSUER_TTL_MS = 12 * 60 * 60 * 1_000;
/** Conversations with issuer affinity tracked before the oldest is dropped. */
const MAX_TRACKED_ISSUERS = 1_024;

/** Conversation -> the relay (or direct path) that served its last success. */
const issuerByConversation = new Map<string, { relay: string | null; expiresAt: number }>();

interface RejectedReasoning {
 hashes: Set<string>;
 expiresAt: number;
}

const rejectedByConversation = new Map<string, RejectedReasoning>();

interface RejectedReasoningIds {
 ids: Set<string>;
 expiresAt: number;
}

const rejectedIdsByConversation = new Map<string, RejectedReasoningIds>();

/** True when the upstream error text names the caller-bound reasoning blob. */
export function isReasoningCallerMismatch(errorText: string): boolean {
 return CALLER_MISMATCH_PATTERN.test(errorText);
}

/** True when the upstream error text names an expired reasoning reference. */
export function isExpiredReasoningReference(errorText: string): boolean {
 return EXPIRED_REASONING_PATTERN.test(errorText);
}

/** Every `rs_...` token named by an expired-reference error. */
export function extractExpiredReasoningIds(errorText: string): string[] {
 return errorText.match(REASONING_ID_PATTERN) ?? [];
}

/**
 * Conversation identity for responses requests. The host sends a stable
 * `prompt_cache_key` per conversation; without one the rejected blobs cannot be
 * remembered, and each burst costs one extra round trip instead of one total.
 */
export function responsesConversationKey(body: unknown): string | null {
 if (typeof body !== "object" || body === null) return null;
 const key = (body as Record<string, unknown>).prompt_cache_key;
 return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Record which path served this conversation's last successful response, so the
 * next turn can stay there (affinity) instead of re-sending reasoning the new
 * backend cannot read. `null` means the direct path, which is a different
 * backend from any relay.
 */
export function rememberIssuerRelay(conversationKey: string, relay: string | null): void {
 pruneReasoningState();
 if (
  !issuerByConversation.has(conversationKey) &&
  issuerByConversation.size >= MAX_TRACKED_ISSUERS
 ) {
  const oldest = issuerByConversation.keys().next();
  if (!oldest.done) issuerByConversation.delete(oldest.value);
 }
 issuerByConversation.set(conversationKey, {
  relay,
  expiresAt: Date.now() + ISSUER_TTL_MS,
 });
}

/**
 * Where this conversation's reasoning came from: a relay URL, `null` for the
 * direct path, or `undefined` when nothing is known (new conversation, or the
 * record expired), in which case nothing can be replayed incompatibly.
 */
export function issuerRelayFor(conversationKey: string): string | null | undefined {
 const entry = issuerByConversation.get(conversationKey);
 if (!entry) return undefined;
 if (entry.expiresAt <= Date.now()) {
  issuerByConversation.delete(conversationKey);
  return undefined;
 }
 return entry.relay;
}

/** Hash of one encrypted blob, used to recognize a rejected item on replay. */
function blobHash(blob: string): string {
 return createHash("sha256").update(blob, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/** Parse a request body, returning its input array when it has one to rewrite. */
function parseInput(raw: Buffer): { body: Record<string, unknown>; input: unknown[] } | null {
 const text = raw.toString("utf8");
 // Cheap gate: most requests carry no encrypted reasoning at all.
 if (!text.includes(ENCRYPTED_CONTENT)) return null;
 let body: unknown;
 try {
  body = JSON.parse(text);
 } catch {
  return null;
 }
 if (typeof body !== "object" || body === null) return null;
 const record = body as Record<string, unknown>;
 if (!Array.isArray(record.input)) return null;
 return { body: record, input: record.input };
}

/** Parse a request body without the blob gate: expired-reference bodies carry no `encrypted_content`. */
function parseReasoningBody(raw: Buffer): { body: Record<string, unknown>; input: unknown[] } | null {
 let body: unknown;
 try {
  body = JSON.parse(raw.toString("utf8"));
 } catch {
  return null;
 }
 if (typeof body !== "object" || body === null) return null;
 const record = body as Record<string, unknown>;
 if (!Array.isArray(record.input)) return null;
 return { body: record, input: record.input };
}

/**
 * Remove every caller-bound reasoning blob, leaving all other fields untouched
 * (item ids, summaries, tool calls, `include`). Used for the one-shot retry of a
 * rejected request, where the offending blob cannot be identified. Returns null
 * when the body carries nothing to strip.
 */
export function stripReasoningEncryption(raw: Buffer): Buffer | null {
 const parsed = parseInput(raw);
 if (!parsed) return null;
 let stripped = 0;
 for (const item of parsed.input) {
  if (typeof item !== "object" || item === null) continue;
  const record = item as Record<string, unknown>;
  if (typeof record[ENCRYPTED_CONTENT] !== "string") continue;
  delete record[ENCRYPTED_CONTENT];
  stripped += 1;
 }
 if (stripped === 0) return null;
 return Buffer.from(JSON.stringify(parsed.body), "utf8");
}

/**
 * Drop the server-side chain pointer a new backend cannot resolve. Returns
 * null when the body carries no pointer.
 */
export function stripPreviousResponseId(raw: Buffer): Buffer | null {
 let body: unknown;
 try {
  body = JSON.parse(raw.toString("utf8"));
 } catch {
  return null;
 }
 if (typeof body !== "object" || body === null) return null;
 const record = body as Record<string, unknown>;
 if (!("previous_response_id" in record)) return null;
 delete record.previous_response_id;
 return Buffer.from(JSON.stringify(record), "utf8");
}

/**
 * Drop every reasoning item plus the chain pointer: the poisoned history
 * cannot be resolved server-side, so one turn of reasoning context is lost
 * instead of failing the whole request. Returns null when nothing to drop.
 */
export function stripUnresolvableReasoning(raw: Buffer): Buffer | null {
 const parsed = parseReasoningBody(raw);
 if (!parsed) return stripPreviousResponseId(raw);
 const kept: unknown[] = [];
 let stripped = 0;
 for (const item of parsed.input) {
  if (typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "reasoning") {
   stripped += 1;
   continue;
  }
  kept.push(item);
 }
 const hadPointer = "previous_response_id" in parsed.body;
 if (stripped === 0 && !hadPointer) return null;
 if (stripped > 0) parsed.body.input = kept;
 if (hadPointer) delete parsed.body.previous_response_id;
 return Buffer.from(JSON.stringify(parsed.body), "utf8");
}

/**
 * Make a Zen responses body safe to serve from Kilo after failover: drop
 * the server-side chain pointer Kilo cannot resolve and every caller-bound
 * reasoning blob Kilo cannot read. Fresh sessions carry neither, so this is
 * a no-op for them; resumed histories lose cached reasoning for one turn
 * instead of failing the whole request.
 */
export function prepareResponsesFailoverBody(parsedBody: Record<string, unknown>): void {
 delete parsedBody.previous_response_id;
 const input = parsedBody.input;
 if (!Array.isArray(input)) return;
 for (const item of input) {
  if (typeof item !== "object" || item === null) continue;
  const record = item as Record<string, unknown>;
  if (typeof record[ENCRYPTED_CONTENT] !== "string") continue;
  delete record[ENCRYPTED_CONTENT];
 }
}

/**
 * Remove only the blobs this conversation already had rejected, keeping every
 * blob the current caller issued. Returns null when nothing was rejected yet or
 * no rejected blob is present on this request.
 */
export function stripRejectedReasoning(raw: Buffer, conversationKey: string | null): Buffer | null {
 if (conversationKey === null) return null;
 const rejected = rejectedByConversation.get(conversationKey);
 if (!rejected || rejected.hashes.size === 0) return null;
 if (rejected.expiresAt <= Date.now()) {
  rejectedByConversation.delete(conversationKey);
  return null;
 }
 const parsed = parseInput(raw);
 if (!parsed) return null;

 let stripped = 0;
 for (const item of parsed.input) {
  if (typeof item !== "object" || item === null) continue;
  const record = item as Record<string, unknown>;
  const blob = record[ENCRYPTED_CONTENT];
  if (typeof blob !== "string") continue;
  if (!rejected.hashes.has(blobHash(blob))) continue;
  delete record[ENCRYPTED_CONTENT];
  stripped += 1;
 }
 if (stripped === 0) return null;
 rejected.expiresAt = Date.now() + REJECTED_TTL_MS;
 return Buffer.from(JSON.stringify(parsed.body), "utf8");
}

/**
 * Remember every blob carried by a request upstream just rejected, so the next
 * turns of this conversation can drop them. Returns the number remembered.
 */
export function rememberRejectedReasoning(raw: Buffer, conversationKey: string): number {
 const parsed = parseInput(raw);
 if (!parsed) return 0;

 pruneReasoningState();
 let entry = rejectedByConversation.get(conversationKey);
 if (!entry) {
  if (rejectedByConversation.size >= MAX_TRACKED_CONVERSATIONS) {
   const oldest = rejectedByConversation.keys().next();
   if (!oldest.done) rejectedByConversation.delete(oldest.value);
  }
  entry = { hashes: new Set<string>(), expiresAt: 0 };
  rejectedByConversation.set(conversationKey, entry);
 }

 let added = 0;
 for (const item of parsed.input) {
  if (typeof item !== "object" || item === null) continue;
  const blob = (item as Record<string, unknown>)[ENCRYPTED_CONTENT];
  if (typeof blob !== "string") continue;
  entry.hashes.add(blobHash(blob));
  added += 1;
  while (entry.hashes.size > MAX_REJECTED_BLOBS_PER_CONVERSATION) {
   const oldest = entry.hashes.values().next();
   if (oldest.done) break;
   entry.hashes.delete(oldest.value);
  }
 }
 entry.expiresAt = Date.now() + REJECTED_TTL_MS;
 return added;
}

/** Number of rejected blobs remembered for a conversation (debug/test). */
export function rejectedReasoningCount(conversationKey: string): number {
 const entry = rejectedByConversation.get(conversationKey);
 if (!entry) return 0;
 if (entry.expiresAt <= Date.now()) {
  rejectedByConversation.delete(conversationKey);
  return 0;
 }
 return entry.hashes.size;
}

/**
 * Remember every reasoning id named by an expired-reference error, so the
 * next turns of this conversation can drop those items plus the chain
 * pointer. Returns the number remembered.
 */
export function rememberRejectedReasoningIds(errorText: string, conversationKey: string): number {
 const ids = extractExpiredReasoningIds(errorText);
 if (ids.length === 0) return 0;
 pruneReasoningState();
 let entry = rejectedIdsByConversation.get(conversationKey);
 if (!entry) {
  if (rejectedIdsByConversation.size >= MAX_TRACKED_CONVERSATIONS) {
   const oldest = rejectedIdsByConversation.keys().next();
   if (!oldest.done) rejectedIdsByConversation.delete(oldest.value);
  }
  entry = { ids: new Set<string>(), expiresAt: 0 };
  rejectedIdsByConversation.set(conversationKey, entry);
 }
 let added = 0;
 for (const id of ids) {
  entry.ids.add(id);
  added += 1;
  while (entry.ids.size > MAX_REJECTED_BLOBS_PER_CONVERSATION) {
   const oldest = entry.ids.values().next();
   if (oldest.done) break;
   entry.ids.delete(oldest.value);
  }
 }
 entry.expiresAt = Date.now() + REJECTED_TTL_MS;
 return added;
}

/**
 * Remove only the reasoning items this conversation already saw expire,
 * plus the chain pointer that may reference them. Returns null when nothing
 * was rejected yet or no rejected id is present on this request.
 */
export function stripRejectedReasoningIds(raw: Buffer, conversationKey: string | null): Buffer | null {
 if (conversationKey === null) return null;
 const rejected = rejectedIdsByConversation.get(conversationKey);
 if (!rejected || rejected.ids.size === 0) return null;
 if (rejected.expiresAt <= Date.now()) {
  rejectedIdsByConversation.delete(conversationKey);
  return null;
 }
 const parsed = parseReasoningBody(raw);
 if (!parsed) return null;
 const kept: unknown[] = [];
 let stripped = 0;
 for (const item of parsed.input) {
  if (typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "reasoning") {
   const id = (item as Record<string, unknown>).id;
   if (typeof id === "string" && (rejected.ids.has(id) || (id.match(REASONING_ID_PATTERN) ?? []).some((t) => rejected.ids.has(t)))) {
    stripped += 1;
    continue;
   }
  }
  kept.push(item);
 }
 if (stripped === 0) return null;
 parsed.body.input = kept;
 delete parsed.body.previous_response_id;
 rejected.expiresAt = Date.now() + REJECTED_TTL_MS;
 return Buffer.from(JSON.stringify(parsed.body), "utf8");
}

/** Number of rejected reasoning ids remembered for a conversation (debug/test). */
export function rejectedReasoningIdsCount(conversationKey: string): number {
 const entry = rejectedIdsByConversation.get(conversationKey);
 if (!entry) return 0;
 if (entry.expiresAt <= Date.now()) {
  rejectedIdsByConversation.delete(conversationKey);
  return 0;
 }
 return entry.ids.size;
}

/** Drop conversations whose rejected-blob, rejected-id or issuer memory expired. */
function pruneReasoningState(): void {
 const now = Date.now();
 for (const [key, entry] of rejectedByConversation) {
  if (entry.expiresAt <= now) rejectedByConversation.delete(key);
 }
 for (const [key, entry] of rejectedIdsByConversation) {
  if (entry.expiresAt <= now) rejectedIdsByConversation.delete(key);
 }
 for (const [key, entry] of issuerByConversation) {
  if (entry.expiresAt <= now) issuerByConversation.delete(key);
 }
}

/** Test-only: clear tracked conversations. */
export function _resetReasoningStateForTest(): void {
 rejectedByConversation.clear();
 rejectedIdsByConversation.clear();
 issuerByConversation.clear();
}
