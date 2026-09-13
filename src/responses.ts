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

/** True when the upstream error text names the caller-bound reasoning blob. */
export function isReasoningCallerMismatch(errorText: string): boolean {
	return CALLER_MISMATCH_PATTERN.test(errorText);
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

/** Drop conversations whose rejected-blob or issuer memory expired. */
function pruneReasoningState(): void {
	const now = Date.now();
	for (const [key, entry] of rejectedByConversation) {
		if (entry.expiresAt <= now) rejectedByConversation.delete(key);
	}
	for (const [key, entry] of issuerByConversation) {
		if (entry.expiresAt <= now) issuerByConversation.delete(key);
	}
}

/** Test-only: clear tracked conversations. */
export function _resetReasoningStateForTest(): void {
	rejectedByConversation.clear();
	issuerByConversation.clear();
}
