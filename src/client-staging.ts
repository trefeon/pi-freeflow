/**
 * Runtime resolution and source materialization for pi-freeflow daemon.
 *
 * Handles discovery of Node/Bun runtimes and out-of-node_modules source staging
 * required for Node's --experimental-strip-types execution.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_RUNTIME_ENV, resolveDaemonSrcCacheDir } from "./config.ts";
import { logInfo, logWarn } from "./logger.ts";

export interface DaemonRuntime {
 execPath: string;
 args: string[];
 runtimeType: "bun" | "node";
}

/**
 * Detect whether an executable path is a JavaScript/TypeScript runtime (bun or node).
 * Rejects host binaries like omp, pi, electron, code, etc.
 */
export function isJsRuntimeExecutable(execPath: string): "bun" | "node" | null {
 if (!execPath || typeof execPath !== "string") return null;
 const checkName = (target: string): "bun" | "node" | null => {
  const base = path.basename(target.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/i, "");
  if (base === "bun" || base === "bunx") return "bun";
  if (base === "node" || base === "nodejs") return "node";
  return null;
 };

 const direct = checkName(execPath);
 if (direct) return direct;

 try {
  const real = fs.realpathSync(execPath);
  const realMatch = checkName(real);
  if (realMatch) return realMatch;
 } catch { }

 return null;
}

/**
 * Search directories in PATH for an executable matching name.
 * On Windows, tests extensions from PATHEXT (.exe, .cmd, .bat).
 * On POSIX, checks file existence and executable bit (X_OK).
 */
export function findExecutableOnPath(
 name: string,
 envPath: string = process.env.PATH || process.env.Path || "",
): string | null {
 if (!envPath || typeof envPath !== "string") return null;
 const dirs = envPath.split(path.delimiter).filter(Boolean);
 const hasExt = path.extname(name).length > 0;
 const extensions = process.platform === "win32"
  ? (hasExt ? [""] : (process.env.PATHEXT ? process.env.PATHEXT.split(";").filter(Boolean) : [".exe", ".cmd", ".bat"]))
  : [""];

 for (const dir of dirs) {
  for (const ext of extensions) {
   const candidate = ext ? path.join(dir, `${name}${ext}`) : path.join(dir, name);
   try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
     if (process.platform !== "win32") {
      fs.accessSync(candidate, fs.constants.X_OK);
     }
     return candidate;
    }
   } catch { }
  }
 }
 return null;
}

/**
 * Resolve the executable and arguments needed to run src/daemon.ts.
 *
 * Priority order:
 * 1. Explicit override via opts.overrideExecPath or PI_FREEFLOW_DAEMON_RUNTIME env var.
 * 2. Current process.execPath (if and only if it is actually a node or bun executable).
 * 3. Search PATH for `bun` (preferred: native TypeScript support with zero flags).
 * 4. Search PATH for `node` (Node.js >= 22.6 with --experimental-strip-types).
 *
 * Returns null if no valid runtime is found (e.g. running as a standalone `omp` binary
 * without bun or node on PATH). The caller MUST fall back to an in-process proxy rather
 * than spawning an arbitrary binary (which would cause recursive agent fork-bombs).
 */
export function resolveDaemonRuntime(opts?: {
 overrideExecPath?: string;
 scriptPath?: string;
 envPath?: string;
 currentExecPath?: string;
}): DaemonRuntime | null {
 const script = opts?.scriptPath ?? daemonScriptPath();
 const envExec = opts?.overrideExecPath ?? (typeof process.env[DAEMON_RUNTIME_ENV] === "string" ? process.env[DAEMON_RUNTIME_ENV]?.trim() : undefined);

 // 1. Explicit override
 if (envExec) {
  const type = isJsRuntimeExecutable(envExec) ?? "node";
  const args = type === "bun" ? [script] : ["--experimental-strip-types", script];
  return { execPath: envExec, args, runtimeType: type };
 }

 // 2. Check current process.execPath
 const currentExec = opts?.currentExecPath ?? process.execPath;
 const currentType = isJsRuntimeExecutable(currentExec);
 if (currentType !== null) {
  const args = currentType === "bun" ? [script] : ["--experimental-strip-types", script];
  return { execPath: currentExec, args, runtimeType: currentType };
 }

 // 3. Current executable is not a JS runtime (e.g. omp, pi, electron).
 // Search PATH for bun first, then node.
 const pathVal = opts?.envPath ?? process.env.PATH ?? process.env.Path ?? "";

 const bunOnPath = findExecutableOnPath("bun", pathVal);
 if (bunOnPath) {
  return { execPath: bunOnPath, args: [script], runtimeType: "bun" };
 }

 const nodeOnPath = findExecutableOnPath("node", pathVal);
 if (nodeOnPath) {
  return {
   execPath: nodeOnPath,
   args: ["--experimental-strip-types", script],
   runtimeType: "node",
  };
 }

 return null;
}

