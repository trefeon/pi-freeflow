#!/usr/bin/env node
/**
 * OpenCode Zen Free-Tier & Schema Watcher Bot
 *
 * Monitors upstream `anomalyco/opencode` for:
 * 1. New release tags
 * 2. Schema changes in identifier.ts and session-id.ts (affects session ID generator)
 * 3. Zen documentation / pricing updates (zen.mdx)
 * 4. Changes in live Zen free-tier models (added, removed, deprecated)
 *
 * CLI flags:
 *   --check      Dry-run / check mode; exits 1 if drift detected.
 *   --update     Updates the state file with live data.
 *   --json       Emits structured JSON drift report to stdout.
 *   --output <f> Writes markdown drift report to specified file.
 *   --state <f>  Overrides path to state file (default: .github/opencode-watch-state.json).
 *   --help       Prints usage instructions.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_STATE_FILE = ".github/opencode-watch-state.json";

export const DEFAULT_CONFIG = {
 releaseApiUrl: "https://api.github.com/repos/anomalyco/opencode/releases/latest",
 releaseAtomUrl: "https://github.com/anomalyco/opencode/releases.atom",
 schemaFiles: {
  "identifier.ts": [
   "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/identifier.ts",
  ],
  "session-id.ts": [
   "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/session-id.ts",
  ],
  "zen.mdx": [
   "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx",
   "https://raw.githubusercontent.com/anomalyco/opencode/dev/docs/zen.mdx",
   "https://opencode.ai/docs/zen",
  ],
 },
 modelsUrl: "https://opencode.ai/zen/v1/models",
 userAgent: "pi-freeflow-watcher/1.0",
};

/**
 * Compute sha256 hash of a string or Buffer.
 * @param {string | Buffer} content
 * @returns {string}
 */
export function hashContent(content) {
 return crypto.createHash("sha256").update(content).digest("hex");
}

export const FETCH_TIMEOUT_MS = 20000;

export const UNKNOWN_SHA = null;

export class StateError extends Error {
 constructor(message) {
  super(message);
  this.name = "StateError";
 }
}

export class InfraError extends Error {
 constructor(message, reportMarkdown) {
  super(message);
  this.name = "InfraError";
  this.exitCode = 2;
  this.reportMarkdown = reportMarkdown;
 }
}

/**
 * Normalize file text before hashing: CRLF -> LF, lone CR -> LF,
 * trailing-newline-insensitive compare.
 * @param {string} text
 * @returns {string}
 */
export function normalizeContent(text) {
 return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
}

/**
 * Hash file text after EOL/trailing-newline normalization.
 * @param {string} text
 * @returns {string}
 */
export function hashNormalizedContent(text) {
 return hashContent(normalizeContent(text));
}

/**
 * Call a fetch implementation with an abort timeout.
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(fetchFn, url, options = {}) {
 const { timeoutMs, ...rest } = options;
 return fetchFn(url, { ...rest, signal: AbortSignal.timeout(timeoutMs || FETCH_TIMEOUT_MS) });
}

/**
 * Fetch latest release tag from GitHub API or Atom feed fallback.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn]
 * @param {string} [options.githubToken]
 * @param {string} [options.apiUrl]
 * @param {string} [options.atomUrl]
 * @param {string} [options.userAgent]
 * @returns {Promise<string>}
 */
