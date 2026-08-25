// Cross-PROCESS mutex for TeXChronicle's shared on-disk state (comments.json, the
// checkpoint git ref). Each Claude Code session spawns its own `tsx server.ts`
// process (stdio MCP = one child per client), so an in-process lock (a promise
// chain, a module-level flag) does nothing once a second agent is a second
// process — only a lock that lives on disk is visible to both. Safe for this
// tool's actual concurrency level (a handful of local agents, sub-second
// critical sections); not a general-purpose distributed lock.
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

const STALE_MS = 30_000; // a real critical section here is well under 1s
const POLL_MS = 75;
const TIMEOUT_MS = 15_000;

/**
 * Who holds the lock: `hostname:pid`.
 *
 * The pid alone was a machine-local answer to a question this project made
 * cross-machine. `.latex-preview/` is in Dropbox by design, so the lock file
 * synchronises to the author's other computer — where the pid it names belongs
 * to some unrelated local process, or to none. Both readings are wrong and each
 * has a failure of its own: a live pid on the desktop made the laptop wait the
 * full 15 s and then refuse ("another agent appears to be mid-edit"), for a
 * machine that had been shut down for a week; a dead one let the laptop break a
 * lock that was genuinely held. A hostname makes the question answerable: a
 * lock from somewhere else cannot be protecting anything on this filesystem
 * right now — the writer is not running here.
 */
const owner = (): string => `${hostname()}:${process.pid}`;

/** Reads what `owner()` writes, and what versions before it wrote: a bare pid.
 *  A file with no host is treated as this machine's, which is exactly what it
 *  meant when it was written. */
function parseOwner(text: string): { host?: string; pid: number } {
  const trimmed = text.trim();
  // Hostnames cannot contain ':', but split from the right regardless.
  const cut = trimmed.lastIndexOf(':');
  if (cut < 0) return { pid: Number(trimmed) };
  return { host: trimmed.slice(0, cut), pid: Number(trimmed.slice(cut + 1)) };
}

function lockPath(root: string, name: string): string {
  return join(root, '.latex-preview', name);
}

/** Is that process still running?
 *
 * Exported for the test that pins the EPERM case, which is the whole point of
 * the `catch`: `process.kill(pid, 0)` throws ESRCH for "no such process" and
 * EPERM for "it is there, you may not signal it" — another user's session, or
 * an elevated one. Reading both as dead let an ordinary agent break a live
 * lock and walk straight into the checkpoint critical section the lock exists
 * to serialise. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Remove the lock file if its owner is dead, belongs to another machine, or
 *  it's older than STALE_MS — a crashed/killed agent must not permanently block
 *  every other one. */
async function clearIfStale(path: string): Promise<void> {
  let held: { host?: string; pid: number };
  try { held = parseOwner(await readFile(path, 'utf8')); } catch { return; } // already gone
  // Written on another computer and synchronised here. Its pid describes a
  // process table this machine cannot see, so nothing about it is worth
  // waiting for; the files it was protecting are not being written here.
  if (held.host !== undefined && held.host !== hostname()) { await rm(path, { force: true }); return; }
  let ageMs = Infinity;
  try { ageMs = Date.now() - (await stat(path)).mtimeMs; } catch { return; }
  if (!isAlive(held.pid) || ageMs > STALE_MS) await rm(path, { force: true });
}

async function acquire(root: string, name: string): Promise<string> {
  const path = lockPath(root, name);
  await mkdir(dirname(path), { recursive: true }); // fresh project: no .latex-preview/ yet
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(path, 'wx'); // atomic create-exclusive — fails if it exists
      await fh.writeFile(owner());
      await fh.close();
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await clearIfStale(path);
      if (Date.now() > deadline) {
        throw new Error('Another agent appears to be mid-edit on this project and the lock did not clear in time — retry in a moment.');
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

/** Run `fn` holding the project's cross-process lock; released even if `fn` throws.
 *  Callers that already hold the lock must NOT call this again (not reentrant) —
 *  compose by calling the unlocked inner function instead (see checkpoints.ts). */
export async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const path = await acquire(root, '.lock');
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/**
 * First-time shadow-repository setup needs its own lock. It can be reached both
 * from inside `withLock` (a compile/checkpoint) and outside it (History/status
 * API reads), so reusing `.lock` here would deadlock. The separate name makes
 * first initialization single-file across TeXChronicle processes while leaving
 * the normal checkpoint critical section unchanged.
 */
export async function withHistoryInitLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const path = await acquire(root, '.history-init.lock');
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
