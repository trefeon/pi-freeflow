import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	classifyModelEntry,
	collectLiveData,
	detectDrift,
	extractFreeModelCandidates,
	extractFreeModels,
	fetchFileSha,
	fetchLatestRelease,
	fetchLiveFreeModels,
	generateDriftReport,
	generateInfraReport,
	hashContent,
	hashNormalizedContent,
	InfraError,
	loadState,
	normalizeContent,
	parseAtomRelease,
	runWatch,
	saveState,
	StateError,
	updateStateWithLive,
	// @ts-expect-error: opencode-watch.mjs is an executable script without generated d.ts
} from "../scripts/opencode-watch.mjs";

const BASELINE_STATE = {
	lastRelease: "v1.18.31",
	fileShas: {
		"identifier.ts": "3eeb8c682210921b6dac49f0d785d9088a48503c4539d590f5c3b0e848d78b27",
		"session-id.ts": "e9bf2bb2382af14577371b17b22b36f07ef6cf97923e655935fde0460ec3bdc6",
		"zen.mdx": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
	},
	freeModels: ["big-pickle", "ling-3.0-flash-fin-free", "mimo-v2.5-free", "nemotron-3-ultra-free"],
	lastChecked: "2026-09-19T00:00:00.000Z",
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-watch-"));
	try {
		await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeState(dir: string, state: unknown): Promise<string> {
	const statePath = path.join(dir, "watch-state.json");
	await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
	return statePath;
}

test("parseAtomRelease extracts tag from link href", () => {
	const xml = `<?xml version="1.0"?><feed><entry><title>v1.18.31</title><link href="https://github.com/anomalyco/opencode/releases/tag/v1.18.31"/></entry></feed>`;
	assert.equal(parseAtomRelease(xml), "v1.18.31");
});

test("parseAtomRelease extracts tag from entry title fallback", () => {
	const xml = `<feed><entry><title>v1.18.30</title></entry></feed>`;
	assert.equal(parseAtomRelease(xml), "v1.18.30");
});

test("parseAtomRelease throws on missing release data", () => {
	assert.throws(() => parseAtomRelease("<feed></feed>"), /Failed to parse release tag/);
});

test("fetchLatestRelease returns tag_name from GitHub API", async () => {
	const mockFetch = async () => ({
		ok: true,
		status: 200,
		json: async () => ({ tag_name: "v1.18.31", name: "v1.18.31" }),
	});
	const tag = await fetchLatestRelease({ fetchFn: mockFetch as unknown as typeof fetch });
	assert.equal(tag, "v1.18.31");
});

test("fetchLatestRelease falls back to Atom feed on API 403 / rate limit", async () => {
	const mockFetch = async (url: string) => {
		if (url === "https://api.github.com/repos/anomalyco/opencode/releases/latest") {
			return { ok: false, status: 403, json: async () => ({ message: "API rate limit exceeded" }) };
		}
		if (url === "https://github.com/anomalyco/opencode/releases.atom") {
			return {
				ok: true,
				status: 200,
				text: async () =>
					`<feed><entry><title>v1.18.31</title><link href="https://github.com/anomalyco/opencode/releases/tag/v1.18.31"/></entry></feed>`,
			};
		}
		throw new Error("Unexpected URL");
	};
	const tag = await fetchLatestRelease({ fetchFn: mockFetch as unknown as typeof fetch });
	assert.equal(tag, "v1.18.31");
});

test("fetchFileSha iterates fallback URLs until success", async () => {
	const mockFetch = async (url: string) => {
		if (url === "https://raw.githubusercontent.com/dev/docs/zen.mdx") {
			return { ok: false, status: 404, text: async () => "Not Found" };
		}
		if (url === "https://raw.githubusercontent.com/dev/packages/web/src/content/docs/zen.mdx") {
			return { ok: true, status: 200, text: async () => "# Zen Documentation\nFree tier info" };
		}
		throw new Error("Unexpected URL");
	};
	const res = await fetchFileSha(
		[
			"https://raw.githubusercontent.com/dev/docs/zen.mdx",
			"https://raw.githubusercontent.com/dev/packages/web/src/content/docs/zen.mdx",
		],
		{ fetchFn: mockFetch as unknown as typeof fetch },
	);
	assert.equal(res.url, "https://raw.githubusercontent.com/dev/packages/web/src/content/docs/zen.mdx");
	assert.equal(res.content, "# Zen Documentation\nFree tier info");
	assert.equal(res.sha, hashContent("# Zen Documentation\nFree tier info"));
});

test("fetchFileSha normalizes CRLF and trailing newlines before hashing", async () => {
	const mockFetch = async () => ({ ok: true, status: 200, text: async () => "# Zen\r\nFree tier info\r\n\r\n" });
	const res = await fetchFileSha("https://example.com/zen.mdx", {
		fetchFn: mockFetch as unknown as typeof fetch,
	});
	assert.equal(res.sha, hashNormalizedContent("# Zen\nFree tier info"));
	assert.equal(normalizeContent("# Zen\r\nFree tier info\r\n\r\n"), "# Zen\nFree tier info");
	assert.equal(hashNormalizedContent("same\n"), hashNormalizedContent("same"));
});
test("extractFreeModels identifies free models and filters paid models", () => {
	const rawPayload = {
		data: [
			{ id: "claude-3-5-sonnet", pricing: { prompt: 3, completion: 15 } },
			{ id: "big-pickle" },
			{ id: "nemotron-3-ultra-free" },
			{ id: "mimo-v2.5-free" },
			{ id: "qwen-2.5-coder", pricing: { prompt: 0, completion: 0 } },
			{ id: "deepseek-chat-special", is_free: true },
			{ id: "gpt-4o", pricing: { prompt: 5, completion: 15 } },
		],
	};
	const models = extractFreeModels(rawPayload);
	assert.deepEqual(models, [
		"big-pickle",
		"deepseek-chat-special",
		"mimo-v2.5-free",
		"nemotron-3-ultra-free",
		"qwen-2.5-coder",
	]);
});

test("zero-price and is_free entries count as free regardless of suffix", () => {
	assert.equal(classifyModelEntry({ id: "qwen-2.5-coder", pricing: { prompt: 0, completion: 0 } }), "free");
	assert.equal(classifyModelEntry({ id: "mystery-model", is_free: true }), "free");
	assert.equal(classifyModelEntry({ id: "big-pickle" }), "free");
	assert.equal(classifyModelEntry({ id: "nemotron-3-ultra-free" }), "free");
});

test("suffix-less IDs without a free signal surface as candidates, never a silent miss", () => {
	const rawPayload = {
		data: [
			{ id: "mystery-model" },
			{ id: "claude-3-5-sonnet", pricing: { prompt: 3, completion: 15 } },
			{ id: "big-pickle" },
			{ id: "paid/slashed-model", pricing: { prompt: 1, completion: 2 } },
			{ id: "nemotron-3-ultra-free" },
		],
	};
	assert.deepEqual(extractFreeModelCandidates(rawPayload), ["claude-3-5-sonnet", "mystery-model"]);
	assert.ok(!extractFreeModels(rawPayload).includes("mystery-model"));
});

test("fetchLiveFreeModels returns models, candidates, and rawSha", async () => {
	const mockFetch = async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ data: [{ id: "big-pickle" }, { id: "mystery-model" }] }),
	});
	const res = await fetchLiveFreeModels({ fetchFn: mockFetch as unknown as typeof fetch });
	assert.deepEqual(res.models, ["big-pickle"]);
	assert.deepEqual(res.candidates, ["mystery-model"]);
	assert.match(res.rawSha, /^[0-9a-f]{64}$/);
});

