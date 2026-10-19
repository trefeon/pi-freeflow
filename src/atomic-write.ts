import { randomUUID } from "node:crypto";
import fs from "node:fs";

/** Block synchronously for ms without burning CPU. */
function sleepSync(ms: number): void {
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename with bounded retry: Windows briefly locks the target when another
 * process holds the file open, surfacing as EPERM/EACCES/EBUSY. Three attempts
 * with a fixed 50ms backoff by default; any other error fails immediately.
 */
export function renameWithRetry(from: string, to: string, attempts = 3, delayMs = 50): void {
 const retryable: Record<string, true> = { EPERM: true, EACCES: true, EBUSY: true };
 for (let attempt = 1; ; attempt++) {
  try {
   fs.renameSync(from, to);
   return;
  } catch (e) {
   const code = (e as NodeJS.ErrnoException | null)?.code;
   if (!code || !retryable[code] || attempt >= attempts) {
    throw e;
   }
   sleepSync(delayMs);
  }
 }
}

/**
 * Write `data` to `file` atomically: stage the bytes in a sibling temp file,
 * then rename over the target, so a crash leaves either the old or the new
 * file intact. The staged `<file>.<uuid>.tmp` is deliberately left in place
 * when the rename never lands — it is the only copy of the bytes that failed
 * to land, and relay-state's cleanupStaleTmpFiles reaps stale litter later.
 *
 * `mode` is applied to the staged file and re-applied to the final path
 * (best-effort — Windows ignores POSIX modes), so secret-bearing files keep
 * owner-only permissions.
 */
export function writeFileAtomic(file: string, data: string, opts?: { mode?: number }): void {
 const tmp = `${file}.${randomUUID()}.tmp`;
 fs.writeFileSync(tmp, data, opts?.mode ? { encoding: "utf8", mode: opts.mode } : "utf8");
 if (opts?.mode) {
  try {
   fs.chmodSync(tmp, opts.mode);
  } catch { }
 }
 renameWithRetry(tmp, file);
 if (opts?.mode) {
  try {
   fs.chmodSync(file, opts.mode);
  } catch { }
 }
}
