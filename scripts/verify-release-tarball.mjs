#!/usr/bin/env node
/**
 * Verify the release tarball that CI attaches to the GitHub release.
 *
 * The tarball is the install artifact: every host plugin manager and every
 * npm/bun global install takes its URL, so it must carry exactly the files
 * this tree ships — no test files, no changesets — under the exact name the
 * download URL is built from.
 *
 * Usage: node scripts/verify-release-tarball.mjs
 *
 * Packs the checkout into dist/ and compares the result against the tree.
 * Exits 0 only on a full content match: a CRLF-vs-LF difference is a note,
 * never a mismatch (core.autocrlf=input makes both spellings the same
 * content). Runnable on Windows Git Bash and Linux.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = "pi-freeflow";
const DIST_DIR = path.join(REPO_ROOT, "dist");
const MAX_LINES = 25;
const IS_WINDOWS = process.platform === "win32";

const short = (hash) => (typeof hash === "string" ? hash.slice(0, 8) : "(none)");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** CRLF/CR -> LF for text files; binary files (containing NUL) stay untouched. */
function normalizeEol(buffer) {
 if (buffer.includes(0)) return buffer;
 return Buffer.from(buffer.toString("binary").replace(/\r\n?/g, "\n"), "binary");
}

/** npm is npm.cmd on Windows: one command string keeps the shell off DEP0190. */
function runNpm(args, options) {
 if (!IS_WINDOWS) return spawnSync("npm", args, options);
 const command = ["npm", ...args.map((a) => (a.includes(" ") ? `"${a}"` : a))].join(" ");
 return spawnSync(command, { ...options, shell: true });
}

async function walk(dir, prefix = "") {
 const out = [];
 for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
  const absolute = path.join(dir, entry.name);
  if (entry.isDirectory()) out.push(...(await walk(absolute, relative)));
  else if (entry.isFile()) out.push({ relative, absolute });
 }
 return out;
}

