/**
 * Relay pool portability: `/freeflow export` + `/freeflow import`.
 *
 * Covers the export/import codec (buildRelayExport, parseRelayImport,
 * planRelayImport — defined in src/relay-state.ts) and the disk discipline
 * around it: nothing is ever written until the whole file parses, an
 * unconfirmed replace or a dry run leaves the disk untouched, and an empty
 * relay list can never wipe the pool.
 *
 * Every disk-touching case runs inside withIsolatedRelayFiles (main + .bak
 * both), matching test/relay-state-lifecycle.test.ts. Pure codec cases need
 * no isolation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RELAY_STATE_FILE } from "../src/config.ts";
import {
	EXPORT_DEFAULT_FILENAME,
	EXPORT_KIND,
	EXPORT_VERSION,
	buildRelayExport,
	loadRelayState,
	parseRelayImport,
	planRelayImport,
	saveRelayState,
	withRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

/** Isolate both main and .bak disk files for the duration of a test. */
function withIsolatedRelayFiles(fn: () => void): void {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(BAK_FILE);
	try {
		fn();
	} finally {
		const restore = (p: string, before: string | null): void => {
			if (before !== null) {
				fs.writeFileSync(p, before, "utf8");
			} else {
				try {
					fs.rmSync(p, { force: true });
				} catch {}
			}
		};
		restore(RELAY_STATE_FILE, mainBefore);
		restore(BAK_FILE, bakBefore);
	}
}

/** Exact bytes + mtime of both state files, for untouched-disk assertions. */
function snapshotDisk(): { main: string | null; bak: string | null; mtimeMs: number } {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	let mtimeMs = -1;
	try {
		mtimeMs = fs.statSync(RELAY_STATE_FILE).mtimeMs;
	} catch {}
	return { main: read(RELAY_STATE_FILE), bak: read(BAK_FILE), mtimeMs };
}

function seedDisk(s: RelayState): void {
	saveRelayState(s);
}

const SEEDED: RelayState = {
	mode: "auto",
	enabled: true,
	url: "https://relay-a.example.com",
	relays: [
		{ url: "https://relay-a.example.com", label: "Primary" },
		{ url: "https://relay-b.example.com", label: "Backup" },
	],
	hideWidget: false,
};

