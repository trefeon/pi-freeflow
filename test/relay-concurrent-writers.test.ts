/**
 * Cross-process relay state writers.
 *
 * withRelayState is fully synchronous, so two calls inside one process cannot
 * interleave — the lock file exists for the case the daemon cannot see: a second
 * process (a respawn racing its predecessor, a leftover child, the user running
 * a command in another terminal) writing the same state file at the same time.
 *
 * Every other withRelayState test is sequential, so the torn-write invariant has
 * never actually been exercised under contention. That is the gap here: many
 * concurrent writers, each landing a different payload, with a reader watching the
 * file the whole time. A reader must never observe a partial document, because
 * loadRelayState cannot parse a torn file and falls back to an empty pool — which
 * would silently wipe a user's configured relays.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RELAY_STATE_FILE } from "../src/config.ts";
import { loadRelayState, saveRelayState, withRelayState } from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const RELAY_A = "https://race-a.example.com";
const RELAY_B = "https://race-b.example.com";

function seedState(): RelayState {
	return { mode: "auto", enabled: true, url: RELAY_A, relays: [{ url: RELAY_A }, { url: RELAY_B }] };
}

test("concurrent cross-process writers never expose a torn state file to a reader", async () => {
	await withIsolatedRelayFiles(async () => {
		// Workers inherit PI_FREEFLOW_DATA_DIR from this process, so they all
		// resolve the same sandboxed RELAY_STATE_FILE without being told.
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-race-"));
		const workerPath = path.join(workDir, "writer.ts");
		// Must be a file:// URL, not a bare Windows path: the ESM loader rejects
		// a "d:"-scheme specifier outright.
		const srcEntry = pathToFileURL(path.resolve(process.cwd(), "src", "relay-state.ts")).href;
		fs.writeFileSync(
			workerPath,
			[
				`import { withRelayState } from ${JSON.stringify(srcEntry)};`,
				`const tag = process.argv[2];`,
				`for (let i = 0; i < 150; i++) {`,
				`  withRelayState((s) => { s.url = "https://" + tag + "-" + i + ".example.com"; return s; });`,
				`}`,
				"",
			].join("\n"),
			"utf8",
		);

		saveRelayState(seedState());

		const tags = ["w1", "w2", "w3", "w4"];
		const children = tags.map(
			(tag) =>
				new Promise<{ code: number; stderr: string }>((resolve) => {
					let stderr = "";
					const child = spawn(
						process.execPath,
						["--experimental-strip-types", "--no-warnings", workerPath, tag],
						{ env: process.env, stdio: ["ignore", "ignore", "pipe"] },
					);
					child.stderr?.on("data", (c) => {
						stderr += String(c);
					});
					child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
				}),
		);

		let finished = false;
		let reads = 0;
		const torn: string[] = [];
		const watcher = (async () => {
			while (!finished) {
				if (fs.existsSync(RELAY_STATE_FILE)) {
					const raw = fs.readFileSync(RELAY_STATE_FILE, "utf8");
					reads++;
					try {
						const parsed = JSON.parse(raw);
						// A complete document always carries the seeded pool and a
						// url string written by one of the workers.
						if (typeof parsed?.url !== "string" || !Array.isArray(parsed?.relays)) {
							torn.push(raw);
						}
					} catch {
						torn.push(raw);
					}
				}
				// Yield to the event loop so child-exit events and IO get
				// delivered. setImmediate is a macrotask yield, not a
				// duration-based wait: no wall-clock latency is baked in.
				await new Promise((r) => setImmediate(r));
			}
		})();

		const results = await Promise.all(children);
		finished = true;
		await watcher;
		fs.rmSync(workDir, { recursive: true, force: true });

		for (const [i, { code, stderr }] of results.entries()) {
			assert.equal(code, 0, `worker ${tags[i]} exited ${code}\n${stderr}`);
		}
		assert.ok(reads > 0, "the watcher never managed to read the file — test proves nothing");
		assert.deepEqual(torn, [], `reader observed ${torn.length} torn state document(s)`);

		const final = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		assert.ok(
			/^https:\/\/w[1-4]-\d+\.example\.com$/.test(final.url),
			`final url must be one whole worker's write, got ${final.url}`,
		);
		// Orphan .tmp litter is deliberately NOT asserted here: a rename that
		// loses its retry race leaves one behind and saveRelayState swallows the
		// throw, so litter is expected under contention. It is reaped by
		// cleanupStaleTmpFiles after an hour, and that contract already has its
		// own test ("stale tmp litter from crashed saves is cleaned up on load").
	}, { lock: true });
});

test("withRelayState: a throwing updater persists nothing and leaves the pool intact", async () => {
	await withIsolatedRelayFiles(async () => {
		saveRelayState(seedState());
		assert.throws(
			() =>
				withRelayState(() => {
					throw new Error("updater exploded");
				}),
			/updater exploded/,
		);
		// The save is downstream of the updater, so a failed updater must leave
		// the previous document exactly as it was — never an empty pool.
		const after = loadRelayState();
		assert.deepEqual(after.url, RELAY_A);
		assert.deepEqual(after.relays.map((r) => r.url), [RELAY_A, RELAY_B]);
	}, { lock: true });
});