/**
 * Client lease registry for the detached pi-freeflow proxy daemon.
 *
 * Each OMP/Pi session is a client that registers a lease and renews it with a
 * heartbeat while alive. The daemon drops expired leases and, once NO client
 * holds a live lease AND no request has been proxied recently, retires itself.
 *
 * The request-touch (`lastActivityAt`) is the fallback for legacy clients that
 * never heartbeated: any proxied request counts as a live user, so the daemon
 * is never idle-killed while a session is actually using it.
 */

export interface LeaseOptions {
	/** Lease lifetime (ms); a client that misses ~3 beats is dropped. */
	ttlMs: number;
	/** GC sweep interval (ms). */
	gcMs: number;
	/** Idle grace after the last proxied request before a lease-less daemon exits (ms). */
	graceMs: number;
	/** Current in-flight proxied requests — daemon never exits mid-stream. */
	getActiveRequests: () => number;
	/** Called once when the daemon should retire (close server + exit). */
	onIdle: () => void;
}

const leases = new Map<string, number>();
let lastActivityAt = Date.now();
let gcTimer: ReturnType<typeof setInterval> | null = null;

/** Register or refresh a client lease. */
export function registerClient(clientId: string): void {
	leases.set(clientId, Date.now());
}

/** Renew an existing client lease (unknown ids are ignored). */
export function renewClient(clientId: string): void {
	if (leases.has(clientId)) {
		leases.set(clientId, Date.now());
	}
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
 * lease, nothing is in flight, and no request has been proxied within the
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
		if (
			leases.size === 0 &&
			opts.getActiveRequests() === 0 &&
			now - lastActivityAt > opts.graceMs
		) {
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
	lastActivityAt = Date.now();
	stopLeaseGC();
}
