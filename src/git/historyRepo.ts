// Where a project's checkpoint history lives.
//
// Until now history required the project to already be a git repository, so
// anyone writing a paper in a plain folder got nothing — no timeline, no diffs,
// no record of what an agent changed. That is the feature this project exists
// for, absent for most of the people it is for.
//
// Telling them to run `git init` is the wrong answer: it puts a .git in their
// directory, changes what `git status` does there forever, and makes them adopt
// a tool they did not ask for to get a feature they did not know they were
// opting into. So for those projects the repository is one we keep ourselves,
// with the project as its work tree — git tracks the files, and `git` run there
// by the author still reports no repository. Verified on Windows git 2.45.
//
// It used to live in the per-user cache, keyed by a hash of the project path.
// That made history a property of the PATH rather than of the project, and every
// consequence of that was wrong:
//
//   - Rename or move the folder and the history was gone. Nothing said so.
//   - Reuse a path — delete ~/papers/draft, start a new paper with the same name
//     — and the new project silently adopted the old one's checkpoints. Restore
//     then wrote a deleted paper's files over the new one's, and the History
//     panel had been showing them as this project's own past all along.
//   - Copy a project and both copies wrote to one history.
//   - Delete a project and its full text stayed in the cache forever, with
//     nothing that would ever clean it up.
//
// Keeping the repo inside the project fixes all four at once, and needs no
// identity scheme to do it: the history is carried by the same bytes as the
// paper, so it moves, copies and is deleted exactly when the paper is.
// `.latex-preview` is already ours — already ignored by the watcher, the project
// collector and the export zip, and already excluded from checkpoints
// themselves.
import { createHash } from 'node:crypto';
import { mkdir, access, rename, cp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { cacheRoot } from '../engine/assetsDir.js';
import { git, gitOrNull } from './exec.js';

export type HistoryMode =
  | 'project'     // the project is a git repo; checkpoints go on a hidden ref in it
  | 'shadow'      // not a repo; history lives beside the project, work tree is the project
  | 'no-git'      // no git binary on PATH
  | 'unwritable'; // git is fine, but the history store could not be created

/**
 * Two ways to have no history, and they need different things from the reader:
 * one is "install git", the other is "look at this path". They were a single
 * `'unavailable'` state whose message always said the first — so a failed setup
 * told people to install software they already had, and left them with nowhere
 * to go after they did.
 */
export interface HistoryRepo {
  mode: HistoryMode;
  /** Env to pass to every git call for this project. Empty for 'project'. */
  env: NodeJS.ProcessEnv;
  /** For 'unwritable': where it tried, and what the OS said back. Both matter —
   *  a permissions error and a full disk need different responses. */
  detail?: string;
}

const NO_GIT: HistoryRepo = { mode: 'no-git', env: {} };

/** Identity for commits we create. A shadow repo has no user config to inherit,
 *  and `commit-tree` fails outright without one — which would have turned "no
 *  git identity configured" into "history silently never appears". */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'MagicTeX',
  GIT_AUTHOR_EMAIL: 'magictex@localhost',
  GIT_COMMITTER_NAME: 'MagicTeX',
  GIT_COMMITTER_EMAIL: 'magictex@localhost',
};

const TOOL_DIR = '.latex-preview';
const SHADOW = 'history.git';

let gitPresent: boolean | undefined;
async function hasGit(): Promise<boolean> {
  if (gitPresent === undefined) {
    gitPresent = (await gitOrNull(process.cwd(), ['--version'])) !== null;
  }
  return gitPresent;
}

const exists = async (p: string): Promise<boolean> => {
  try { await access(p); return true; } catch { return false; }
};

/** A repo directory that is really there, not just a leftover empty folder. */
const isRepo = (dir: string): Promise<boolean> => exists(join(dir, 'HEAD'));

/**
 * Keep the shadow repo out of the author's own commits.
 *
 * A project can stop being "a plain folder" at any time — the author runs
 * `git init` a week later. Without this, their very first `git add -A` sweeps up
 * a second full copy of the paper plus its entire history as loose objects.
 * Scoped to the one directory we create, so whether comments.json gets tracked
 * stays the author's decision.
 */
async function ignoreToolStorage(root: string): Promise<void> {
  try {
    const path = join(root, TOOL_DIR, '.gitignore');
    await mkdir(join(root, TOOL_DIR), { recursive: true });
    const existing = await readFile(path, 'utf8').catch(() => '');
    const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    lines.add(`${SHADOW}/`);
    // Exact render PDFs are synchronised with the project, but are binary build
    // artifacts rather than source. Keep them out of both the user's ordinary
    // Git repository and MagicTeX's hidden checkpoint trees.
    lines.add('renders/');
    const next = [...lines].join('\n') + '\n';
    if (next !== existing) await writeFile(path, next, 'utf8');
  } catch {
    /* already there, or unwritable — neither is worth failing history over */
  }
}

// ── Migration off the old path-keyed cache ──────────────────────────────────

const REF = 'refs/latex-preview/checkpoints';

/** Where <= 0.1.8 would have put this project's history. */
async function legacyCacheDir(root: string): Promise<string> {
  let key = root;
  try { key = await realpath(root); } catch { /* not yet created; the raw path will do */ }
  if (process.platform === 'win32') key = key.toLowerCase();
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(cacheRoot(), 'history', hash);
}