export function parseAtomRelease(xmlText) {
 // Matches <link ... href=".../releases/tag/vX.Y.Z"/> or <title>vX.Y.Z</title>
 const tagLinkMatch = xmlText.match(/<link[^>]*href="[^"]*\/releases\/tag\/([^"]+)"/);
 if (tagLinkMatch && tagLinkMatch[1]) {
  return tagLinkMatch[1].trim();
 }
 const titleMatch = xmlText.match(/<entry>[\s\S]*?<title>([^<]+)<\/title>/);
 if (titleMatch && titleMatch[1]) {
  return titleMatch[1].trim();
 }
 throw new Error("Failed to parse release tag from Atom feed XML");
}

export async function fetchLatestRelease(options = {}) {
 const fetchFn = options.fetchFn || globalThis.fetch;
 const githubToken = options.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
 const apiUrl = options.apiUrl || DEFAULT_CONFIG.releaseApiUrl;
 const atomUrl = options.atomUrl || DEFAULT_CONFIG.releaseAtomUrl;
 const userAgent = options.userAgent || DEFAULT_CONFIG.userAgent;

 // 1. Try GitHub REST API
 try {
  const headers = { "User-Agent": userAgent, Accept: "application/vnd.github.v3+json" };
  if (githubToken) {
   headers.Authorization = `Bearer ${githubToken}`;
  }
  const res = await fetchWithTimeout(fetchFn, apiUrl, { headers });
  if (res.ok) {
   const data = await res.json();
   const tag = data.tag_name || data.name;
   if (tag) return String(tag).trim();
  }
 } catch {
  // Fall through to Atom feed
 }

 // 2. Fallback to releases.atom
 try {
  const res = await fetchWithTimeout(fetchFn, atomUrl, { headers: { "User-Agent": userAgent } });
  if (res.ok) {
   const xml = await res.text();
   return parseAtomRelease(xml);
  }
 } catch (err) {
  throw new Error(`Failed to fetch release tag: ${err.message}`);
 }

 throw new Error(`Failed to fetch latest release from both ${apiUrl} and ${atomUrl}`);
}

/**
 * Fetch a file from primary or fallback URLs and return sha256 hash.
 * @param {string | string[]} urls
 * @param {object} [options]
 * @returns {Promise<{ sha: string, content: string, url: string }>}
 */
export async function fetchFileSha(urls, options = {}) {
 const fetchFn = options.fetchFn || globalThis.fetch;
 const userAgent = options.userAgent || DEFAULT_CONFIG.userAgent;
 const candidateUrls = Array.isArray(urls) ? urls : [urls];

 let lastError = null;
 for (const url of candidateUrls) {
  try {
   const res = await fetchWithTimeout(fetchFn, url, { headers: { "User-Agent": userAgent } });
   if (res.ok) {
    const content = await res.text();
    const sha = hashNormalizedContent(content);
    return { sha, content, url };
   }
   lastError = new Error(`HTTP ${res.status} from ${url}`);
  } catch (err) {
   lastError = err;
  }
 }

 throw new Error(`Failed to fetch file from candidates [${candidateUrls.join(", ")}]: ${lastError?.message || "Unknown error"}`);
}

/**
 * Classify a single models-entry as free, candidate, or paid.
 * Zero-price / is_free entries count as free regardless of ID suffix.
 * Suffix-less IDs with no free signal surface as candidates (never a silent miss).
 * @param {any} item
 * @returns {"free" | "candidate" | "paid"}
 */
export function classifyModelEntry(item) {
 if (!item || typeof item.id !== "string") return "paid";
 const id = item.id.trim();
 if (id.length === 0) return "paid";
 if (id === "big-pickle") return "free";
 const pricing = item.pricing || {};
 const prompt = pricing.prompt !== undefined ? Number(pricing.prompt) : NaN;
 const completion = pricing.completion !== undefined ? Number(pricing.completion) : NaN;
 if ((item.is_free === true || item.free === true) || (prompt === 0 && completion === 0)) return "free";
 if (id.endsWith("-free") || id.includes("-free")) return "free";
 if (!id.includes("/")) return "candidate";
 return "paid";
}

/**
 * Extract free-tier model IDs from the Zen /v1/models response.
 * @param {any} payload
 * @returns {string[]} sorted array of free model IDs
 */
export function extractFreeModels(payload) {
 const items = Array.isArray(payload)
  ? payload
  : Array.isArray(payload?.data)
   ? payload.data
   : [];

 const freeIds = new Set();

 for (const item of items) {
  if (classifyModelEntry(item) === "free") freeIds.add(item.id.trim());
 }

 return Array.from(freeIds).sort();
}

/**
 * Extract candidate model IDs: suffix-less IDs with no free signal.
 * These need human review, never a silent miss.
 * @param {any} payload
 * @returns {string[]} sorted array of candidate model IDs
 */
export function extractFreeModelCandidates(payload) {
 const items = Array.isArray(payload)
  ? payload
  : Array.isArray(payload?.data)
   ? payload.data
   : [];

 const candidates = new Set();

 for (const item of items) {
  if (classifyModelEntry(item) === "candidate") candidates.add(item.id.trim());
 }

 return Array.from(candidates).sort();
}

/**
 * Fetch live free models from Zen API.
 * @param {object} [options]
 * @returns {Promise<{ models: string[], candidates: string[], rawSha: string }>}
 */
export async function fetchLiveFreeModels(options = {}) {
 const fetchFn = options.fetchFn || globalThis.fetch;
 const userAgent = options.userAgent || DEFAULT_CONFIG.userAgent;
 const url = options.url || DEFAULT_CONFIG.modelsUrl;

 const res = await fetchWithTimeout(fetchFn, url, { headers: { "User-Agent": userAgent } });
 if (!res.ok) {
  throw new Error(`Failed to fetch models from ${url}: HTTP ${res.status}`);
 }
 const text = await res.text();
 const rawSha = hashContent(text);
 const data = JSON.parse(text);
 if (!data || (typeof data !== "object" && !Array.isArray(data))) {
  throw new Error(`Unexpected models payload shape from ${url}`);
 }
 const models = extractFreeModels(data);
 const candidates = extractFreeModelCandidates(data);
 return { models, candidates, rawSha };
}

/**
 * Compare state against live data to detect drift.
 * @param {object} state
 * @param {object} liveData
 * @returns {object} drift result
 */
export function detectDrift(state, liveData) {
 const summary = [];
 let hasDrift = false;

 // 1. Release check
 const previousRelease = state.lastRelease || "";
 const currentRelease = liveData.latestRelease || "";
 const releaseChanged = Boolean(previousRelease && currentRelease && previousRelease !== currentRelease);

 if (releaseChanged) {
  hasDrift = true;
  summary.push(`New release: \`${previousRelease}\` -> \`${currentRelease}\``);
 }

 // 2. Schema / File SHA check
 const fileShas = {};
 const staleFiles = [];
 let sessionIdAffected = false;
 let zenDocAffected = false;

 const watchedFiles = Array.from(
  new Set([...Object.keys(state.fileShas || {}), ...Object.keys(liveData.fileShas || {})]),
 ).sort();

 for (const file of watchedFiles) {
  const prev = state.fileShas?.[file] || "";
  const curr = liveData.fileShas?.[file] ?? null;
  const stale = curr === null || curr === undefined || curr === "";
  const changed = Boolean(prev && !stale && prev !== curr);

  fileShas[file] = {
   previous: prev,
   current: stale ? null : curr,
   changed,
   stale,
  };

  if (stale) {
   staleFiles.push(file);
   continue;
  }

  if (changed) {
   hasDrift = true;
   if (file === "identifier.ts" || file === "session-id.ts") {
    sessionIdAffected = true;
    summary.push(`Schema drift in \`${file}\` (session ID generator affected)`);
   } else if (file === "zen.mdx") {
    zenDocAffected = true;
    summary.push(`Zen documentation / pricing drift in \`${file}\``);
   } else {
    summary.push(`File SHA drift in \`${file}\``);
   }
  }
 }

 // 3. Free models check
 const stateModels = Array.from(new Set(state.freeModels || [])).sort();
 const liveModels = Array.from(new Set(liveData.freeModels || [])).sort();

 const stateSet = new Set(stateModels);
 const liveSet = new Set(liveModels);

 const addedModels = liveModels.filter((m) => !stateSet.has(m));
 const removedModels = stateModels.filter((m) => !liveSet.has(m));
 const freeModelsChanged = addedModels.length > 0 || removedModels.length > 0;

 if (freeModelsChanged) {
  hasDrift = true;
  if (addedModels.length > 0) {
   summary.push(`Free models added: ${addedModels.map((m) => `\`${m}\``).join(", ")}`);
  }
  if (removedModels.length > 0) {
   summary.push(`Free models removed: ${removedModels.map((m) => `\`${m}\``).join(", ")}`);
  }
 }

 return {
  hasDrift,
  timestamp: new Date().toISOString(),
  release: {
   previous: previousRelease,
   current: currentRelease,
   changed: releaseChanged,
  },
  fileShas,
  staleFiles: Array.from(new Set([...(liveData.staleFiles || []), ...staleFiles])).sort(),
  sessionIdAffected,
  zenDocAffected,
  freeModels: {
   previous: stateModels,
   current: liveModels,
   added: addedModels,
   removed: removedModels,
   changed: freeModelsChanged,
  },
  freeModelCandidates: Array.from(new Set(liveData.freeModelCandidates || [])).sort(),
  summary,
 };
}

/**
 * Generate a Markdown report from a drift result.
 * @param {object} driftResult
 * @returns {string}
 */
export function generateDriftReport(driftResult) {
 const lines = [];

 if (driftResult.hasDrift) {
  lines.push("## 🚨 OpenCode Upstream Drift Detected");
  lines.push("");
  lines.push(`**Timestamp:** \`${driftResult.timestamp}\``);
  lines.push("");

  if (driftResult.sessionIdAffected) {
   lines.push("> ⚠️ **CRITICAL WARNING:** Upstream changes detected in `identifier.ts` or `session-id.ts`.");
   lines.push("> The OpenCode Zen free tier validates session format `ses_[0-9a-f]{12}[0-9A-Za-z]{14}`.");
   lines.push("> Session ID generator or authentication logic may require immediate updates in `pi-freeflow`.");
   lines.push("");
  }

  lines.push("### Summary of Changes");
  for (const item of driftResult.summary) {
   lines.push(`- ${item}`);
  }
  lines.push("");

  if (driftResult.release.changed) {
   lines.push("### Release Tag");
   lines.push(`- **Previous:** \`${driftResult.release.previous}\``);
   lines.push(`- **Current:** \`${driftResult.release.current}\``);
   lines.push("");
  }

  const changedFiles = Object.entries(driftResult.fileShas || {}).filter(([, v]) => v.changed);
  const staleFiles = driftResult.staleFiles || Object.entries(driftResult.fileShas || {}).filter(([, v]) => v.stale).map(([f]) => f);
  if (changedFiles.length > 0) {
   lines.push("### File SHA Changes");
   lines.push("| File | Previous SHA (first 10) | Current SHA (first 10) |");
   lines.push("| :--- | :--- | :--- |");
   for (const [file, info] of changedFiles) {
    const prev = info.previous ? info.previous.slice(0, 10) : "*(new)*";
    const curr = info.current ? info.current.slice(0, 10) : "*(deleted)*";
    lines.push(`| \`${file}\` | \`${prev}\` | \`${curr}\` |`);
   }
   lines.push("");
  }
  if (staleFiles.length > 0) {
   lines.push("### Stale Baselines (fetch failed, prior baseline kept)");
   for (const file of staleFiles) {
    lines.push(`- \`${file}\`: upstream fetch failed; baseline retained, not treated as drift.`);
   }
   lines.push("");
  }

  if (driftResult.freeModels.changed) {
   lines.push("### Free Model Changes");
   if (driftResult.freeModels.added.length > 0) {
    lines.push(`- **➕ Added Models (${driftResult.freeModels.added.length}):**`);
    for (const m of driftResult.freeModels.added) {
     lines.push(`  - \`${m}\``);
    }
   }
   if (driftResult.freeModels.removed.length > 0) {
    lines.push(`- **➖ Removed Models (${driftResult.freeModels.removed.length}):**`);
    for (const m of driftResult.freeModels.removed) {
     lines.push(`  - \`${m}\``);
    }
   }
   lines.push("");
  }
  const candidates = driftResult.freeModelCandidates || [];
  if (candidates.length > 0) {
   lines.push("### Free Model Candidates (needs review)");
   lines.push("Suffix-less model IDs with no free signal; never a silent miss:");
   for (const m of candidates) {
    lines.push(`- \`${m}\``);
   }
   lines.push("");
  }
  lines.push("### Recommended Actions");
  if (driftResult.sessionIdAffected) {
   lines.push("- [ ] Inspect `packages/schema/src/identifier.ts` and `session-id.ts` for format changes.");
  }
  if (driftResult.freeModels.added.length > 0) {
   lines.push("- [ ] Evaluate adding new free models to `src/models.ts` catalog.");
  }
  if (driftResult.freeModels.removed.length > 0) {
   lines.push("- [ ] Deprecate or remove dropped free models from active catalog.");
  }
  if (driftResult.zenDocAffected) {
   lines.push("- [ ] Verify Zen pricing and endpoint rate limits in `zen.mdx`.");
  }
  lines.push("- [ ] Run `pnpm test` to confirm test suite integrity.");
 } else {
  lines.push("## ✅ OpenCode Upstream Status: In Sync");
  lines.push("");
  lines.push(`**Timestamp:** \`${driftResult.timestamp}\``);
  lines.push("");
  lines.push(`- **Latest Release:** \`${driftResult.release.current || driftResult.release.previous}\``);
  lines.push(`- **Free Models Count:** \`${(driftResult.freeModels?.current || []).length}\``);
  lines.push("- **Schemas:** All monitored files match state baseline.");
  const staleFiles = driftResult.staleFiles || [];
  if (staleFiles.length > 0) {
   lines.push(`- **Stale Baselines:** \`${staleFiles.join("`, `")}\` (fetch failed, prior baseline kept).`);
  }
  const candidates = driftResult.freeModelCandidates || [];
  if (candidates.length > 0) {
   lines.push(`- **Candidates Needing Review:** \`${candidates.join("`, `")}\`.`);
  }
  lines.push("");
  lines.push("No drift detected.");
 }

 return lines.join("\n");
}

