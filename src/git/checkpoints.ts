// Zed-style auto-checkpoints: on each successful compile we snapshot the working
// tree into a parallel commit chain under a HIDDEN ref, touching none of the
// user's working tree, index, HEAD, or branches. History you can browse without
// polluting `git log`. All git access is via execFile (no shell) — validated on
// Windows git in the spike.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { git, gitOrNull } from './exec.js';
import { historyRepo, type HistoryMode } from './historyRepo.js';
import { withLock } from '../lock.js';

const REF = 'refs/latex-preview/checkpoints';
// The well-known empty tree — used to diff the very first checkpoint (no parent).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA_RE = /^[0-9a-f]{7,64}$/; // guards HTTP-supplied shas against git arg injection

/**
 * Can this project have history at all?
 *
 * Named for what it used to test. It no longer asks "is this a git repository",
 * because that stopped being the question: a project that isn't one gets a
 * shadow repo in our cache and has history just the same. The only remaining
 * reason to answer no is that there's no usable `git` binary.
 */
export async function canTrackHistory(root: string): Promise<boolean> {
  const m = (await historyRepo(root)).mode;
  return m === 'project' || m === 'shadow';
}

/** Where this project's history lives — and, when it doesn't, why. Callers need
 *  the reason: "install git" and "this path isn't writable" are different
 *  problems, and answering one with the other wastes the reader's time. */
export async function historyStatus(root: string): Promise<{ mode: HistoryMode; detail?: string }> {
  const { mode, detail } = await historyRepo(root);
  return { mode, detail };
}

