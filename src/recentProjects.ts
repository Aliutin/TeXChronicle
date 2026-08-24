// Small per-user index used before any project has been selected. Project
// history/comments stay inside each paper; this list only remembers how to get
// back to those papers from the one-click launcher.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

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

export async function listRecentProjects(path = recentProjectsPath()): Promise<RecentProject[]> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
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
  const previous = await listRecentProjects(path);
  const wanted = keyOf(entry);
  const next = [entry, ...previous.filter((item) => keyOf(item) !== wanted)].slice(0, MAX_RECENT_PROJECTS);

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, path);
  return next;
}