/**
 * Load state file.
 * @param {string} statePath
 * @returns {Promise<object>}
 */
export async function loadState(statePath) {
 const resolved = path.resolve(process.cwd(), statePath);
 let text;
 try {
  text = await fs.readFile(resolved, "utf8");
 } catch (err) {
  throw new StateError(`Cannot read state file ${statePath}: ${err.message}`);
 }
 let parsed;
 try {
  parsed = JSON.parse(text);
 } catch (err) {
  throw new StateError(`State file ${statePath} is not valid JSON: ${err.message}`);
 }
 const problems = [];
 if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) problems.push("root must be an object");
 else {
  if (typeof parsed.lastRelease !== "string") problems.push("lastRelease must be a string");
  if (!parsed.fileShas || typeof parsed.fileShas !== "object" || Array.isArray(parsed.fileShas)) problems.push("fileShas must be a record");
  if (!Array.isArray(parsed.freeModels)) problems.push("freeModels must be an array");
  if (typeof parsed.lastChecked !== "string") problems.push("lastChecked must be a string");
 }
 if (problems.length > 0) {
  throw new StateError(`State file ${statePath} failed shape validation: ${problems.join("; ")}`);
 }
 return parsed;
}

/**
 * Save state file.
 * @param {string} statePath
 * @param {object} state
 */
