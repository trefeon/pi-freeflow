/**
 * Process-wide state shared by every loaded copy of this extension.
 *
 * A host may load the extension once per session with a fresh module cache
 * (one long-lived server process, many sessions). Module-level variables then
 * exist once per copy: each copy runs its own heartbeat, watchdog, spawn
 * throttle and recovery breaker, and they race each other on the shared
 * daemon port. State that must exist once per process lives here instead,
 * keyed on a registry symbol so every copy resolves the same object.
 *
 * Bump the key suffix when a stored shape changes incompatibly: copies of the
 * old code still running in the same process keep their own object.
 */
export function processState<T extends object>(key: string, init: () => T): T {
 const sym = Symbol.for(`pi-freeflow.${key}`);
 const store = globalThis as unknown as Record<symbol, unknown>;
 const existing = store[sym];
 if (typeof existing === "object" && existing !== null) return existing as T;
 const created = init();
 store[sym] = created;
 return created;
}