test("fetchLiveFreeModels rejects odd payload shapes as infra errors", async () => {
	const mockFetch = async () => ({ ok: true, status: 200, text: async () => "42" });
	await assert.rejects(
		fetchLiveFreeModels({ fetchFn: mockFetch as unknown as typeof fetch }),
		/Unexpected models payload shape/,
	);
});

test("detectDrift returns no drift when live matches state baseline", () => {
	const liveData = {
		latestRelease: BASELINE_STATE.lastRelease,
		fileShas: { ...BASELINE_STATE.fileShas },
		freeModels: [...BASELINE_STATE.freeModels],
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, false);
	assert.equal(result.summary.length, 0);
	assert.equal(result.release.changed, false);
	assert.equal(result.sessionIdAffected, false);
	assert.equal(result.freeModels.changed, false);
	assert.equal(result.freeModels.added.length, 0);
	assert.equal(result.freeModels.removed.length, 0);
});

test("detectDrift detects when a free model is removed", () => {
	const liveData = {
		latestRelease: BASELINE_STATE.lastRelease,
		fileShas: { ...BASELINE_STATE.fileShas },
		freeModels: BASELINE_STATE.freeModels.filter((m) => m !== "ling-3.0-flash-fin-free"),
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, true);
	assert.equal(result.freeModels.changed, true);
	assert.deepEqual(result.freeModels.removed, ["ling-3.0-flash-fin-free"]);
	assert.equal(result.freeModels.added.length, 0);
	assert.ok(result.summary.some((s: string) => s.includes("Free models removed") && s.includes("ling-3.0-flash-fin-free")));
});

