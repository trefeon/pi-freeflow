/**
 * Port inspection, holder classification, and daemon process management.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import net from "node:net";
import { DEFAULT_PORT, HOST } from "./config.ts";
import { isDaemonIdentityBody } from "./health.ts";
import type { DaemonHealthSnapshot } from "./health.ts";
import { tokenAuthHeaders } from "./token.ts";
import { log } from "./logger.ts";

const DIGITS_ONLY_RE = /^\d+$/;
const SOCKET_INODE_RE = /^socket:\[(\d+)\]$/;

/**
 * True when a pi-freeflow daemon answers on `port`.
 *
 * Uses the unauthenticated `GET /health` identity shape (service + the port it
 * is bound to) instead of "any 200 with JSON": a stranger bound to the port
 * cannot claim those fields, and this probe runs before the client has a token
 * to prove ownership with.
 */
export async function isProxyAlive(port: number, timeoutMs = 600): Promise<boolean> {
 if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
 try {
  const res = await fetch(`http://${HOST}:${port}/health`, {
   signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return false;
  return isDaemonIdentityBody(port, await res.json());
 } catch {
  return false;
 }
}

/**
 * True when a TCP connection to the loopback port succeeds — something holds
 * the port (our daemon, a stale daemon, or an unrelated process). A free port
 * refuses the connection immediately; the dark-holder reclaim path uses this
 * to tell "nothing bound" apart from "bound but unresponsive" (issue #52: the
 * blind kill-and-poll cost ~2s on every cold start).
 */
export async function isPortBound(port: number, timeoutMs = 250): Promise<boolean> {
 if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
 const { promise, resolve } = Promise.withResolvers<boolean>();
 const socket = net.connect({ host: HOST, port });
 let settled = false;
 const settle = (value: boolean): void => {
  if (settled) return;
  settled = true;
  socket.destroy();
  resolve(value);
 };
 socket.setTimeout(timeoutMs, () => settle(false));
 socket.once("connect", () => settle(true));
 socket.once("error", () => settle(false));
 return await promise;
}

let activeRequests = 0;

/** Current in-flight proxied requests (guard for stale-daemon replacement). */
export function getActiveRequests(): number {
 return activeRequests;
}

export function incrementActiveRequests(): void {
 activeRequests += 1;
}

export function decrementActiveRequests(): void {
 activeRequests -= 1;
}

/**
 * Fetch the full health snapshot from a running daemon.
 * `activeRequests` is undefined on daemons older than the busy-tracking
 * feature (1.9.0) — callers treat that as "cannot verify usage".
 * `sseDegraded`/`sseRate`/`lastBytesAt` are undefined on daemons older than
 * the failed-SSE window — callers treat missing as "not degraded".
 */
export async function getDaemonHealth(
 port: number,
): Promise<DaemonHealthSnapshot> {
 if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
 try {
  const res = await fetch(`http://${HOST}:${port}/_health`, {
   signal: AbortSignal.timeout(2500),
   headers: tokenAuthHeaders(),
  });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (data && typeof data === "object") {
   const v =
    "version" in data && typeof data.version === "string" && data.version
     ? data.version
     : "";
   const ar = "activeRequests" in data ? data.activeRequests : undefined;
   const sr = "sseRate" in data ? data.sseRate : undefined;
   const sd = "sseDegraded" in data ? data.sseDegraded : undefined;
   const lb = "lastBytesAt" in data ? data.lastBytesAt : undefined;
   let zt: DaemonHealthSnapshot extends null ? never : NonNullable<DaemonHealthSnapshot>["zenTransport"] = undefined;
   if ("zenTransport" in data && typeof data.zenTransport === "object" && data.zenTransport !== null) {
    const rawZt = data.zenTransport as Record<string, unknown>;
    if (
     (rawZt.mode === "node" || rawZt.mode === "bun-sidecar") &&
     (typeof rawZt.bunVersion === "string" || rawZt.bunVersion === null) &&
     typeof rawZt.reason === "string"
    ) {
     zt = {
      mode: rawZt.mode,
      bunVersion: rawZt.bunVersion,
      reason: rawZt.reason,
     };
    }
   }
   return {
    version: v,
    activeRequests: typeof ar === "number" ? ar : undefined,
    sseRate: typeof sr === "number" ? sr : undefined,
    sseDegraded: typeof sd === "boolean" ? sd : undefined,
    lastBytesAt: typeof lb === "number" ? lb : undefined,
    zenTransport: zt,
   };
  }
  return null;
 } catch {
  return null;
 }
}

/** Version of the daemon on `port`; "" when alive but pre-version-field, null when not alive. */
export async function getDaemonVersion(port: number): Promise<string | null> {
 const h = await getDaemonHealth(port);
 return h ? h.version : null;
}

/**
 * Linux fallback when neither lsof nor fuser exists: resolve the LISTEN
 * socket inode for `port` via /proc/net/tcp{,6}, then find the owning pid by
 * scanning /proc fds. Dependency-free, same-user only, never self-kills.
 */
export function killViaProcNet(port: number): boolean {
 if (process.platform !== "linux") return false;
 try {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
   let text = "";
   try {
    text = fs.readFileSync(table, "utf8");
   } catch {
    continue;
   }
   for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const addr = cols[1].split(":");
    if (addr.length !== 2 || addr[1].toUpperCase() !== hexPort) continue;
    if (cols[3] !== "0A") continue; // LISTEN only
    inodes.add(cols[9]);
   }
  }
  if (inodes.size === 0) return false;
  for (const pid of fs.readdirSync("/proc")) {
   if (!DIGITS_ONLY_RE.test(pid) || Number(pid) === process.pid) continue;
   let fds: string[];
   try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
   } catch {
    continue;
   }
   for (const fd of fds) {
    let link = "";
    try {
     link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
     continue;
    }
    const sock = link.match(SOCKET_INODE_RE);
    if (sock && inodes.has(sock[1])) {
     try {
      process.kill(Number(pid), "SIGKILL");
      return true;
     } catch {
      return false;
     }
    }
   }
  }
 } catch { }
 return false;
}