export interface Checkpoint {
  sha: string;
  time: string; // ISO 8601
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Unlocked implementation — read-current-ref, write-tree, commit-tree, and
 *  advance-ref must run as one cross-process critical section (two agents
 *  compiling near-simultaneously would otherwise both read the same parent
 *  and race update-ref, silently orphaning whichever one loses). Exported
 *  callers get that via createCheckpoint below; restoreCheckpoint/restoreFile
 *  call this directly because they already hold the lock for their own
 *  operation and calling the locked wrapper again would deadlock. */
/**
 * Why a checkpoint was not created.
 *
 * The distinction matters in exactly one place, and it is the dangerous one:
 * restore snapshots the current state first so the operation is reversible, and
 * this used to return a bare `{created:false}` for BOTH "nothing had changed"
 * (fine, the previous checkpoint already holds it) and "the snapshot failed"
 * (not fine — the next step overwrites every file). Restore ignored the return
 * value either way, so a full tmpdir, an EPERM on a figure open in another app,
 * or a stale index.lock meant an hour of uncommitted work was destroyed with
 * nothing to go back to, against an explicit promise on screen that it was safe.
 */
export type NotCreated = 'no-history' | 'unchanged' | 'changed-during-compile' | 'failed';

export interface CheckpointResult {
  created: boolean;
  sha?: string;
  reason?: NotCreated;
  error?: string;
}

export interface CheckpointPreparation {
  /** Git tree captured immediately before the compiler starts reading files. */
  tree?: string;
  reason?: 'no-history' | 'failed';
  error?: string;
}

/** Hash the working tree through a private index, without changing a ref. The
 * resulting tree object is immutable even if an editor saves again later. */
async function writeCurrentTree(root: string, ENV: NodeJS.ProcessEnv): Promise<string> {
  const idx = join(tmpdir(), `latex-ckpt-${randomBytes(6).toString('hex')}.index`);
  const env = { ...ENV, GIT_INDEX_FILE: idx };
  try {
    await git(root, ['add', '-A', ...EXCLUDE_TOOL], env);
    return (await git(root, ['write-tree'], env)).trim();
  } finally {
    await rm(idx, { force: true }).catch(() => {});
  }
}

/** Advance the hidden history ref to an already-captured tree. Caller holds the lock. */
async function commitTreeUnlocked(root: string, ENV: NodeJS.ProcessEnv, tree: string): Promise<CheckpointResult> {
  const prev = (await gitOrNull(root, ['rev-parse', '--verify', '-q', REF], ENV))?.trim() || '';
  if (prev) {
    const prevTree = (await git(root, ['rev-parse', `${prev}^{tree}`], ENV)).trim();
    if (tree === prevTree) return { created: false, reason: 'unchanged', sha: prev };
  }

  const msg = `checkpoint ${new Date().toISOString()}`;
  const commitArgs = prev
    ? ['commit-tree', tree, '-p', prev, '-m', msg]
    : ['commit-tree', tree, '-m', msg];
  const sha = (await git(root, commitArgs, ENV)).trim();
  await git(root, ['update-ref', REF, sha], ENV);
  return { created: true, sha };
}

/** Internal unlocked form for compound reversible operations. Callers must hold
 *  `withLock(root, ...)`; ordinary checkpoint creation must use the public
 *  locked wrapper below. */
export async function createCheckpointUnlocked(root: string): Promise<CheckpointResult> {
  const { env: ENV, mode } = await historyRepo(root);
  if (mode !== 'project' && mode !== 'shadow') return { created: false, reason: 'no-history' };
  try {
    // MagicTeX's own state and Claude Code's config are not the user's paper.
    // writeCurrentTree excludes both while still respecting the author's normal
    // .gitignore, and always uses a private index outside the repository.
    return await commitTreeUnlocked(root, ENV, await writeCurrentTree(root, ENV));
  } catch (e) {
    // Still never breaks a compile — but the reason travels now, so a caller
    // that is about to overwrite the working tree can refuse.
    return { created: false, reason: 'failed', error: String((e as Error).message ?? e) };
  }
}

/**
 * Snapshot the current working tree into the hidden checkpoint chain.
 * No-op (returns {created:false}) when not a git repo or the tree is unchanged
 * since the last checkpoint. Never throws for expected conditions.
 */
export async function createCheckpoint(root: string): Promise<CheckpointResult> {
  return withLock(root, () => createCheckpointUnlocked(root));
}

/** The tip of the successful-render history, whether or not files have since
 * changed. Useful for anchoring a comment created on the currently shown PDF. */
export async function latestCheckpointSha(root: string): Promise<string | undefined> {
  const { env: ENV, mode } = await historyRepo(root);
  if (mode !== 'project' && mode !== 'shadow') return undefined;
  return (await gitOrNull(root, ['rev-parse', '--verify', '-q', REF], ENV))?.trim() || undefined;
}

/** The latest checkpoint only when it describes the files on disk right now.
 * Resolution uses this stricter form: a dirty or failed build must not be
 * labelled as the successful version that preceded it. */
export async function matchingCheckpointSha(root: string): Promise<{ sha?: string; dirty: boolean }> {
  return withLock(root, async () => {
    const { env: ENV, mode } = await historyRepo(root);
    if (mode !== 'project' && mode !== 'shadow') return { dirty: false };
    const sha = (await gitOrNull(root, ['rev-parse', '--verify', '-q', REF], ENV))?.trim() || undefined;
    if (!sha) return { dirty: false };
    try {
      const [currentTree, checkpointTree] = await Promise.all([
        writeCurrentTree(root, ENV),
        git(root, ['rev-parse', `${sha}^{tree}`], ENV).then((value) => value.trim()),
      ]);
      return currentTree === checkpointTree ? { sha, dirty: false } : { dirty: true };
    } catch {
      return { dirty: true };
    }
  });
}

/**
 * Capture the source tree immediately before a compile. This writes Git objects
 * but no commit/ref, so a failed compile never appears in History.
 */
export async function prepareCheckpoint(root: string): Promise<CheckpointPreparation> {
  return withLock(root, async () => {
    const { env: ENV, mode } = await historyRepo(root);
    if (mode !== 'project' && mode !== 'shadow') return { reason: 'no-history' };
    try {
      return { tree: await writeCurrentTree(root, ENV) };
    } catch (e) {
      return { reason: 'failed', error: String((e as Error).message ?? e) };
    }
  });
}

/**
 * Commit a pre-compile tree only if the working tree is still identical after
 * compilation. The resulting SHA can therefore label the produced PDF without
 * a source/PDF race. If a save happened mid-compile, the watcher will compile
 * that newer tree next and this stale render receives no misleading artifact.
 */
export async function createCheckpointFromPrepared(root: string, preparedTree: string): Promise<CheckpointResult> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(preparedTree)) return { created: false, reason: 'failed', error: 'invalid prepared tree' };
  return withLock(root, async () => {
    const { env: ENV, mode } = await historyRepo(root);
    if (mode !== 'project' && mode !== 'shadow') return { created: false, reason: 'no-history' };
    try {
      const currentTree = await writeCurrentTree(root, ENV);
      if (currentTree !== preparedTree) return { created: false, reason: 'changed-during-compile' };
      return await commitTreeUnlocked(root, ENV, preparedTree);
    } catch (e) {
      return { created: false, reason: 'failed', error: String((e as Error).message ?? e) };
    }
  });
}

const SHORTSTAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

// Hide non-paper noise everywhere history is read: MagicTeX's own state (the
// comments store under .latex-preview) and Claude Code's editor/agent config
// (.claude — e.g. slash-command .md files). Neither is part of the user's
// paper. Passed as a git exclude pathspec — `git log -- <pathspec>` also
// limits to commits that touch something OUTSIDE the excluded paths, so a
// checkpoint whose only change was to .claude/.latex-preview doesn't show up
// as a confusing, paper-unrelated entry in the History timeline at all.
const EXCLUDE_TOOL = ['--', '.', ':(exclude).latex-preview', ':(exclude).claude'];

/** Newest-first list of checkpoints that touched the paper (a checkpoint whose
 *  only change was e.g. .claude/.latex-preview is filtered out). Empty when no
 *  such checkpoints / not a git repo. */
export async function listCheckpoints(root: string): Promise<Checkpoint[]> {
  const { env: ENV } = await historyRepo(root);
  const out = await gitOrNull(root, ['log', REF, '--format=@@@%H %cI', '--shortstat', ...EXCLUDE_TOOL], ENV);
  if (!out) return [];
  const checkpoints: Checkpoint[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@@')) {
      const sp = line.indexOf(' ');
      checkpoints.push({ sha: line.slice(3, sp), time: line.slice(sp + 1).trim(), filesChanged: 0, insertions: 0, deletions: 0 });
    } else {
      const m = line.match(SHORTSTAT_RE);
      if (m && checkpoints.length) {
        const cur = checkpoints[checkpoints.length - 1];
        cur.filesChanged = Number(m[1] || 0);
        cur.insertions = Number(m[2] || 0);
        cur.deletions = Number(m[3] || 0);
      }
    }
  }
  return checkpoints;
}

/** Current uncommitted changes vs HEAD (or everything, if there's no commit yet). */
export async function getWorkingDiff(root: string): Promise<string> {
  const { env: ENV } = await historyRepo(root);
  const hasHead = (await gitOrNull(root, ['rev-parse', '--verify', '-q', 'HEAD'], ENV)) !== null;
  return (await gitOrNull(root, [...(hasHead ? ['diff', 'HEAD'] : ['diff']), ...EXCLUDE_TOOL], ENV)) ?? '';
}

/**
 * Drop MagicTeX's own state and Claude's config from a restore index.
 *
 * New checkpoints no longer record them, but every checkpoint taken before this
 * still does — and restoring one wrote .latex-preview/comments.json and
 * .claude/** back over the current ones. That deleted every comment made since,
 * including another agent's, and rewrote settings and slash-command files, none
 * of which appeared in the diff the user approved. It also overwrote the very
 * lock file the restore was holding, with a stale PID, letting a second process
 * in mid-checkout.
 */
async function dropToolPathsFromIndex(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const listed = await gitOrNull(root, ['ls-files', '--', '.latex-preview', '.claude'], env);
  const paths = (listed ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!paths.length) return;
  await git(root, ['update-index', '--force-remove', '--', ...paths], env);
}

/**
 * Restore the working tree to a checkpoint ("revert to this version"). Snapshots
 * the current state first (so it's reversible — the just-lost work becomes a new
 * checkpoint), then writes the checkpoint's files back via a TEMP index +
 * checkout-index, so the user's real index/HEAD/branches are never touched. Files
 * added after the checkpoint are left in place (safer than deleting).
 */
