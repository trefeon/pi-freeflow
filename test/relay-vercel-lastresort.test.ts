/**
 * Vercel last-resort ordering: healthy non-Vercel relays first, Vercel as failover.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	getOrderedRelayUrls,
	markRelayFailure,
	orderedRelayCandidates,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

const VERCEL_A = "https://my-relay.vercel.app";
const VERCEL_B = "https://other-relay.vercel.app";
const CLOUDFLARE_B = "https://my-relay.workers.dev";

function setPool(urls: string[], active?: string): void {
	const state: RelayState = {
		enabled: true,
		url: active ?? urls[0],
		relays: urls.map((url) => ({ url })),
	};
	setActiveRelayState(state, false);
}

test("healthy non-Vercel relays order before healthy Vercel relays", () => {
	resetAllRelayHealth();
	setPool([VERCEL_A, CLOUDFLARE_B], VERCEL_A);
	assert.deepEqual(getOrderedRelayUrls(), [CLOUDFLARE_B, VERCEL_A]);
	resetAllRelayHealth();
});

test("affinity-preferred Vercel relay still tried first when healthy", () => {
	resetAllRelayHealth();
	setPool([VERCEL_A, CLOUDFLARE_B], CLOUDFLARE_B);
	assert.deepEqual(orderedRelayCandidates(VERCEL_A), [VERCEL_A, CLOUDFLARE_B]);
	resetAllRelayHealth();
});

test("all-Vercel pool keeps existing order", () => {
	resetAllRelayHealth();
	setPool([VERCEL_A, VERCEL_B], VERCEL_A);
	assert.deepEqual(getOrderedRelayUrls(), [VERCEL_A, VERCEL_B]);
	resetAllRelayHealth();
});

test("cooled-down relays keep the same non-Vercel-first split", () => {
	resetAllRelayHealth();
	setPool([VERCEL_A, CLOUDFLARE_B], VERCEL_A);
	markRelayFailure(VERCEL_A, 429);
	markRelayFailure(CLOUDFLARE_B, 429);
	assert.deepEqual(getOrderedRelayUrls(), [CLOUDFLARE_B, VERCEL_A]);
	resetAllRelayHealth();
});
