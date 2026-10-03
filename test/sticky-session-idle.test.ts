/**
	* Session pin with idle reset: an active conversation sticks to the warm relay
	* that served it (fast turn-2 via the upstream prefix cache); after 20min idle
	* the pin releases and ordering falls back to the standing health order.
	* Unhealthy relays never hoist. Pins persist across restarts in a small JSON
	* next to the relay state file (the RelayState disk shape is untouched).
	* Deterministic, no network.
	*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RELAY_STATE_FILE } from "../src/config.ts";
import {
	getOrderedRelayUrls,
	markRelayFailure,
	orderedRelayCandidates,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import {
	_resetReasoningStateForTest,
	issuerRelayFor,
	rememberIssuerRelay,
} from "../src/responses.ts";
import type { RelayState } from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;
// Mirrors resolveSessionPinPath() in src/config.ts, kept literal on purpose:
// the test must load against unpatched src too (and fail on ordering, not imports).
const PIN_FILE = path.join(path.dirname(RELAY_STATE_FILE), "pi-freeflow-session-pins.json");
/** Mirrors SESSION_PIN_IDLE_MS in src/responses.ts, kept literal on purpose:
	* the test must not import knobs out of src. */
const IDLE_MS = 20 * 60 * 1000;

const RELAY_A = "https://sticky-a.example.com";
const RELAY_B = "https://sticky-b.example.com";

function poolState(): RelayState {
	return { mode: "auto", enabled: true, url: RELAY_A, relays: [{ url: RELAY_A }, { url: RELAY_B }] };
}

/** Isolate main + .bak + the pin mirror (relay writes and pin persistence touch disk). */
async function withIsolatedRelayFiles(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(BAK_FILE);
	const pinBefore = read(PIN_FILE);
	try {
		await fn();
	} finally {
		for (const [p, content] of [[RELAY_STATE_FILE, mainBefore], [BAK_FILE, bakBefore], [PIN_FILE, pinBefore]] as const) {
			if (content === null) {
				if (fs.existsSync(p)) fs.unlinkSync(p);
			} else {
				fs.writeFileSync(p, content);
			}
		}
		resetAllRelayHealth();
		_resetReasoningStateForTest();
	}
}

async function withClockSkewed(ms: number, fn: () => Promise<void>): Promise<void> {
	const realNow = Date.now;
	Date.now = () => realNow() + ms;
	try {
		await fn();
	} finally {
		Date.now = realNow;
	}
}

test("fresh pin hoists its warm relay first", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		_resetReasoningStateForTest();
		setActiveRelayState(poolState(), false);
		rememberIssuerRelay("conv-fresh", RELAY_B);
		assert.equal(issuerRelayFor("conv-fresh"), RELAY_B);
		const order = orderedRelayCandidates(issuerRelayFor("conv-fresh") ?? undefined);
		assert.equal(order[0], RELAY_B, "an active session stays on its warm relay");
	});
});

test("idle past 20min releases the pin to the standing order", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		_resetReasoningStateForTest();
		setActiveRelayState(poolState(), false);
		rememberIssuerRelay("conv-idle", RELAY_B);
		assert.equal(issuerRelayFor("conv-idle"), RELAY_B);
		await withClockSkewed(IDLE_MS + 60_000, async () => {
			assert.equal(issuerRelayFor("conv-idle"), undefined, "stale pin releases");
			const order = orderedRelayCandidates(issuerRelayFor("conv-idle") ?? undefined);
			assert.deepEqual(order, getOrderedRelayUrls(), "released pin orders exactly as today");
			assert.notEqual(order[0], RELAY_B, "standing order no longer starts on the released relay");
		});
		// Lazy prune: the stale entry is gone even after the clock returns.
		assert.equal(issuerRelayFor("conv-idle"), undefined);
	});
});

test("unhealthy pinned relay never hoists", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		_resetReasoningStateForTest();
		setActiveRelayState(poolState(), false);
		rememberIssuerRelay("conv-sick", RELAY_B);
		markRelayFailure(RELAY_B, 429);
		assert.equal(issuerRelayFor("conv-sick"), RELAY_B, "the fresh pin is still known");
		const order = orderedRelayCandidates(RELAY_B);
		assert.notEqual(order[0], RELAY_B, "a cooling relay stays at the tail");
		assert.equal(order[order.length - 1], RELAY_B);
	});
});

test("pins survive a restart via the pin mirror", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		_resetReasoningStateForTest();
		setActiveRelayState(poolState(), false);
		rememberIssuerRelay("conv-restart", RELAY_B);
		assert.ok(fs.existsSync(PIN_FILE), "pin mirror written next to the relay state");
		// Simulate a proxy restart: drop all memory, reload from disk.
		_resetReasoningStateForTest();
		assert.equal(issuerRelayFor("conv-restart"), RELAY_B, "pin restored from disk");
		const order = orderedRelayCandidates(issuerRelayFor("conv-restart") ?? undefined);
		assert.equal(order[0], RELAY_B);
	});
});

test("corrupt pin mirror loads empty, never throws", async () => {
	await withIsolatedRelayFiles(async () => {
		resetAllRelayHealth();
		_resetReasoningStateForTest();
		setActiveRelayState(poolState(), false);
		fs.writeFileSync(PIN_FILE, "!!! not valid json !!!", "utf8");
		_resetReasoningStateForTest();
		assert.doesNotThrow(() => issuerRelayFor("conv-ghost"));
		assert.equal(issuerRelayFor("conv-ghost"), undefined);
	});
});