export async function restoreCheckpoint(root: string, sha: string): Promise<void> {
  const { env: ENV } = await historyRepo(root);
  if (!SHA_RE.test(sha)) throw new Error('invalid checkpoint id');
  const reachable = await gitOrNull(root, ['merge-base', '--is-ancestor', sha, REF], ENV);
  if (reachable === null) throw new Error('unknown checkpoint');
  await withLock(root, async () => {
    // The point of this line is that the restore is reversible. If it failed,
    // it is not — so refuse rather than overwrite the working tree and discard
    // whatever was in it. 'unchanged' is fine: the previous checkpoint already
    // holds exactly this state.
    const snapshot = await createCheckpointUnlocked(root);
    if (!snapshot.created && snapshot.reason !== 'unchanged') {
      throw new Error(
        `Refusing to restore: MagicTeX could not snapshot your current files first, so this could not be undone (${snapshot.error ?? snapshot.reason}). Nothing has been changed.`,
      );
    }
    const idx = join(tmpdir(), `latex-restore-${randomBytes(6).toString('hex')}.index`);
    const env = { ...ENV, GIT_INDEX_FILE: idx };
    try {
      await git(root, ['read-tree', sha], env);       // load the checkpoint tree into a temp index
      await dropToolPathsFromIndex(root, env);
      await git(root, ['checkout-index', '-a', '-f'], env); // write those files to the working tree
    } finally {
      await rm(idx, { force: true }).catch(() => {});
    }
  });
}

/** Restore ONE file to its content at a checkpoint (per-file revert). Same temp-
 *  index + checkout-index approach, reversible, real index untouched. */
export async function restoreFile(root: string, sha: string, relPath: string): Promise<void> {
  const { env: ENV } = await historyRepo(root);
  if (!SHA_RE.test(sha)) throw new Error('invalid checkpoint id');
  // A review flagged this as a pathspec injection — `path=*` supposedly turning
  // a per-file restore into a whole-tree revert. Measured against real git, it
  // is not:
  //
  //   $ git checkout-index -f -- '*'
  //   git checkout-index: * is not in the cache        (exit 1, nothing written)
  //   $ git checkout-index -f -- ':(glob)**/*.tex'
  //   git checkout-index: :(glob)**/*.tex is not in the cache
  //
  // checkout-index is plumbing: it looks entries up in the index by exact name
  // and honours neither globs nor pathspec magic. The `:(literal)` prefix added
  // to "fix" this broke the real feature for the same reason — it is not a
  // filename either. test/restoreFilePathspec.test.ts pins the behaviour, so if
  // a future git starts interpreting these we find out from a red test rather
  // than from a user.
  //
  // Segment-wise rather than `includes('..')`: the latter also rejects a
  // legitimate `notes..old.tex`.
  const rel = String(relPath).replace(/^[/\\]+/, '');
  if (!rel || rel.split(/[/\\]/).some((s) => s === '..' || s === '.')) throw new Error('invalid path');
  const reachable = await gitOrNull(root, ['merge-base', '--is-ancestor', sha, REF], ENV);
  if (reachable === null) throw new Error('unknown checkpoint');
  await withLock(root, async () => {
    // The point of this line is that the restore is reversible. If it failed,
    // it is not — so refuse rather than overwrite the working tree and discard
    // whatever was in it. 'unchanged' is fine: the previous checkpoint already
    // holds exactly this state.
    const snapshot = await createCheckpointUnlocked(root);
    if (!snapshot.created && snapshot.reason !== 'unchanged') {
      throw new Error(
        `Refusing to restore: MagicTeX could not snapshot your current files first, so this could not be undone (${snapshot.error ?? snapshot.reason}). Nothing has been changed.`,
      );
    }
    const idx = join(tmpdir(), `latex-restorefile-${randomBytes(6).toString('hex')}.index`);
    const env = { ...ENV, GIT_INDEX_FILE: idx };
    try {
      await git(root, ['read-tree', sha], env);
      await dropToolPathsFromIndex(root, env);
      await git(root, ['checkout-index', '-f', '--', rel], env);
    } finally {
      await rm(idx, { force: true }).catch(() => {});
    }
  });
}

/** Unified diff for one checkpoint (vs its parent, or the empty tree for the first). */
export async function getCheckpointDiff(root: string, sha: string): Promise<string> {
  const { env: ENV } = await historyRepo(root);
  if (!SHA_RE.test(sha)) throw new Error('invalid checkpoint id');
  // Only allow shas reachable from our own ref — never diff arbitrary objects.
  const reachable = await gitOrNull(root, ['merge-base', '--is-ancestor', sha, REF], ENV);
  if (reachable === null) throw new Error('unknown checkpoint');
  const hasParent = (await gitOrNull(root, ['rev-parse', '--verify', '-q', `${sha}^`], ENV)) !== null;
  const base = hasParent ? `${sha}^` : EMPTY_TREE;
  return git(root, ['diff', base, sha, ...EXCLUDE_TOOL], ENV);
}