export async function saveState(statePath, state) {
 const resolved = path.resolve(process.cwd(), statePath);
 const content = JSON.stringify(state, null, 2) + "\n";
 const tmpPath = `${resolved}.tmp.${process.pid}`;
 await fs.writeFile(tmpPath, content, "utf8");
 await fs.rename(tmpPath, resolved);
}

/**
 * Update state object with live data.
 * @param {object} currentState
 * @param {object} liveData
 * @returns {object}
 */
export function updateStateWithLive(currentState, liveData) {
 const fileShas = { ...(currentState.fileShas || {}) };
 for (const [file, sha] of Object.entries(liveData.fileShas || {})) {
  if (typeof sha === "string" && sha.length > 0) fileShas[file] = sha;
 }
 return {
  lastRelease: liveData.latestRelease || currentState.lastRelease,
  fileShas,
  freeModels: Array.from(new Set(liveData.freeModels || currentState.freeModels || [])).sort(),
  lastChecked: new Date().toISOString(),
 };
}

/**
 * Collect live data from upstream.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function collectLiveData(options = {}) {
 const fetchFn = options.fetchFn || globalThis.fetch;
 const schemaConfig = options.schemaFiles || DEFAULT_CONFIG.schemaFiles;

 // 1. Latest release (throws -> caller takes the infra path)
 const latestRelease = await fetchLatestRelease({
  fetchFn,
  apiUrl: options.releaseApiUrl,
  atomUrl: options.releaseAtomUrl,
  githubToken: options.githubToken,
 });

 // 2. Schema files (fail-open per file: unknown marker, never an error string SHA)
 const fileShas = {};
 const fileFetchErrors = {};
 for (const [filename, urls] of Object.entries(schemaConfig)) {
  try {
   const res = await fetchFileSha(urls, { fetchFn });
   fileShas[filename] = res.sha;
  } catch (err) {
   fileShas[filename] = UNKNOWN_SHA;
   fileFetchErrors[filename] = err.message;
  }
 }

 // 3. Live free models (throws -> caller takes the infra path)
 const { models: freeModels, candidates: freeModelCandidates } = await fetchLiveFreeModels({
  fetchFn,
  url: options.modelsUrl,
 });

 return {
  latestRelease,
  fileShas,
  fileFetchErrors,
  freeModels,
  freeModelCandidates,
 };
}

/**
 * Generate a Markdown report for an infrastructure failure.
 * Infra failures are never classified as drift (exit 2, no issue filed).
 * @param {Error} error
 * @param {string} phase what was being attempted ("state" or "upstream")
 * @returns {string}
 */