describe("relay pool export/import", () => {
	it("(a) round-trip export→merge preserves the pool and short names", () => {
		const source: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay-a.example.com",
			relays: [
				{
					url: "https://relay-a.example.com",
					label: "Primary",
					addedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					url: "https://relay-b.example.com",
					label: "Backup",
					addedAt: "2026-02-02T00:00:00.000Z",
				},
			],
			hideWidget: false,
		};
		const artifact = buildRelayExport(source);
		assert.equal(artifact.kind, EXPORT_KIND);
		assert.equal(artifact.version, EXPORT_VERSION);
		assert.equal(EXPORT_DEFAULT_FILENAME, "freeflow-relays.json");
		assert.ok(!Number.isNaN(Date.parse(artifact.exportedAt)));

		// Through real JSON bytes, the way a file round-trip works.
		const { fragment, skipped } = parseRelayImport(JSON.stringify(artifact));
		assert.equal(skipped.length, 0);

		const current: RelayState = {
			mode: "auto",
			enabled: true,
			url: "",
			relays: [],
			hideWidget: false,
		};
		const plan = planRelayImport(current, fragment, { mode: "merge" });
		assert.equal(plan.added, 2);
		assert.deepEqual(
			plan.next.relays.map((r) => r.url),
			["https://relay-a.example.com", "https://relay-b.example.com"],
		);
		assert.deepEqual(
			plan.next.relays.map((r) => r.label),
			["Primary", "Backup"],
		);
	});

	it("(b) confirmed replace overwrites the pool, address and mode", () => {
		withIsolatedRelayFiles(() => {
			seedDisk(SEEDED);
			const incoming: RelayState = {
				mode: "on",
				enabled: true,
				url: "https://relay-c.example.com",
				relays: [{ url: "https://relay-c.example.com", label: "Fresh" }],
				hideWidget: false,
			};
			const raw = JSON.stringify(buildRelayExport(incoming));
			const { fragment } = parseRelayImport(raw);
			const plan = planRelayImport(loadRelayState(), fragment, { mode: "replace" });
			// User confirmed: single CAS write applies the planned state.
			withRelayState(() => plan.next);
			const after = loadRelayState();
			assert.equal(after.mode, "on");
			assert.equal(after.url, "https://relay-c.example.com");
			assert.deepEqual(
				after.relays.map((r) => r.url),
				["https://relay-c.example.com"],
			);
		});
	});

	it("(c) unconfirmed replace writes nothing (bytes + mtime identical)", () => {
		withIsolatedRelayFiles(() => {
			seedDisk(SEEDED);
			const before = snapshotDisk();
			const incoming: RelayState = {
				mode: "off",
				enabled: false,
				url: "https://relay-c.example.com",
				relays: [{ url: "https://relay-c.example.com" }],
				hideWidget: false,
			};
			const raw = JSON.stringify(buildRelayExport(incoming));
			const { fragment } = parseRelayImport(raw);
			// Preview only — the user declined the confirmation, so the
			// planned state is discarded and never reaches withRelayState.
			planRelayImport(loadRelayState(), fragment, { mode: "replace" });
			const after = snapshotDisk();
			assert.equal(after.main, before.main);
			assert.equal(after.bak, before.bak);
			assert.equal(after.mtimeMs, before.mtimeMs);
		});
	});

	it("(d) passwords are stripped by default, kept verbatim on request", () => {
		const source: RelayState = {
			mode: "auto",
			enabled: true,
			url: "https://relay-a.example.com",
			relays: [{ url: "https://relay-a.example.com", label: "Primary", auth: "s3cret" }],
			hideWidget: false,
		};
		const stripped = buildRelayExport(source);
		assert.equal(stripped.state.relays[0].auth, undefined);
		assert.ok(!("auth" in stripped.state.relays[0]));

		const kept = buildRelayExport(source, { includeSecrets: true });
		assert.equal(kept.state.relays[0].auth, "s3cret");
	});

	it("(e) bad addresses are skipped with a reason, good ones still merge", () => {
		withIsolatedRelayFiles(() => {
			seedDisk(SEEDED);
			const raw = JSON.stringify({
				kind: EXPORT_KIND,
				version: EXPORT_VERSION,
				exportedAt: new Date().toISOString(),
				state: {
					mode: "auto",
					enabled: true,
					url: "https://relay-a.example.com",
					relays: [
						{ url: "https://relay-d.example.com", label: "New" },
						{ url: "not a url" },
						{ url: "http://insecure.example.com" },
					],
				},
			});
			const { fragment, skipped } = parseRelayImport(raw);
			assert.equal(skipped.length, 2);
			for (const s of skipped) {
				assert.ok(typeof s.index === "number");
				assert.ok(s.url.length > 0);
				assert.ok(s.reason.length > 0);
			}
			const plan = planRelayImport(loadRelayState(), fragment, { mode: "merge" });
			withRelayState(() => plan.next);
			const after = loadRelayState();
			assert.deepEqual(
				after.relays.map((r) => r.url).sort(),
				[
					"https://relay-a.example.com",
					"https://relay-b.example.com",
					"https://relay-d.example.com",
				].sort(),
			);
			// Nothing unparsable leaked into the pool.
			for (const r of after.relays) {
				assert.ok(r.url.startsWith("https://"));
				assert.ok(!r.url.includes(" "));
			}
			// Pre-existing short names survived the merge.
			assert.equal(
				after.relays.find((r) => r.url === "https://relay-a.example.com")?.label,
				"Primary",
			);
		});
	});

	it("(f) dry run plans only — zero state writes, disk untouched", () => {
		withIsolatedRelayFiles(() => {
			seedDisk(SEEDED);
			const before = snapshotDisk();
			const incoming: RelayState = {
				mode: "on",
				enabled: true,
				url: "https://relay-c.example.com",
				relays: [{ url: "https://relay-c.example.com", label: "Fresh" }],
				hideWidget: false,
			};
			const raw = JSON.stringify(buildRelayExport(incoming));
			const { fragment } = parseRelayImport(raw);
			// Dry run: plan only, never call withRelayState.
			const plan = planRelayImport(loadRelayState(), fragment, { mode: "replace" });
			assert.ok(plan.added + plan.updated + plan.removed > 0);
			const after = snapshotDisk();
			assert.equal(after.main, before.main);
			assert.equal(after.bak, before.bak);
			assert.equal(after.mtimeMs, before.mtimeMs);
		});
	});

	it("(g) corrupt file aborts the import, pool unchanged", () => {
		withIsolatedRelayFiles(() => {
			seedDisk(SEEDED);
			assert.throws(() => parseRelayImport("{oops, not json"), Error);
			assert.throws(() => parseRelayImport('{"kind":"something-else"}'), Error);
			const after = loadRelayState();
			assert.deepEqual(
				after.relays.map((r) => r.url).sort(),
				["https://relay-a.example.com", "https://relay-b.example.com"].sort(),
			);
			assert.equal(after.url, "https://relay-a.example.com");
		});
	});

	it("(h) empty relay list is a no-op for merge and replace — never a wipe", () => {
		withIsolatedRelayFiles(() => {
			seedDisk(SEEDED);
			const before = snapshotDisk();
			const raw = JSON.stringify({
				kind: EXPORT_KIND,
				version: EXPORT_VERSION,
				exportedAt: new Date().toISOString(),
				state: {
					mode: "auto",
					enabled: true,
					url: "https://relay-a.example.com",
					relays: [],
				},
			});
			// Parsing an empty list succeeds (zero usable addresses, zero skipped).
			const { fragment, skipped } = parseRelayImport(raw);
			assert.equal(skipped.length, 0);
			for (const mode of ["merge", "replace"] as const) {
				const plan = planRelayImport(loadRelayState(), fragment, { mode });
				// Nothing to apply: the import handler refuses the file before
				// any state write ("holds no usable relay addresses").
				assert.equal(plan.added, 0);
				assert.equal(plan.updated, 0);
				assert.equal(plan.removed, 0);
				assert.deepEqual(
					plan.next.relays.map((r) => r.url).sort(),
					["https://relay-a.example.com", "https://relay-b.example.com"].sort(),
				);
				if (plan.added + plan.updated + plan.removed === 0 && plan.skipped.length === 0) {
					// Gate: no usable addresses → no withRelayState call.
				} else {
					assert.fail(`empty import planned writes for mode ${mode}`);
				}
			}
			// No write happened: the pool is intact on disk.
			const after = snapshotDisk();
			assert.equal(after.main, before.main);
			assert.equal(after.bak, before.bak);
			assert.equal(after.mtimeMs, before.mtimeMs);
		});
	});

});