export function daemonScriptPath(): string {
 const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts");
 return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

/** True when any path segment of `filePath` is `node_modules`. Node refuses to
 * strip types for files under such a path (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * so a Node-spawned daemon must run from a staged copy elsewhere. */
export function isUnderNodeModules(filePath: string): boolean {
 return filePath.split(/[\\/]/).includes("node_modules");
}

export function readPackageJsonObject(dir: string): Record<string, unknown> | null {
 try {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
 } catch {
  return null;
 }
}

/** Resolve a dependency's package directory the way Node would: walk up the
 *  node_modules chain from the importing package's root. */
export function resolvePackageDir(name: string, fromDir: string): string | null {
 let dir = fromDir;
 for (; ;) {
  const pkgJson = path.join(dir, "node_modules", name, "package.json");
  if (fs.existsSync(pkgJson)) return path.dirname(pkgJson);
  const parent = path.dirname(dir);
  if (parent === dir) return null;
  dir = parent;
 }
}

/** Link (or copy, when linking is unavailable) each runtime dependency beside
 *  the staged sources so bare imports such as `undici` still resolve. */
export function stageRuntimeDependencies(pkgRoot: string, pkgJson: Record<string, unknown>, stagedDir: string): void {
 const deps = pkgJson.dependencies;
 if (!deps || typeof deps !== "object") return;
 const nodeModulesDir = path.join(stagedDir, "node_modules");
 for (const name of Object.keys(deps as Record<string, unknown>)) {
  const target = resolvePackageDir(name, pkgRoot);
  if (target === null) {
   logWarn("daemon dependency not found for staging", { dependency: name });
   continue;
  }
  try {
   fs.mkdirSync(nodeModulesDir, { recursive: true });
   // Junction on Windows (no elevated privileges needed); dir symlink elsewhere.
   fs.symlinkSync(target, path.join(nodeModulesDir, name), process.platform === "win32" ? "junction" : "dir");
  } catch {
   try {
    fs.cpSync(target, path.join(nodeModulesDir, name), { recursive: true, dereference: true });
   } catch (e) {
    logWarn("daemon dependency staging failed", { dependency: name, error: String(e) });
   }
  }
 }
}

/** Best-effort prune of staged daemon sources from earlier versions (1 day TTL). */
export function pruneStaleDaemonSrcDirs(root: string, currentVersion: string): void {
 try {
  const now = Date.now();
  for (const entry of fs.readdirSync(root)) {
   if (entry === currentVersion) continue;
   const full = path.join(root, entry);
   try {
    if (now - fs.statSync(full).mtimeMs > 24 * 60 * 60 * 1000) {
     fs.rmSync(full, { recursive: true, force: true });
    }
   } catch { }
  }
 } catch { }
}

/**
 * Materialize the daemon's sources outside node_modules so a Node runtime can
 * execute `src/daemon.ts` (Node refuses type stripping for any file under a
 * node_modules path, and this package ships TypeScript sources). Copies
 * `src/` + `package.json` into a per-version cache directory, stages the
 * runtime dependencies beside them, and returns the staged daemon entry.
 * Returns the input path unchanged when the script is already outside
 * node_modules (dev checkouts) or the package root is unreadable.
 */
export function materializeDaemonSources(scriptPath: string, cacheDir?: string): string {
 if (!isUnderNodeModules(scriptPath)) return scriptPath;
 const pkgRoot = path.dirname(path.dirname(scriptPath));
 const pkgJson = readPackageJsonObject(pkgRoot);
 const version = pkgJson !== null && typeof pkgJson.version === "string" ? pkgJson.version : "";
 if (pkgJson === null || !version) return scriptPath;

 const root = cacheDir ?? resolveDaemonSrcCacheDir();
 const finalDir = path.join(root, version);
 const finalEntry = path.join(finalDir, "src", "daemon.ts");
 if (fs.existsSync(finalEntry) && fs.existsSync(path.join(finalDir, "package.json"))) {
  pruneStaleDaemonSrcDirs(root, version);
  return finalEntry;
 }

 const tmpDir = `${finalDir}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
 try {
  fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  fs.cpSync(path.join(pkgRoot, "src"), path.join(tmpDir, "src"), { recursive: true });
  fs.copyFileSync(path.join(pkgRoot, "package.json"), path.join(tmpDir, "package.json"));
  stageRuntimeDependencies(pkgRoot, pkgJson, tmpDir);
  try {
   fs.renameSync(tmpDir, finalDir);
   logInfo(`staged proxy daemon sources outside node_modules at ${finalDir}`);
  } catch (e) {
   // A concurrent starter won the rename (or the dir appeared meanwhile):
   // its copy is byte-identical for the same version, so reuse it.
   try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
   } catch { }
   if (!fs.existsSync(finalEntry)) {
    logWarn("daemon source staging failed", { error: String(e), dir: finalDir });
    return scriptPath;
   }
  }
 } catch (e) {
  try {
   fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { }
  logWarn("daemon source staging failed — spawning from the installed path", { error: String(e), dir: tmpDir });
  return scriptPath;
 }
 pruneStaleDaemonSrcDirs(root, version);
 return finalEntry;
}