test("detectDrift detects when a free model is added", () => {
	const liveData = {
		latestRelease: BASELINE_STATE.lastRelease,
		fileShas: { ...BASELINE_STATE.fileShas },
		freeModels: [...BASELINE_STATE.freeModels, "deepseek-v4-flash-free"],
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, true);
	assert.equal(result.freeModels.changed, true);
	assert.deepEqual(result.freeModels.added, ["deepseek-v4-flash-free"]);
	assert.equal(result.freeModels.removed.length, 0);
	assert.ok(result.summary.some((s: string) => s.includes("Free models added") && s.includes("deepseek-v4-flash-free")));
});

test("detectDrift detects schema SHA changes and flags session ID impact", () => {
	const liveData = {
		latestRelease: BASELINE_STATE.lastRelease,
		fileShas: {
			...BASELINE_STATE.fileShas,
			"session-id.ts": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		},
		freeModels: [...BASELINE_STATE.freeModels],
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, true);
	assert.equal(result.sessionIdAffected, true);
	assert.equal(result.fileShas["session-id.ts"].changed, true);
	assert.equal(result.fileShas["identifier.ts"].changed, false);
	assert.ok(result.summary.some((s: string) => s.includes("session ID generator affected")));
});

test("detectDrift detects zen.mdx documentation/pricing changes", () => {
	const liveData = {
		latestRelease: BASELINE_STATE.lastRelease,
		fileShas: {
			...BASELINE_STATE.fileShas,
			"zen.mdx": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		freeModels: [...BASELINE_STATE.freeModels],
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, true);
	assert.equal(result.zenDocAffected, true);
	assert.equal(result.sessionIdAffected, false);
	assert.ok(result.summary.some((s: string) => s.includes("Zen documentation / pricing drift")));
});

test("detectDrift detects new release tag", () => {
	const liveData = {
		latestRelease: "v1.19.0",
		fileShas: { ...BASELINE_STATE.fileShas },
		freeModels: [...BASELINE_STATE.freeModels],
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, true);
	assert.equal(result.release.changed, true);
	assert.equal(result.release.previous, "v1.18.31");
	assert.equal(result.release.current, "v1.19.0");
	assert.ok(result.summary.some((s: string) => s.includes("New release: `v1.18.31` -> `v1.19.0`")));
});

test("detectDrift treats unknown file SHAs as stale, never as drift", () => {
	const liveData = {
		latestRelease: BASELINE_STATE.lastRelease,
		fileShas: { ...BASELINE_STATE.fileShas, "zen.mdx": null },
		freeModels: [...BASELINE_STATE.freeModels],
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, false);
	assert.equal(result.fileShas["zen.mdx"].changed, false);
	assert.equal(result.fileShas["zen.mdx"].stale, true);
	assert.deepEqual(result.staleFiles, ["zen.mdx"]);
	assert.ok(!result.summary.some((s: string) => s.includes("zen.mdx")));
});

test("detectDrift carries free-model candidates without flagging drift", () => {
	const liveData = {
		latestRelease: BASELINE_STATE.lastRelease,
		fileShas: { ...BASELINE_STATE.fileShas },
		freeModels: [...BASELINE_STATE.freeModels],
		freeModelCandidates: ["mystery-model"],
	};
	const result = detectDrift(BASELINE_STATE, liveData);
	assert.equal(result.hasDrift, false);
	assert.deepEqual(result.freeModelCandidates, ["mystery-model"]);
});
test("generateDriftReport produces clean in-sync markdown when no drift", () => {
	const driftResult = {
		hasDrift: false,
		timestamp: "2026-09-19T00:00:00.000Z",
		release: { previous: "v1.18.31", current: "v1.18.31", changed: false },
		fileShas: {},
		staleFiles: [],
		sessionIdAffected: false,
		zenDocAffected: false,
		freeModels: {
			previous: BASELINE_STATE.freeModels,
			current: BASELINE_STATE.freeModels,
			added: [],
			removed: [],
			changed: false,
		},
		freeModelCandidates: [],
		summary: [],
	};
	const markdown = generateDriftReport(driftResult);
	assert.ok(markdown.includes("## ✅ OpenCode Upstream Status: In Sync"));
	assert.ok(markdown.includes("No drift detected."));
	assert.ok(markdown.includes("`v1.18.31`"));
});

test("generateDriftReport produces comprehensive issue body on drift with session ID warning", () => {
	const driftResult = {
		hasDrift: true,
		timestamp: "2026-09-19T04:00:00.000Z",
		release: { previous: "v1.18.30", current: "v1.18.31", changed: true },
		fileShas: {
			"identifier.ts": {
				previous: "3eeb8c682210921b6dac49f0d785d9088a48503c4539d590f5c3b0e848d78b27",
				current: "4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
				changed: true,
				stale: false,
			},
			"session-id.ts": {
				previous: "e9bf2bb2382af14577371b17b22b36f07ef6cf97923e655935fde0460ec3bdc6",
				current: "e9bf2bb2382af14577371b17b22b36f07ef6cf97923e655935fde0460ec3bdc6",
				changed: false,
				stale: false,
			},
		},
		staleFiles: [],
		sessionIdAffected: true,
		zenDocAffected: false,
		freeModels: {
			previous: BASELINE_STATE.freeModels,
			current: [...BASELINE_STATE.freeModels.filter((m) => m !== "ling-3.0-flash-fin-free"), "deepseek-v4-flash-free"],
			added: ["deepseek-v4-flash-free"],
			removed: ["ling-3.0-flash-fin-free"],
			changed: true,
		},
		freeModelCandidates: [],
		summary: [
			"New release: `v1.18.30` -> `v1.18.31`",
			"Schema drift in `identifier.ts` (session ID generator affected)",
			"Free models added: `deepseek-v4-flash-free`",
			"Free models removed: `ling-3.0-flash-fin-free`",
		],
	};
	const markdown = generateDriftReport(driftResult);
	assert.ok(markdown.includes("## 🚨 OpenCode Upstream Drift Detected"));
	assert.ok(markdown.includes("CRITICAL WARNING"));
	assert.ok(markdown.includes("### Summary of Changes"));
	assert.ok(markdown.includes("`v1.18.30`"));
	assert.ok(markdown.includes("`v1.18.31`"));
	assert.ok(markdown.includes("`identifier.ts`"));
	assert.ok(markdown.includes("`deepseek-v4-flash-free`"));
	assert.ok(markdown.includes("`ling-3.0-flash-fin-free`"));
	assert.ok(markdown.includes("### Recommended Actions"));
});

test("generateDriftReport lists stale baselines and model candidates", () => {
	const driftResult = {
		hasDrift: true,
		timestamp: "2026-09-19T04:00:00.000Z",
		release: { previous: "v1.18.31", current: "v1.18.31", changed: false },
		fileShas: {
			"zen.mdx": { previous: "a1b2c3", current: null, changed: false, stale: true },
		},
		staleFiles: ["zen.mdx"],
		sessionIdAffected: false,
		zenDocAffected: false,
		freeModels: {
			previous: BASELINE_STATE.freeModels,
			current: BASELINE_STATE.freeModels,
			added: [],
			removed: [],
			changed: false,
		},
		freeModelCandidates: ["mystery-model"],
		summary: [],
	};
	const markdown = generateDriftReport(driftResult);
	assert.ok(markdown.includes("Stale Baselines"));
	assert.ok(markdown.includes("`zen.mdx`"));
	assert.ok(markdown.includes("mystery-model"));
});

test("generateInfraReport marks the failure as non-drift", () => {
	const markdown = generateInfraReport(new Error("fetch failed"), "upstream");
	assert.ok(markdown.includes("Infra Failure"));
	assert.ok(markdown.includes("`upstream`"));
	assert.ok(markdown.includes("fetch failed"));
	assert.ok(markdown.includes("no drift issue will be filed"));
});

test("loadState rejects corrupt JSON with a distinct StateError", async () => {
	await withTempDir(async (dir) => {
		const badPath = path.join(dir, "watch-state.json");
		await fs.writeFile(badPath, "{ not json", "utf8");
		await assert.rejects(loadState(badPath), (err: unknown) => err instanceof StateError);
	});
});

test("loadState rejects wrong-shaped state with a distinct StateError", async () => {
	await withTempDir(async (dir) => {
		const statePath = await writeState(dir, { lastRelease: "v1.18.31" });
		await assert.rejects(loadState(statePath), StateError);
		const okPath = await writeState(dir, BASELINE_STATE);
		const loaded = await loadState(okPath);
		assert.deepEqual(loaded, BASELINE_STATE);
	});
});

test("saveState round-trips through an atomic tmp-plus-rename write", async () => {
	await withTempDir(async (dir) => {
		const statePath = path.join(dir, "watch-state.json");
		await saveState(statePath, BASELINE_STATE);
		const loaded = await loadState(statePath);
		assert.deepEqual(loaded, BASELINE_STATE);
		const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp."));
		assert.deepEqual(leftovers, []);
	});
});

test("updateStateWithLive never persists unknown markers", () => {
	const updated = updateStateWithLive(BASELINE_STATE, {
		latestRelease: "v1.19.0",
		fileShas: { ...BASELINE_STATE.fileShas, "zen.mdx": null },
		freeModels: [...BASELINE_STATE.freeModels],
	});
	assert.equal(updated.lastRelease, "v1.19.0");
	assert.equal(updated.fileShas["zen.mdx"], BASELINE_STATE.fileShas["zen.mdx"]);
	assert.ok(!Object.values(updated.fileShas).some((v) => v === null || String(v).startsWith("error:")));
});

test("collectLiveData records unknown for failed files, never an error string SHA", async () => {
	const mockFetch = async (url: string) => {
		if (url.includes("releases")) {
			return { ok: true, status: 200, json: async () => ({ tag_name: "v1.18.31" }) };
		}
		if (url.includes("models")) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "big-pickle" }] }) };
		}
		throw new Error("network down");
	};
	const liveData = await collectLiveData({
		fetchFn: mockFetch as unknown as typeof fetch,
		schemaFiles: { "zen.mdx": ["https://example.com/zen.mdx"] },
	});
	assert.equal(liveData.fileShas["zen.mdx"], null);
	assert.ok(liveData.fileFetchErrors["zen.mdx"].includes("network down"));
	assert.deepEqual(liveData.freeModels, ["big-pickle"]);
});

