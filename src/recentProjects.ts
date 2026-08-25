// Small per-user index used before any project has been selected. Project
// history/comments stay inside each paper; this list only remembers how to get
// back to those papers from the one-click launcher.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

export interface RecentProject {
  projectRoot: string;
  mainFile: string;
  lastOpened: string;
}

export const MAX_RECENT_PROJECTS = 16;

export function recentProjectsPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'TeXChronicle', 'recent-projects.json');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'TeXChronicle', 'recent-projects.json');
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'texchronicle', 'recent-projects.json');
}

function legacyRecentProjectsPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'MagicTeX', 'recent-projects.json');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'MagicTeX', 'recent-projects.json');
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'magictex', 'recent-projects.json');
}

function validRecent(value: unknown): value is RecentProject {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RecentProject>;
  return typeof item.projectRoot === 'string' && isAbsolute(item.projectRoot) &&
    typeof item.mainFile === 'string' && !!item.mainFile && !isAbsolute(item.mainFile) &&
    !item.mainFile.replace(/\\/g, '/').split('/').some((part) => part === '..' || part === '.') &&
    typeof item.lastOpened === 'string';
}

export async function listRecentProjects(
  path = recentProjectsPath(),
  legacyPath = path === recentProjectsPath() ? legacyRecentProjectsPath() : undefined,
): Promise<RecentProject[]> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The next successful remember operation writes these records to the new
    // path, so users keep their chooser list after upgrading the product name.
    if (!legacyPath) return [];
    try { raw = await readFile(legacyPath, 'utf8'); }
    catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw legacyError;
    }
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validRecent).slice(0, MAX_RECENT_PROJECTS);
  } catch {
    // A broken convenience index must never prevent a paper opening. The next
    // successful launch replaces it atomically with a valid list.
    return [];
  }
}

const keyOf = (item: Pick<RecentProject, 'projectRoot' | 'mainFile'>): string => {
  const key = `${resolve(item.projectRoot)}\0${item.mainFile.replace(/\\/g, '/')}`;
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

const RECENT_LOCK_STALE_MS = 30_000;
const RECENT_LOCK_TIMEOUT_MS = 10_000;

/** Is that process still running? EPERM means yes — the process exists and this
 *  one may not signal it (another user's, or an elevated one). Treating that as
 *  dead broke a live lock and let two processes rewrite this file at once. */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function withRecentLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + RECENT_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = NaN;
      let age = 0;
      try {
        owner = Number((await readFile(lock, 'utf8')).trim());
        age = Date.now() - (await stat(lock)).mtimeMs;
      } catch { /* another process released it */ }
      const deadOwner = Number.isInteger(owner) && owner > 0 && !isAlive(owner);
      if (deadOwner || age > RECENT_LOCK_STALE_MS) await rm(lock, { force: true }).catch(() => {});
      if (Date.now() > deadline) throw new Error('Recent projects are busy in another TeXChronicle process; please try again.');
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  try { return await fn(); }
  finally { await rm(lock, { force: true }).catch(() => {}); }
}

export async function rememberRecentProject(
  projectRoot: string,
  mainFile: string,
  path = recentProjectsPath(),
): Promise<RecentProject[]> {
  const root = resolve(projectRoot);
  const rel = relative(root, resolve(root, mainFile)).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !/\.tex$/i.test(rel)) {
    throw new Error('Cannot remember a main file outside its project root.');
  }
  const entry: RecentProject = { projectRoot: root, mainFile: rel, lastOpened: new Date().toISOString() };
  return withRecentLock(path, async () => {
    const previous = await listRecentProjects(path);
    const wanted = keyOf(entry);
    const next = [entry, ...previous.filter((item) => keyOf(item) !== wanted)].slice(0, MAX_RECENT_PROJECTS);

    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, path);
    return next;
  });
}
