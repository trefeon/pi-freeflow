/**
 * Client lease registry for the detached pi-freeflow proxy daemon.
 *
 * Each OMP/Pi session is a client that registers a lease and renews it with a
 * heartbeat while alive. The daemon drops expired leases and retires itself
 * once NO client holds a live lease: the empty state must persist for the
 * grace window (a fresh spawn's clients re-attach within seconds) with
 * nothing in flight. Request-idleness alone NEVER retires the daemon.
 *
 * The request-touch (`lastActivityAt`) is still recorded and surfaced in
 * /_health for observability, but it no longer gates retirement.
 */

interface LeaseOptions {
 /** Lease lifetime (ms); a client that misses ~3 beats is dropped. */
 ttlMs: number;
 /** GC sweep interval (ms). */
 gcMs: number;
 /** Zero-lease persistence window (ms): how long leases must stay empty before a lease-less daemon exits. */
 graceMs: number;
 /** Current in-flight proxied requests — daemon never exits mid-stream. */
 getActiveRequests: () => number;
 /** Called once when the daemon should retire (close server + exit). */
 onIdle: () => void;
}

const leases = new Map<string, number>();
let lastActivityAt = 0;
let gcTimer: ReturnType<typeof setInterval> | null = null;
/** First sweep timestamp at which leases were observed empty; null while any lease exists. */
let emptySince: number | null = null;

/**
 * Hard caps on the attach registry: `POST /_client/attach` is reachable by any
 * local process holding the proxy token, so an unbounded id/size turns the
 * snapshot that /_health publishes into a memory and log-growth vector.
 */
export const MAX_CLIENT_ID_LENGTH = 256;
export const MAX_CLIENTS = 64;

/** Register/refresh verdict: "full" must be answered with HTTP 429. */
type RegisterClientResult = "ok" | "invalid" | "full";

/**
 * Register or refresh a client lease. Refreshing a known id never hits the
 * cap; a new id does, and the caller answers 429 instead of growing the map.
 * Rejected ids are not stored, so expiry/GC behavior is unchanged.
 * Surrounding whitespace is trimmed so " abc " and "abc" share one lease and
 * a blank id can never occupy a slot toward MAX_CLIENTS.
 */
export function registerClient(clientId: string): RegisterClientResult {
 if (typeof clientId !== "string") return "invalid";
 const id = clientId.trim();
 if (id.length === 0 || id.length > MAX_CLIENT_ID_LENGTH) return "invalid";
 if (!leases.has(id) && leases.size >= MAX_CLIENTS) return "full";
 leases.set(id, Date.now());
 return "ok";
}

/** Renew an existing client lease. Returns false when the id is unknown (daemon restarted). */
export function renewClient(clientId: string): boolean {
 if (leases.has(clientId)) {
  leases.set(clientId, Date.now());
  return true;
 }
 return false;
}

/** Remove a client lease (graceful detach on session end). */
export function unregisterClient(clientId: string): void {
 leases.delete(clientId);
}

/** Number of clients holding a live lease. */
export function getLeaseCount(): number {
 return leases.size;
}

/** Snapshot of live client leases (id -> lastSeenAt) for health/debugging. */
export function getLeaseSnapshot(): Record<string, number> {
 return Object.fromEntries(leases);
}

/** Record proxy activity — any proxied request counts as a live user. */
export function touchActivity(): void {
 lastActivityAt = Date.now();
}

/** Timestamp of the last proxied request (0 = never; daemon inits at bind). */
export function getLastActivityAt(): number {
 return lastActivityAt;
}

/**
 * Start the lease GC sweep. Prunes expired leases and, when no client holds a
 * lease, nothing is in flight, and the lease-less state has persisted for the
 * grace window, invokes `onIdle` (the daemon retires). Idempotent — a second
 * call is a no-op.
 */
export function startLeaseGC(opts: LeaseOptions): void {
 if (gcTimer !== null) return;
 gcTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, seenAt] of leases) {
   if (now - seenAt > opts.ttlMs) {
    leases.delete(id);
   }
  }
  if (leases.size > 0) {
   emptySince = null;
   return;
  }
  if (emptySince === null) {
   emptySince = now;
   return;
  }
  if (opts.getActiveRequests() === 0 && now - emptySince >= opts.graceMs) {
   stopLeaseGC();
   opts.onIdle();
  }
 }, opts.gcMs);
}

/** Stop the GC sweep (test teardown / daemon shutdown). */
export function stopLeaseGC(): void {
 if (gcTimer !== null) {
  clearInterval(gcTimer);
  gcTimer = null;
 }
}

/** Test-only: reset all lease state. */
export function _resetLeaseStateForTest(): void {
 leases.clear();
 lastActivityAt = 0;
 emptySince = null;
 stopLeaseGC();
}
