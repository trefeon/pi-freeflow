#!/usr/bin/env node
/**
 * Verify the package.json version is published on npm AND that the published
 * tarball matches this tree, file for file.
 * Usage: node scripts/verify-published-tarball.mjs [version]
 *
 * Used by CI on tag pushes; runnable on Windows Git Bash and Linux. Exits 0
 * only on a full content match: CRLF-vs-LF differences are a note, never a
 * mismatch (core.autocrlf=input makes both spellings the same content).
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = "pi-freeflow";
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
 const json = result.stdout?.slice(result.stdout.indexOf("["), result.stdout.lastIndexOf("]") + 1);
 try {
  const files = result.status === 0 ? JSON.parse(json)?.[0]?.files : null;
  return Array.isArray(files) ? files.map((file) => file.path).filter((p) => typeof p === "string") : null;
 } catch {
  return null;
 }
}

/** Compare one published file against its counterpart in this tree. */
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
 const version = process.argv[2] ?? pkg.version;
 const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-tarball-"));

 try {
  const pack = runNpm(
   ["pack", `${PACKAGE_NAME}@${version}`, "--pack-destination", tmpDir, "--silent"],
   { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const packed = (await fs.readdir(tmpDir)).filter((name) => name.endsWith(".tgz"));
  if (pack.status !== 0 || packed.length === 0) {
   console.error(`${PACKAGE_NAME}@${version} is not published (or npm pack failed)`);
   const detail = `${pack.stderr ?? ""}`.trim().split("\n").filter(Boolean)[0];
   if (detail) console.error(`  ${detail}`);
   return 1;
  }

  const extractDir = "extract";
  await fs.mkdir(path.join(tmpDir, extractDir));
  // GNU tar reads "C:\..." as a remote host, so hand it relative paths only.
  const untar = spawnSync("tar", ["-xzf", packed[0], "-C", extractDir], { cwd: tmpDir, encoding: "utf8" });
  if (untar.status !== 0) {
   console.error(`failed to extract ${packed[0]}: ${(untar.stderr ?? "").trim()}`);
   return 1;
  }

  const published = await walk(path.join(tmpDir, extractDir, "package"));
  const mismatches = [];
  const eolOnly = [];
  for (const file of published) await compareFile(file, mismatches, eolOnly);

  const local = localFileList();
  if (local === null) {
   console.error("failed to list the files this tree would ship (npm pack --dry-run --json)");
   return 1;
  }
  const publishedPaths = new Set(published.map((file) => file.relative));
  for (const relative of local) {
   if (!publishedPaths.has(relative)) mismatches.push(`missing-from-tarball ${relative}`);
  }

  if (eolOnly.length > 0) {
   console.log(`note: ${eolOnly.length} file(s) differ only by line endings: ${eolOnly.join(", ")}`);
  }
  console.log(
   `published tarball ${PACKAGE_NAME}@${version}: ${published.length} files, ${mismatches.length} mismatches`,
  );
  for (const line of mismatches.slice(0, MAX_LINES)) console.error(`  ${line}`);
  if (mismatches.length > MAX_LINES) console.error(`  … and ${mismatches.length - MAX_LINES} more`);
  return mismatches.length === 0 ? 0 : 1;
 } finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
 }
}

process.exitCode = await main();