/** The files this tree would ship, as npm computes them; null if npm failed. */
function localFileList() {
 const result = runNpm(["pack", "--dry-run", "--json"], { cwd: REPO_ROOT, encoding: "utf8" });
 try {
  if (result.status !== 0) return null;
  const out = `${result.stdout ?? ""}`;
  // npm emits either an array of pack results or an object keyed by package
  // name, depending on version; take the first `{`/`[` and the last closer.
  const start = out.search(/[[{]/);
  const end = Math.max(out.lastIndexOf("}"), out.lastIndexOf("]"));
  if (start === -1 || end <= start) return null;
  const parsed = JSON.parse(out.slice(start, end + 1));
  const entry = Array.isArray(parsed) ? parsed[0] : (parsed[PACKAGE_NAME] ?? Object.values(parsed)[0]);
  const files = entry?.files;
  return Array.isArray(files) ? files.map((file) => file.path).filter((p) => typeof p === "string") : null;
 } catch {
  return null;
 }
}

/**
 * Mismatch lines for the tree-vs-tarball comparison, in BOTH directions:
 * a file this tree would ship but the tarball lacks, and — the direction the
 * first release gate missed — a file the tarball carries that this tree does
 * not (a tarball packed from a newer or dirty tree).
 * Exported so the focused test drives the shipped comparison, not a copy.
 */
export function compareFileLists(localFiles, publishedFiles) {
 const local = new Set(localFiles);
 const published = new Set(publishedFiles);
 const lines = [];
 for (const file of local) {
  if (!published.has(file)) lines.push(`missing-from-tarball ${file}`);
 }
 for (const file of published) {
  if (!local.has(file)) lines.push(`not-in-tree          ${file}`);
 }
 return lines;
}

/** Compare one tarball file against its counterpart in this tree. */
async function compareFile(published, mismatches, eolOnly) {
 const repoBytes = await fs.readFile(path.join(REPO_ROOT, published.relative)).catch(() => null);
 if (repoBytes === null) {
  mismatches.push(`missing-in-repo      ${published.relative}`);
  return;
 }
 const tarballBytes = await fs.readFile(published.absolute);
 const tarballHash = sha256(tarballBytes);
 const repoHash = sha256(repoBytes);
 if (tarballHash === repoHash) return;
 if (sha256(normalizeEol(tarballBytes)) === sha256(normalizeEol(repoBytes))) {
  eolOnly.push(published.relative);
  return;
 }
 mismatches.push(
  `content-differs      ${published.relative} (tarball ${short(tarballHash)} != repo ${short(repoHash)})`,
 );
}

async function main() {
 const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
 const version = pkg.version;
 const expectedName = `${PACKAGE_NAME}-${version}.tgz`;

 try {
  // Start from an empty dist/ so a stale tarball from an earlier version
  // cannot be attached in place of this one.
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });
  const pack = runNpm(["pack", "--pack-destination", DIST_DIR, "--silent"], {
   cwd: REPO_ROOT,
   encoding: "utf8",
  });
  const packed = (await fs.readdir(DIST_DIR)).filter((name) => name.endsWith(".tgz"));
  if (pack.status !== 0 || packed.length !== 1) {
   console.error("npm pack did not produce exactly one tarball");
   const detail = `${pack.stderr ?? ""}`.trim().split("\n").filter(Boolean)[0];
   if (detail) console.error(`  ${detail}`);
   return 1;
  }
  if (packed[0] !== expectedName) {
   console.error(
    `release asset ${packed[0]} does not match ${expectedName} — the install URL is built from that name`,
   );
   return 1;
  }

  const tarballPath = path.join(DIST_DIR, packed[0]);
  const extractDir = "extract";
  await fs.mkdir(path.join(DIST_DIR, extractDir));
  // GNU tar reads "C:\..." as a remote host, so hand it relative paths only.
  const untar = spawnSync("tar", ["-xzf", packed[0], "-C", extractDir], { cwd: DIST_DIR, encoding: "utf8" });
  if (untar.status !== 0) {
   console.error(`failed to extract ${packed[0]}: ${(untar.stderr ?? "").trim()}`);
   return 1;
  }

  const published = await walk(path.join(DIST_DIR, extractDir, "package"));
  const mismatches = [];
  const eolOnly = [];
  for (const file of published) await compareFile(file, mismatches, eolOnly);

  const local = localFileList();
  if (local === null) {
   console.error("failed to list the files this tree would ship (npm pack --dry-run --json)");
   return 1;
  }
  mismatches.push(...compareFileLists(local, published.map((file) => file.relative)));

  // The asset must be the package it claims to be: an install of it reports
  // this version, and the updater compares that against the release tag.
  const packagedRaw = await fs
   .readFile(path.join(DIST_DIR, extractDir, "package", "package.json"), "utf8")
   .catch(() => null);
  const packagedVersion = packagedRaw === null ? null : JSON.parse(packagedRaw).version;
  if (packagedVersion !== version) {
   mismatches.push(`tarball-version      ${String(packagedVersion)} != package.json ${version}`);
  }

  if (eolOnly.length > 0) {
   console.log(`note: ${eolOnly.length} file(s) differ only by line endings: ${eolOnly.join(", ")}`);
  }
  // A version-free twin lets install docs and users take the stable
  // `releases/latest/download/pi-freeflow.tgz` permalink.
  const stablePath = path.join(DIST_DIR, `${PACKAGE_NAME}.tgz`);
  await fs.copyFile(tarballPath, stablePath);
  const tarballBytes = await fs.readFile(tarballPath);
  console.log(
   `release tarball ${PACKAGE_NAME}@${version}: ${published.length} files, ${mismatches.length} mismatches`,
  );
  console.log(`asset ${path.relative(REPO_ROOT, tarballPath).split(path.sep).join("/")} sha256 ${sha256(tarballBytes)}`);
  console.log(`asset ${path.relative(REPO_ROOT, stablePath).split(path.sep).join("/")} (latest permalink)`);
  for (const line of mismatches.slice(0, MAX_LINES)) console.error(`  ${line}`);
  if (mismatches.length > MAX_LINES) console.error(`  … and ${mismatches.length - MAX_LINES} more`);
  return mismatches.length === 0 ? 0 : 1;
 } finally {
  await fs.rm(path.join(DIST_DIR, "extract"), { recursive: true, force: true });
 }
}

// Execute only as a CLI, so the focused test can import compareFileLists
// without packing the release tarball.
const isDirectCall =
 process.argv[1] &&
 (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith("verify-release-tarball.mjs"));

if (isDirectCall) {
 process.exitCode = await main();
}