/** What answers `GET /health` on a loopback port (see probePortHolder). */
export type PortHolderVerdict = "ours" | "foreign" | "silent" | "free";

/** Walk the undici cause chain for an ECONNREFUSED on the loopback probe. */
function isRefusedConnect(err: unknown): boolean {
 let cur: unknown = err;
 for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth++) {
  if ("code" in cur && typeof cur.code === "string" && cur.code === "ECONNREFUSED") return true;
  cur = "cause" in cur ? cur.cause : undefined;
 }
 return false;
}

/**
 * Classify whatever holds `port` before any kill. `ours` means the
 * unauthenticated identity probe answered with this daemon's service and the
 * port it is bound to; `foreign` means something answered HTTP but is not a
 * pi-freeflow daemon; `silent` means the TCP connection was accepted but no
 * HTTP answer arrived in the budget (a wedged daemon or a non-HTTP listener);
 * `free` means the connection was refused.
 */
export async function probePortHolder(port: number, timeoutMs = 600): Promise<PortHolderVerdict> {
 try {
  const res = await fetch(`http://${HOST}:${port}/health`, {
   signal: AbortSignal.timeout(timeoutMs),
  });
  const body: unknown = await res.json().catch(() => null);
  return isDaemonIdentityBody(port, body) ? "ours" : "foreign";
 } catch (e) {
  return isRefusedConnect(e) ? "free" : "silent";
 }
}

export async function killPortHolder(port: number): Promise<boolean> {
 if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
 // Test-safety net: `node --test <file>` without test/setup.mjs runs on the
 // real default port and would otherwise reap the developer's live daemon.
 if (port === DEFAULT_PORT && process.env.NODE_TEST_CONTEXT) {
  log("warn", `refusing to kill the default port :${port} from the test runner — run the suite via test/setup.mjs`);
  return false;
 }
 // Never kill an identified process: probe first, and only a holder that
 // claims (or cannot deny) being this daemon may be dislodged.
 const holder = await probePortHolder(port);
 if (holder === "free") return true;
 if (holder === "foreign") {
  log("warn", `refusing to kill :${port} — it answers /health as a foreign service, not a pi-freeflow daemon`);
  return false;
 }
 const auth = tokenAuthHeaders();
 try {
  try {
   await fetch(`http://${HOST}:${port}/_shutdown`, {
    method: "POST",
    headers: auth,
    signal: AbortSignal.timeout(300),
   });
   for (let i = 0; i < 6; i++) {
    await new Promise<void>((r) => setTimeout(r, 50));
    if (!(await isProxyAlive(port))) return true;
   }
  } catch { }
  if (process.platform === "win32") {
   let killed = false;
   const tryTaskkillPid = (rawPid: string | undefined): void => {
    const pid = rawPid?.trim();
    if (!pid || !DIGITS_ONLY_RE.test(pid)) return;
    const num = Number(pid);
    if (num <= 4 || num === process.pid) return; // never kill system/idle (0/4) or self
    try {
     execSync(`taskkill /F /T /PID ${pid}`, { timeout: 3000, stdio: "ignore", windowsHide: true });
     killed = true;
    } catch { }
   };
   try {
    const out = execSync(`netstat -ano | findstr :${port}`, {
     encoding: "utf8",
     timeout: 3000,
     windowsHide: true,
    }) as string;
    for (const line of out.split("\n")) {
     const parts = line.trim().split(/\s+/);
     if (!line.includes("LISTENING") && !(parts[0]?.toUpperCase() === "TCP" && (parts[2] === "0.0.0.0:0" || parts[2] === "[::]:0"))) continue;
     if (!parts[1] || !parts[1].endsWith(`:${port}`)) continue;
     tryTaskkillPid(parts[parts.length - 1]);
    }
   } catch { }
   if (!killed) {
    // Windows 11 24H2+ (build 26300+) can report Bound TCP listeners with
    // PID 0 or omit them from netstat -ano; Get-NetTCPConnection still
    // resolves the owning process id reliably.
    try {
     const psOut = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
      { encoding: "utf8", timeout: 5000, windowsHide: true },
     ) as string;
     for (const line of psOut.split(/\r?\n/)) {
      tryTaskkillPid(line);
     }
    } catch { }
   }
   return killed;
  }
  try {
   const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || fuser -n tcp ${port} 2>/dev/null`, {
    encoding: "utf8",
    timeout: 3000,
   }) as string;
   const pids = out.trim().split(/\s+/).filter((p) => DIGITS_ONLY_RE.test(p) && Number(p) !== process.pid);
   // lsof matches both ends of a connection: our own recent probe socket
   // (TIME_WAIT) can sort first, so skip self instead of taking [0].
   if (pids.length === 0) return killViaProcNet(port);
   execSync(`kill -9 ${pids[0]}`, { timeout: 3000, stdio: "ignore" });
   return true;
  } catch {
   return killViaProcNet(port);
  }
 } catch {
  return false;
 }
}
