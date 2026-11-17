/**
 * Model-scoped quota health (issue #137): a 429 burns one upstream quota
 * bucket (`modelId[:2]`) through one relay, so the relay stays healthy for
 * every other bucket and a bucket cooldown never hides a network fault.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	clearRelayQuota,
	getRelayQuotaSnapshot,
	getRelayQuotaState,
	isRelayHealthy,
	markRelayFailure,
	markRelayQuotaFailure,
	markRelaySuccess,
	orderedRelayCandidates,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const RELAY_A = "https://quota-a.example.com";
const RELAY_B = "https://quota-b.example.com";

function pool(urls: string[]): RelayState {
	return { mode: "auto", enabled: true, url: urls[0] ?? "", relays: urls.map((url) => ({ url })) };
}

test("quota cooldown is scoped to the model bucket, not the relay", async () => {
	withIsolatedRelayFiles(() => {
		resetAllRelayHealth();
		try {
			markRelayQuotaFailure(RELAY_A, "de");
			assert.equal(isRelayHealthy(RELAY_A, "de"), false, "exhausted bucket parks that bucket");
			assert.equal(isRelayHealthy(RELAY_A, "ne"), true, "another bucket still uses the same egress");
			assert.equal(isRelayHealthy(RELAY_A), true, "relay network health is untouched");
			const quota = getRelayQuotaState(RELAY_A, "de");
			assert.equal(quota?.bucket, "de");
			assert.ok((quota?.cooldownUntil ?? 0) > Date.now());
			assert.equal(getRelayQuotaSnapshot().length, 1);
		} finally {
			resetAllRelayHealth();
		}
	});
});

test("a success in one bucket clears only that bucket", async () => {
	withIsolatedRelayFiles(() => {
		resetAllRelayHealth();
		try {
			markRelayQuotaFailure(RELAY_A, "de");
			markRelayQuotaFailure(RELAY_A, "ne");
			markRelaySuccess(RELAY_A, 120, "de");
			assert.equal(getRelayQuotaState(RELAY_A, "de"), undefined, "served bucket clears");
			assert.ok(getRelayQuotaState(RELAY_A, "ne"), "untouched bucket keeps its cooldown");
			clearRelayQuota(RELAY_A, "ne");
			assert.equal(getRelayQuotaState(RELAY_A, "ne"), undefined);
		} finally {
			resetAllRelayHealth();
		}
	});
});

test("network failure stays relay-wide while a quota failure stays bucket-scoped", async () => {
	withIsolatedRelayFiles(() => {
		resetAllRelayHealth();
		try {
			markRelayFailure(RELAY_A, 0, "socket hang up");
			assert.equal(isRelayHealthy(RELAY_A, "de"), false, "a dead endpoint is unhealthy for every bucket");
			assert.equal(isRelayHealthy(RELAY_A, "ne"), false);
			assert.equal(isRelayHealthy(RELAY_B, "de"), true);
		} finally {
			resetAllRelayHealth();
		}
	});
});

test("candidate ordering demotes only the exhausted bucket", async () => {
	withIsolatedRelayFiles(() => {
		resetAllRelayHealth();
		setActiveRelayState(pool([RELAY_A, RELAY_B]), false);
		try {
			markRelayQuotaFailure(RELAY_A, "de");
			assert.deepEqual(orderedRelayCandidates(undefined, undefined, false, "de"), [RELAY_B, RELAY_A]);
			assert.deepEqual(orderedRelayCandidates(undefined, undefined, false, "ne"), [RELAY_A, RELAY_B]);
			assert.deepEqual(orderedRelayCandidates(undefined, undefined, false, null), [RELAY_A, RELAY_B]);
		} finally {
			resetAllRelayHealth();
		}
	});
});

test("mixed health: a network-cooled relay and a bucket-cooled relay order per bucket", async () => {
	withIsolatedRelayFiles(() => {
		resetAllRelayHealth();
		const RELAY_C = "https://quota-c.example.com";
		setActiveRelayState(pool([RELAY_A, RELAY_B, RELAY_C]), false);
		try {
			// A is network-dead (all buckets); B has only its "de" bucket cooled.
			markRelayFailure(RELAY_A, 0, "socket hang up");
			markRelayQuotaFailure(RELAY_B, "de");
			// For "de": both A and B are demoted, C (fully healthy) leads.
			assert.deepEqual(orderedRelayCandidates(undefined, undefined, false, "de"), [RELAY_C, RELAY_A, RELAY_B]);
			// For "ne": only A is demoted; B serves again, so it leads C.
			assert.deepEqual(orderedRelayCandidates(undefined, undefined, false, "ne"), [RELAY_B, RELAY_C, RELAY_A]);
			// Network health stays distinct: A is unhealthy for every bucket.
			assert.equal(isRelayHealthy(RELAY_A, "de"), false);
			assert.equal(isRelayHealthy(RELAY_A, "ne"), false);
			assert.equal(isRelayHealthy(RELAY_B, "de"), false);
			assert.equal(isRelayHealthy(RELAY_B, "ne"), true);
		} finally {
			resetAllRelayHealth();
		}
	});
});