export function generateInfraReport(error, phase) {
 const lines = [];
 lines.push("## ⚠️ OpenCode Watcher Infra Failure");
 lines.push("");
 lines.push(`**Timestamp:** \`${new Date().toISOString()}\``);
 lines.push("");
 lines.push(`- **Phase:** \`${phase}\``);
 lines.push(`- **Error:** \`${String(error?.message || error)}\``);
 lines.push("");
 lines.push("The watcher could not reach upstream or read its baseline. This is NOT drift:");
 lines.push("no drift issue will be filed for this run. Re-run on the next schedule.");
 return lines.join("\n");
}

/**
 * Main watch runner function.
 * @param {object} [options]
 * @returns {Promise<{ driftResult: object, reportMarkdown: string, updatedState?: object }>}
 */
export async function runWatch(options = {}) {
 const statePath = options.stateFile || DEFAULT_STATE_FILE;

 let currentState;
 try {
  currentState = await loadState(statePath);
 } catch (err) {
  const reportMarkdown = generateInfraReport(err, "state");
  if (options.output) {
   await fs.writeFile(path.resolve(process.cwd(), options.output), reportMarkdown, "utf8");
  }
  throw new InfraError(err.message, reportMarkdown);
 }

 let liveData;
 try {
  liveData = options.mockLiveData || (await collectLiveData(options));
 } catch (err) {
  const reportMarkdown = generateInfraReport(err, "upstream");
  if (options.output) {
   await fs.writeFile(path.resolve(process.cwd(), options.output), reportMarkdown, "utf8");
  }
  throw new InfraError(err.message, reportMarkdown);
 }
 const driftResult = detectDrift(currentState, liveData);
 const reportMarkdown = generateDriftReport(driftResult);

 let updatedState = null;
 if (options.update || (options.check && options.updateOnDrift && driftResult.hasDrift)) {
  updatedState = updateStateWithLive(currentState, liveData);
  await saveState(statePath, updatedState);
 }

 if (options.output) {
  const outPath = path.resolve(process.cwd(), options.output);
  await fs.writeFile(outPath, reportMarkdown, "utf8");
 }

 return {
  driftResult,
  reportMarkdown,
  updatedState,
  exitCode: driftResult.hasDrift ? 1 : 0,
 };
}