test("runWatch exit-code matrix: 0 in sync, 1 on drift", async () => {
	await withTempDir(async (dir) => {
		const statePath = await writeState(dir, BASELINE_STATE);
		const inSync = await runWatch({
			stateFile: statePath,
			mockLiveData: {
				latestRelease: BASELINE_STATE.lastRelease,
				fileShas: { ...BASELINE_STATE.fileShas },
				freeModels: [...BASELINE_STATE.freeModels],
			},
		});
		assert.equal(inSync.exitCode, 0);
		assert.equal(inSync.driftResult.hasDrift, false);
		const drifted = await runWatch({
			stateFile: statePath,
			mockLiveData: {
				latestRelease: "v1.19.0",
				fileShas: { ...BASELINE_STATE.fileShas },
				freeModels: [...BASELINE_STATE.freeModels],
			},
		});
		assert.equal(drifted.exitCode, 1);
		assert.equal(drifted.driftResult.hasDrift, true);
	});
});

test("runWatch offline failure: exit 2, report written, state untouched", async () => {
	await withTempDir(async (dir) => {
		const statePath = await writeState(dir, BASELINE_STATE);
		const before = await fs.readFile(statePath, "utf8");
		const reportPath = path.join(dir, "drift-report.md");
		const throwingFetch = async () => {
			throw new Error("network down");
		};
		await assert.rejects(
			runWatch({ stateFile: statePath, output: reportPath, fetchFn: throwingFetch as unknown as typeof fetch }),
			(err: unknown) => err instanceof InfraError && (err as InfraError).exitCode === 2,
		);
		const report = await fs.readFile(reportPath, "utf8");
		assert.ok(report.includes("Infra Failure"));
		assert.equal(await fs.readFile(statePath, "utf8"), before);
	});
});

test("runWatch corrupt state maps to exit 2 with an infra report", async () => {
	await withTempDir(async (dir) => {
		const badPath = path.join(dir, "watch-state.json");
		await fs.writeFile(badPath, "{ not json", "utf8");
		const reportPath = path.join(dir, "drift-report.md");
		await assert.rejects(runWatch({ stateFile: badPath, output: reportPath }), InfraError);
		const report = await fs.readFile(reportPath, "utf8");
		assert.ok(report.includes("Infra Failure"));
	});
});