/** Files whose bytes we are willing to compare as text. Deliberately not
 *  figures: reading a 20 MB PDF through a pipe to answer a yes/no question is
 *  waste, and a LaTeX project with no source file has no history worth moving
 *  either. */
const TEXTY = new Set(['.tex', '.bib', '.cls', '.sty', '.bst', '.bbl', '.md', '.txt', '.csv', '.json', '.yml', '.yaml']);

const sameText = (a: string, b: string) => a.split('\r\n').join('\n') === b.split('\r\n').join('\n');

/**
 * Does this cached history actually describe the files now at `root`?
 *
 * Why the question has to be asked at all: a path-keyed cache entry is claimed
 * by whoever holds the path now, which is the bug being fixed. Adopting one
 * unconditionally would carry that bug across the migration and into a Restore
 * that overwrites a different paper.
 *
 * The test is content, not names — `main.tex` is the most common filename in
 * LaTeX and proves nothing. A checkpoint is written on every successful compile,
 * so for the project this history belongs to, at least one source file still
 * matches its recorded bytes exactly; for an unrelated project that inherited
 * the path, none does.
 */
async function describesProject(gitDir: string, root: string): Promise<boolean> {
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root };
  const listed = await gitOrNull(root, ['ls-tree', '-r', REF], env);
  if (!listed) return false;
  let compared = 0;
  for (const line of listed.split(/\r?\n/)) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (!m) continue;
    const [, blob, rel] = m;
    if (!TEXTY.has(extname(rel).toLowerCase())) continue;
    if (compared++ >= 20) break;
    let onDisk: string;
    try { onDisk = await readFile(join(root, rel), 'utf8'); } catch { continue; } // gone, or unreadable
    const recorded = await gitOrNull(root, ['cat-file', 'blob', blob], env);
    if (recorded !== null && sameText(onDisk, recorded)) return true;
  }
  return false;
}

/** Move a pre-0.1.9 cached history into the project, when it is provably this
 *  project's. Best effort: an author who does not get their old timeline back is
 *  worse off than before, but an author handed someone else's is worse still. */
async function adoptLegacyCache(root: string, dest: string): Promise<void> {
  const legacy = await legacyCacheDir(root);
  if (!(await isRepo(legacy))) return;
  if (!(await describesProject(legacy, root))) return;
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(legacy, dest);
  } catch {
    // Different volumes: the cache is on the system drive, the paper need not be.
    try {
      await cp(legacy, dest, { recursive: true });
      await rm(legacy, { recursive: true, force: true });
    } catch (e) {
      // Never leave half a repo behind — the next run would take it for a real
      // one and skip both the migration and `git init`.
      await rm(dest, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, HistoryRepo>();

/**
 * Decide where this project's history lives, creating the shadow repo on first
 * use. Cached per project for the process's lifetime.
 */
export async function historyRepo(root: string): Promise<HistoryRepo> {
  const hit = cache.get(root);
  if (hit) return hit;

  if (!(await hasGit())) {
    cache.set(root, NO_GIT);
    return NO_GIT;
  }

  // An existing repo keeps the current behaviour: checkpoints sit on a hidden
  // ref inside it, so they survive a clone and live beside the author's own
  // history rather than in a directory they'd never find.
  if ((await gitOrNull(root, ['rev-parse', '--git-dir'])) !== null) {
    await ignoreToolStorage(root);
    const resolved: HistoryRepo = { mode: 'project', env: { ...IDENTITY } };
    cache.set(root, resolved);
    return resolved;
  }

  const dir = join(root, TOOL_DIR, SHADOW);
  const env: NodeJS.ProcessEnv = { ...IDENTITY, GIT_DIR: dir, GIT_WORK_TREE: root };
  try {
    if (!(await isRepo(dir))) {
      await mkdir(join(root, TOOL_DIR), { recursive: true });
      await ignoreToolStorage(root);
      // Never fatal: failing to bring an old timeline forward costs the author
      // that timeline, but failing the compile over it costs them more.
      await adoptLegacyCache(root, dir).catch(() => {});
    }
    await mkdir(dir, { recursive: true });
    // Existing shadow repos predate render artifacts; upgrade their ignore file
    // too, not only newly-created stores.
    await ignoreToolStorage(root);
    // `git init` is idempotent, but checking first keeps a re-init out of the
    // common path and makes a corrupted directory visible as a failure here
    // rather than as a confusing error on the first commit.
    if (!(await isRepo(dir))) {
      await git(root, ['init', '--quiet'], { ...process.env, ...env });
    }
    const resolved: HistoryRepo = { mode: 'shadow', env };
    cache.set(root, resolved);
    return resolved;
  } catch (err) {
    // Degrade to no history rather than failing the compile that triggered this
    // — but keep why. Reported as "no git found", this sent people to install
    // software they already had, and left them nowhere to go once they had.
    const resolved: HistoryRepo = {
      mode: 'unwritable',
      env: {},
      detail: `${dir}: ${(err as Error)?.message ?? String(err)}`,
    };
    cache.set(root, resolved);
    return resolved;
  }
}

/** Reset the memo — for tests, and for a project whose git status changed under
 *  us (someone ran `git init` while the server was up). */
export function forgetHistoryRepo(root?: string): void {
  if (root) cache.delete(root);
  else cache.clear();
  gitPresent = undefined;
}
