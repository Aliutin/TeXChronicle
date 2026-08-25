// Cross-PROCESS mutex for TeXChronicle's shared on-disk state (comments.json, the
// checkpoint git ref). Each Claude Code session spawns its own `tsx server.ts`
// process (stdio MCP = one child per client), so an in-process lock (a promise
// chain, a module-level flag) does nothing once a second agent is a second
// process — only a lock that lives on disk is visible to both. Safe for this
// tool's actual concurrency level (a handful of local agents, sub-second
// critical sections); not a general-purpose distributed lock.
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STALE_MS = 30_000; // a real critical section here is well under 1s
const POLL_MS = 75;
const TIMEOUT_MS = 15_000;

function lockPath(root: string, name: string): string {
  return join(root, '.latex-preview', name);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Remove the lock file if its owner is dead or it's older than STALE_MS — a
 *  crashed/killed agent must not permanently block every other one. */
async function clearIfStale(path: string): Promise<void> {
  let pid = NaN;
  try { pid = Number((await readFile(path, 'utf8')).trim()); } catch { return; } // already gone
  let ageMs = Infinity;
  try { ageMs = Date.now() - (await stat(path)).mtimeMs; } catch { return; }
  if (!isAlive(pid) || ageMs > STALE_MS) await rm(path, { force: true });
}

async function acquire(root: string, name: string): Promise<string> {
  const path = lockPath(root, name);
  await mkdir(dirname(path), { recursive: true }); // fresh project: no .latex-preview/ yet
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(path, 'wx'); // atomic create-exclusive — fails if it exists
      await fh.writeFile(String(process.pid));
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
