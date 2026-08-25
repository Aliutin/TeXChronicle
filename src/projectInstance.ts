// One desktop workspace per project, per machine. The record lives inside the
// project so every launcher invocation can find it, but the filename is keyed
// to this machine so Dropbox synchronization never makes a remote computer's
// localhost URL or PID block this one.
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';

interface InstanceRecord {
  pid: number;
  token: string;
  root: string;
  started: string;
  url?: string;
}

export interface OwnedProjectInstance {
  owned: true;
  publish: (url: string) => Promise<void>;
  release: () => Promise<void>;
}

export interface ExistingProjectInstance {
  owned: false;
  pid?: number;
  url?: string;
}

export type ProjectInstance = OwnedProjectInstance | ExistingProjectInstance;

const STARTUP_WAIT_MS = 10_000;
const POLL_MS = 100;

function machineId(): string {
  const user = process.env.USERNAME ?? process.env.USER ?? 'user';
  return createHash('sha256').update(`${hostname()}\0${user}`).digest('hex').slice(0, 16);
}

export function projectInstancePath(root: string): string {
  return join(root, '.latex-preview', 'instances', `${machineId()}.json`);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readRecord(path: string): Promise<InstanceRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<InstanceRecord>;
    return Number.isInteger(value.pid) && typeof value.token === 'string' && typeof value.root === 'string'
      ? value as InstanceRecord
      : null;
  } catch { return null; }
}

/** Acquire the long-lived desktop ownership record, or return the already-live
 * workspace. Creation is exclusive, so simultaneous double-clicks cannot both
 * become owners while the first server is still choosing a port. */
export async function acquireProjectInstance(root: string): Promise<ProjectInstance> {
  const canonicalRoot = await realpath(root);
  const path = projectInstancePath(canonicalRoot);
  await mkdir(dirname(path), { recursive: true });
  const token = randomBytes(12).toString('hex');
  const record: InstanceRecord = {
    pid: process.pid,
    token,
    root: canonicalRoot,
    started: new Date().toISOString(),
  };

  const deadline = Date.now() + STARTUP_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
      const publish = async (url: string) => {
        record.url = url;
        await writeFile(path, JSON.stringify(record), 'utf8');
      };
      const release = async () => {
        const current = await readRecord(path);
        if (current?.token === token) await rm(path, { force: true });
      };
      return { owned: true, publish, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const current = await readRecord(path);
    if (current && !isAlive(current.pid)) {
      await rm(path, { force: true }).catch(() => {});
      continue;
    }
    if (current?.url) return { owned: false, pid: current.pid, url: current.url };
    if (Date.now() >= deadline) {
      // A live owner that has not published a URL is still starting or wedged;
      // do not race it. The message in standalone tells the user what happened.
      if (current && isAlive(current.pid)) return { owned: false, pid: current.pid };
      // An invalid/half-written record older than the startup window is stale.
      let oldEnough = true;
      try { oldEnough = Date.now() - (await stat(path)).mtimeMs >= STARTUP_WAIT_MS; } catch { /* gone */ }
      if (oldEnough) { await rm(path, { force: true }).catch(() => {}); continue; }
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}