/**
 * CLI Entrypoint
 */
async function main() {
 const args = process.argv.slice(2);
 let check = false;
 let update = false;
 let json = false;
 let output = null;
 let stateFile = DEFAULT_STATE_FILE;

 for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--check") {
   check = true;
  } else if (arg === "--update") {
   update = true;
  } else if (arg === "--json") {
   json = true;
  } else if (arg === "--output" || arg === "--report") {
   output = args[++i];
  } else if (arg === "--state" || arg === "--state-file") {
   stateFile = args[++i];
  } else if (arg === "--help" || arg === "-h") {
   console.log(`OpenCode Zen Free-Tier & Schema Watcher

Usage: node scripts/opencode-watch.mjs [flags]

Flags:
  --check       Dry-run / check mode; exits 1 if drift detected.
  --update      Updates the state file with live data.
  --json        Emits structured JSON drift report to stdout.
  --output <f>  Writes markdown drift report to specified file.
  --state <f>   Overrides path to state file (default: ${DEFAULT_STATE_FILE}).
  --help        Show this help message.
`);
   process.exit(0);
  }
 }

 try {
  const { driftResult, reportMarkdown } = await runWatch({
   check,
   update,
   output,
   stateFile,
  });

  if (json) {
   console.log(JSON.stringify(driftResult, null, 2));
  } else {
   console.log(reportMarkdown);
  }

  if (check && driftResult.hasDrift) {
   process.exit(1);
  }
 } catch (err) {
  if (err instanceof InfraError && err.reportMarkdown) {
   console.error(err.reportMarkdown);
  } else {
   console.error(`Error in opencode-watch: ${err.message}`);
  }
  process.exit(err instanceof InfraError && err.exitCode ? err.exitCode : 2);
 }
}

// Execute CLI if run directly
const isDirectCall =
 process.argv[1] &&
 (process.argv[1].endsWith("opencode-watch.mjs") ||
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])));

if (isDirectCall) {
 main();
}
