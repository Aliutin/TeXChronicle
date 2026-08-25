// Zed-style auto-checkpoints: on each successful compile we snapshot the working
// tree into a parallel commit chain under a HIDDEN ref, touching none of the
// user's working tree, index, HEAD, or branches. History you can browse without
// polluting `git log`. All git access is via execFile (no shell) — validated on
// Windows git in the spike.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { git, gitOrNull } from './exec.js';
import { historyRepo, type HistoryMode } from './historyRepo.js';
import { withLock } from '../lock.js';

const REF = 'refs/latex-preview/checkpoints';
// REF is the reversible timeline and may include a pre-restore safety snapshot.
// This marker advances only after a tree is known to have rendered cleanly.
const SUCCESS_REF = 'refs/latex-preview/successful';
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
  hasPdf: boolean;
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

/**
 * Did this `git add` fail only over files that were not there to be read?
 *
 * Measured against git 2.55 rather than guessed at — `LC_ALL=C` below keeps the
 * wording stable:
 *
 *   a file that disappeared while the add was running
 *     error: open("scratch.dat"): No such file or directory
 *     error: unable to index file 'scratch.dat'
 *   a path named on the command line that had already gone
 *     fatal: pathspec 'scratch.dat' did not match any files
 *   a file that IS there and cannot be read — the case that must still fail
 *     error: open("figure.png"): Permission denied
 *     error: unable to index file 'figure.png'
 *
 * The stated reason is the discriminator, never "is the file there now": a
 * scratch file that an editor or a TeX run recreates a millisecond later is
 * back by the time we could look, and the second line of each pair is
 * identical either way. Warnings are ignored on purpose — under core.autocrlf
 * every add prints one about a perfectly healthy file.
 *
 * Returns the vanished paths, or null when anything else went wrong.
 */
interface AddFailure { vanished: string[]; denied: string[] }

/** git quotes a path with non-ASCII bytes C-style (\303\251) under LC_ALL=C. */
function unquoteGitPath(quoted: string): string {
  if (!quoted.includes('\\')) return quoted;
  const bytes: number[] = [];
  for (let i = 0; i < quoted.length; i++) {
    if (quoted[i] !== '\\') { bytes.push(...Buffer.from(quoted[i], 'utf8')); continue; }
    const oct = quoted.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    const next = quoted[i + 1];
    bytes.push(...Buffer.from(next === 'n' ? '\n' : next === 't' ? '\t' : next, 'utf8'));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function classifyAddFailure(error: unknown): AddFailure | null {
  const text = String((error as { stderr?: string })?.stderr || (error as Error)?.message || error);
  const complaints = text.split(/\r?\n/).filter((line) => /^\s*(?:error|fatal):/.test(line));
  if (!complaints.length) return null;
  const vanished = new Set<string>();
  const denied = new Set<string>();
  for (const line of complaints) {
    const opened = line.match(/open\("(.+)"\): No such file or directory\s*$/);
    if (opened) { vanished.add(unquoteGitPath(opened[1])); continue; }
    const pathspec = line.match(/pathspec '(.+)' did not match any files\s*$/);
    if (pathspec) { vanished.add(unquoteGitPath(pathspec[1])); continue; }
    // Windows: a file another process is still closing after deleting it
    // answers open() with EACCES, not ENOENT. Which of the two it really was
    // is decided by the caller, by looking again.
    const locked = line.match(/open\("(.+)"\): Permission denied\s*$/);
    if (locked) denied.add(unquoteGitPath(locked[1]));
  }
  for (const line of complaints) {
    if (/No such file or directory\s*$/.test(line) || /did not match any files\s*$/.test(line) || /Permission denied\s*$/.test(line)) continue;
    // "unable to index file" is only ever a second line about a failure already
    // reported above. On its own, or about some other file, it is a real
    // problem with the user's project and must not be swallowed.
    const consequence = line.match(/unable to index file '(.+)'\s*$/);
    if (consequence) {
      const path = unquoteGitPath(consequence[1]);
      if (vanished.has(path) || denied.has(path)) continue;
    }
    return null;
  }
  return vanished.size || denied.size ? { vanished: [...vanished], denied: [...denied] } : null;
}

const ADD_ATTEMPTS = 3;

/**
 * `git add` that survives a file disappearing while it runs.
 *
 * A path can be enumerated and gone microseconds later, and both happen
 * constantly in a live project: editors save atomically (write `foo.tex.tmp`,
 * rename over), TeX runs drop and delete scratch files, Dropbox shuffles its
 * own. `git add` treats that as fatal and abandons the whole run, so ONE such
 * file failed the entire checkpoint — history got a hole in it, the working
 * diff came back empty, and resolve_comment answered 409 "dirty" for a tree
 * nobody had touched. Measured under a temp file churning every 3 ms, 2 of 12
 * checkpoints died this way.
 *
 * `--ignore-errors` keeps everything else in the index when one file cannot be
 * read; retrying without the vanished paths covers the other shape of the same
 * race, where git rejects the pathspec before indexing anything at all. An
 * error that names a file which is STILL on disk — a figure locked by another
 * application, a permissions problem — is never swallowed: that one is real,
 * and a snapshot silently missing the user's file is exactly what must not
 * happen here.
 */
async function addTolerantOfVanishing(
  root: string,
  prefix: string[],
  paths: string[] | null,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let batch = paths;
  for (let attempt = 1; ; attempt++) {
    try {
      await git(root, batch === null ? prefix : [...prefix, ...batch], env);
      return;
    } catch (error) {
      const failure = classifyAddFailure(error);
      if (!failure) throw error;
      // A "Permission denied" about a path that is gone now was a file caught
      // mid-deletion (Windows keeps the name until the last handle closes); one
      // that is still there gets another try once that handle has had time to
      // close, and stays a real error if it still cannot be read — a locked
      // figure must fail the snapshot, not silently drop out of it.
      const stillThere = failure.denied.filter((path) => existsSync(join(root, path)));
      const vanished = [...failure.vanished, ...failure.denied.filter((path) => !stillThere.includes(path))];
      if (stillThere.length) {
        if (attempt >= ADD_ATTEMPTS) throw error;
        await new Promise((done) => setTimeout(done, 50 * attempt));
        continue;
      }
      // A whole-tree add with --ignore-errors has already indexed everything
      // that was still there, so there is nothing left to do about a file that
      // was not — and nothing to retry.
      if (batch === null) return;
      const survivors = batch.filter((path) => !vanished.includes(path));
      if (survivors.length === batch.length || attempt >= ADD_ATTEMPTS) throw error;
      batch = survivors;
      if (!batch.length) return;
    }
  }
}

/** Hash the working tree through a private index, without changing a ref. The
 * resulting tree object is immutable even if an editor saves again later. */
async function writeCurrentTree(root: string, ENV: NodeJS.ProcessEnv): Promise<string> {
  const idx = join(tmpdir(), `latex-ckpt-${randomBytes(6).toString('hex')}.index`);
  // LC_ALL so git's diagnostics stay English: addTolerantOfVanishing has to
  // tell an `error:` line from a `warning:` one to decide whether a failure was
  // a vanished scratch file or a real problem with the user's paper.
  const env = { ...ENV, GIT_INDEX_FILE: idx, LC_ALL: 'C' };
  try {
    await addTolerantOfVanishing(root, ['add', '-A', '--ignore-errors', ...EXCLUDE_TOOL], null, env);
    // A paper's own compiler inputs are part of the rendered version even when
    // the author's ordinary .gitignore hides them (generated .bib/.tex files
    // and figures are common examples). Force only TeX-relevant inputs into the
    // private checkpoint index; this never touches the user's real index.
    const forced = await collectForcedCompileInputs(root);
    // Stay below Windows' command-line length limit on figure-heavy projects.
    for (let at = 0; at < forced.length; at += 100) {
      await addTolerantOfVanishing(root, ['add', '-f', '--ignore-errors', '--'], forced.slice(at, at + 100), env);
    }
    // `git add -A` is deliberately broad so uncommon but real paper inputs
    // are recoverable. Remove only files we can identify as generated output:
    // LaTeX auxiliaries, interpreter caches, and a PDF that has a same-stem TeX
    // source (the compiled document). Standalone PDF figures remain tracked.
    const generated = await collectGeneratedOutputs(root);
    for (let at = 0; at < generated.length; at += 100) {
      await git(root, ['update-index', '--force-remove', '--', ...generated.slice(at, at + 100)], env);
    }
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
    // TeXChronicle's own state and agent configuration are not the user's paper.
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
  return withLock(root, async () => {
    const { env: ENV, mode } = await historyRepo(root);
    if (mode !== 'project' && mode !== 'shadow') return { created: false, reason: 'no-history' };
    const result = await createCheckpointUnlocked(root);
    if (result.sha) {
      try { await git(root, ['update-ref', SUCCESS_REF, result.sha], ENV); }
      catch (error) { return { created: false, reason: 'failed', error: String((error as Error).message ?? error) }; }
    }
    return result;
  });
}

/**
 * The successful-render marker, seeding it from the timeline on first use.
 *
 * SUCCESS_REF is newer than the feature. A project whose history was written by
 * an earlier release has REF and nothing else, so every reader of this marker
 * answered "there has never been a successful render" — `latestCheckpointSha`
 * returned undefined and `matchingCheckpointSha` reported the tree as dirty, so
 * resolve_comment refused to work at all until the author happened to trigger a
 * clean compile. Seeding is correct rather than merely convenient: before this
 * marker existed a checkpoint was only ever written after a successful render,
 * so the old tip IS the last known-good tree. Create-only (`update-ref` with an
 * empty old value), so a concurrent process that seeds first simply wins.
 */
async function successCheckpointSha(root: string, ENV: NodeJS.ProcessEnv): Promise<string | undefined> {
  const known = (await gitOrNull(root, ['rev-parse', '--verify', '-q', SUCCESS_REF], ENV))?.trim();
  if (known) return known;
  const tip = (await gitOrNull(root, ['rev-parse', '--verify', '-q', REF], ENV))?.trim();
  if (!tip) return undefined;
  await gitOrNull(root, ['update-ref', SUCCESS_REF, tip, ''], ENV);
  return (await gitOrNull(root, ['rev-parse', '--verify', '-q', SUCCESS_REF], ENV))?.trim() || tip;
}

/** The tip of the successful-render history, whether or not files have since
 * changed. Useful for anchoring a comment created on the currently shown PDF. */
export async function latestCheckpointSha(root: string): Promise<string | undefined> {
  const { env: ENV, mode } = await historyRepo(root);
  if (mode !== 'project' && mode !== 'shadow') return undefined;
  return successCheckpointSha(root, ENV);
}

/** The latest checkpoint only when it describes the files on disk right now.
 * Resolution uses this stricter form: a dirty or failed build must not be
 * labelled as the successful version that preceded it. */
export async function matchingCheckpointSha(root: string): Promise<{ sha?: string; dirty: boolean }> {
  return withLock(root, async () => {
    const { env: ENV, mode } = await historyRepo(root);
    // Resolution/verification is a provenance claim. With no history store or
    // no successful checkpoint there is nothing to prove, so fail closed.
    if (mode !== 'project' && mode !== 'shadow') return { dirty: true };
    const sha = await successCheckpointSha(root, ENV);
    if (!sha) return { dirty: true };
    try {
      const [currentTree, checkpointTree] = await Promise.all([
        writeCurrentTree(root, ENV),
        git(root, ['rev-parse', `${sha}^{tree}`], ENV).then((value) => value.trim()),
      ]);
      if (currentTree === checkpointTree) return { sha, dirty: false };
      // Equal hashes are the fast path, not the definition. Checkpoints written
      // before TeXChronicle stopped recording its own state also contain
      // .latex-preview and .claude, so their tree can never hash equal to one
      // written today even when every file of the paper is identical — which
      // left an upgraded project permanently "dirty" and unable to resolve a
      // comment. Ask the question the rest of history already asks: does
      // anything OUTSIDE the tool's own directories differ?
      const same = await gitOrNull(root, ['diff', '--quiet', ...SAFE_DIFF, checkpointTree, currentTree, ...EXCLUDE_TOOL], ENV);
      return same !== null ? { sha, dirty: false } : { dirty: true };
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
      const result = await commitTreeUnlocked(root, ENV, preparedTree);
      if (result.sha) await git(root, ['update-ref', SUCCESS_REF, result.sha], ENV);
      return result;
    } catch (e) {
      return { created: false, reason: 'failed', error: String((e as Error).message ?? e) };
    }
  });
}

const SHORTSTAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

// Hide non-paper noise everywhere history is read: TeXChronicle's own state (the
// comments store under .latex-preview) and Claude Code's editor/agent config
// (.claude — e.g. slash-command .md files). Neither is part of the user's
// paper. Passed as a git exclude pathspec — `git log -- <pathspec>` also
// limits to commits that touch something OUTSIDE the excluded paths, so a
// checkpoint whose only change was to .claude/.latex-preview doesn't show up
// as a confusing, paper-unrelated entry in the History timeline at all.
const EXCLUDE_TOOL = ['--', '.', ':(exclude).latex-preview', ':(exclude).claude'];
// History diffs must be self-contained. Git for Windows installations commonly
// configure PDF text conversion through `astextplain`; portable Git does not
// ship that helper, and a missing global diff program used to blank the entire
// code-diff pane whenever a project contained a PDF.
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv'];

// Inputs the bundled engine collects plus common data/code inputs read by real
// TeX packages. These are force-added only to TeXChronicle's private index, so a
// user's .gitignore still behaves exactly as they configured it everywhere else.
const COMPILE_INPUT_EXTENSIONS = new Set([
  '.tex', '.bib', '.bbl', '.cls', '.sty', '.bst', '.cfg', '.clo', '.def',
  '.ldf', '.fd', '.bbx', '.cbx', '.lbx', '.csv', '.tsv', '.dat', '.txt',
  '.json', '.yaml', '.yml', '.lua', '.py', '.r', '.png', '.jpg', '.jpeg',
  '.pdf', '.eps', '.svg', '.gif', '.ttf', '.otf',
]);
const CACHE_DIRS = new Set([
  'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv',
]);
const FORCE_SKIP_DIRS = new Set(['.git', '.latex-preview', '.claude', '.vscode', ...CACHE_DIRS]);
const GENERATED_SUFFIXES = [
  '.aux', '.log', '.nav', '.snm', '.toc', '.out', '.fls', '.fdb_latexmk',
  '.synctex', '.synctex.gz', '.blg', '.bcf', '.run.xml', '.lof', '.lot',
  '.vrb', '.xdv', '.dvi', '.ps', '.idx', '.ind', '.ilg', '.glo', '.gls',
  '.glg', '.acn', '.acr', '.alg', '.pyc', '.pyo',
];

async function collectForcedCompileInputs(root: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FORCE_SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && COMPILE_INPUT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        paths.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  await walk(root);
  return paths;
}

/** Paths that are products of compiling/interpreting the editable project.
 *
 * PDF needs a semantic rule rather than a blanket extension exclusion: a PDF
 * figure is a real input, while `chapter.tex` beside `chapter.pdf` identifies
 * the latter as a generated document. */
async function collectGeneratedOutputs(root: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLocaleLowerCase()));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.latex-preview' || entry.name === '.claude') continue;
        if (CACHE_DIRS.has(entry.name)) {
          const collectAll = async (cacheDir: string): Promise<void> => {
            for (const cached of await readdir(cacheDir, { withFileTypes: true }).catch(() => [])) {
              const cachedFull = join(cacheDir, cached.name);
              if (cached.isDirectory()) await collectAll(cachedFull);
              else if (cached.isFile()) paths.push(relative(root, cachedFull).split(sep).join('/'));
            }
          };
          await collectAll(full);
        } else {
          await walk(full);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLocaleLowerCase();
      const generatedSuffix = GENERATED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
      const compiledPdf = lower.endsWith('.pdf') && fileNames.has(`${lower.slice(0, -4)}.tex`);
      if (generatedSuffix || compiledPdf) paths.push(relative(root, full).split(sep).join('/'));
    }
  };
  await walk(root);
  return paths;
}

/** Newest-first list of checkpoints that touched the paper (a checkpoint whose
 *  only change was e.g. .claude/.latex-preview is filtered out). Empty when no
 *  such checkpoints / not a git repo. */
export async function listCheckpoints(root: string): Promise<Checkpoint[]> {
  const { env: ENV } = await historyRepo(root);
  const out = await gitOrNull(root, ['log', REF, '--format=@@@%H %cI', '--shortstat', ...EXCLUDE_TOOL], ENV);
  if (!out) return [];
  const renderNames = await readdir(join(root, '.latex-preview', 'renders')).catch(() => [] as string[]);
  const rendered = new Set(
    renderNames
      .filter((name) => name.endsWith('.pdf'))
      .map((name) => name.slice(0, -'.pdf'.length)),
  );
  const checkpoints: Checkpoint[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@@')) {
      const sp = line.indexOf(' ');
      const sha = line.slice(3, sp);
      checkpoints.push({
        sha,
        time: line.slice(sp + 1).trim(),
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        hasPdf: rendered.has(sha),
      });
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

/** Current source changes versus TeXChronicle's latest checkpoint.
 *
 * Shadow repositories intentionally have no checked-out HEAD, and ordinary
 * `git diff` also omits untracked files. Build a private current tree just as
 * checkpointing does, then compare two immutable trees so both new and edited
 * source files appear without touching the user's index. */
export async function getWorkingDiff(root: string): Promise<string> {
  const { env: ENV, mode } = await historyRepo(root);
  if (mode !== 'project' && mode !== 'shadow') return '';
  try {
    const currentTree = await writeCurrentTree(root, ENV);
    const checkpoint = (await gitOrNull(root, ['rev-parse', '--verify', '-q', REF], ENV))?.trim();
    const baseTree = checkpoint
      ? (await git(root, ['rev-parse', `${checkpoint}^{tree}`], ENV)).trim()
      : EMPTY_TREE;
    return await git(root, ['diff', ...SAFE_DIFF, baseTree, currentTree, ...EXCLUDE_TOOL], ENV);
  } catch {
    return '';
  }
}

/**
 * Drop TeXChronicle's own state and agent config from a restore index.
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
 * Never write back a file the safety snapshot no longer captures.
 *
 * Restore is only safe because the current files are checkpointed first, and
 * `writeCurrentTree` deliberately stopped capturing compiler output — .aux,
 * .out, .log, and a PDF that has a same-stem .tex beside it. Older checkpoints
 * DO contain those paths, and `checkout-index -a -f` writes every path in the
 * index it is handed. So restoring one wrote a stale `chapter.pdf` and
 * `notes.out` over the current ones while the snapshot taken a moment earlier
 * held neither: those bytes then existed nowhere at all, which is the one
 * outcome this whole feature promises cannot happen. (`.out` is a LaTeX
 * auxiliary by extension, but on a real desk it is just as likely to be an
 * author's own file.)
 *
 * The rule is therefore a containment, not a preference: the set of paths a
 * restore may WRITE must be a subset of the set a snapshot would CAPTURE.
 * Returned lowercase-posix so a single-file restore can say why it refused.
 */
async function dropUncapturedPathsFromIndex(root: string, env: NodeJS.ProcessEnv): Promise<Set<string>> {
  // -z: raw bytes, so a non-ASCII filename is not handed back C-quoted.
  const listed = await gitOrNull(root, ['ls-files', '-z'], env);
  const paths = (listed ?? '').split('\0').filter(Boolean);
  const inTree = new Set(paths.map((path) => path.toLocaleLowerCase()));
  const drop: string[] = [];
  const dropped = new Set<string>();
  for (const path of paths) {
    const lower = path.toLocaleLowerCase();
    const generated = lower.split('/').slice(0, -1).some((segment) => CACHE_DIRS.has(segment)) ||
      GENERATED_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ||
      // The compiled document, identified the same way the capture rules do it:
      // by a .tex of the same name beside it. Checked in the checkpoint AND on
      // disk, because a snapshot taken now would answer from disk.
      (lower.endsWith('.pdf') && (
        inTree.has(`${lower.slice(0, -4)}.tex`) ||
        await stat(resolve(root, `${path.slice(0, -4)}.tex`)).then(() => true, () => false)
      ));
    if (!generated) continue;
    drop.push(path);
    dropped.add(lower);
  }
  for (let at = 0; at < drop.length; at += 100) {
    await git(root, ['update-index', '--force-remove', '--', ...drop.slice(at, at + 100)], env);
  }
  return dropped;
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
        `Refusing to restore: TeXChronicle could not snapshot your current files first, so this could not be undone (${snapshot.error ?? snapshot.reason}). Nothing has been changed.`,
      );
    }
    const idx = join(tmpdir(), `latex-restore-${randomBytes(6).toString('hex')}.index`);
    const env = { ...ENV, GIT_INDEX_FILE: idx };
    try {
      await git(root, ['read-tree', sha], env);       // load the checkpoint tree into a temp index
      await dropToolPathsFromIndex(root, env);
      await dropUncapturedPathsFromIndex(root, env);
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
  // `checkout-index -f` handed a path that is now a DIRECTORY removes the
  // directory — with everything inside it — and writes the file in its place,
  // reporting success. The author asked to revert one file and lost a folder of
  // work they never named. Refuse instead, and say what to do about it.
  const occupying = await stat(resolve(root, rel)).catch(() => null);
  if (occupying?.isDirectory()) {
    throw new Error(`Cannot restore ${rel}: a folder now occupies that path. Move or delete it first.`);
  }
  await withLock(root, async () => {
    // The point of this line is that the restore is reversible. If it failed,
    // it is not — so refuse rather than overwrite the working tree and discard
    // whatever was in it. 'unchanged' is fine: the previous checkpoint already
    // holds exactly this state.
    const snapshot = await createCheckpointUnlocked(root);
    if (!snapshot.created && snapshot.reason !== 'unchanged') {
      throw new Error(
        `Refusing to restore: TeXChronicle could not snapshot your current files first, so this could not be undone (${snapshot.error ?? snapshot.reason}). Nothing has been changed.`,
      );
    }
    const idx = join(tmpdir(), `latex-restorefile-${randomBytes(6).toString('hex')}.index`);
    const env = { ...ENV, GIT_INDEX_FILE: idx };
    try {
      await git(root, ['read-tree', sha], env);
      await dropToolPathsFromIndex(root, env);
      const uncaptured = await dropUncapturedPathsFromIndex(root, env);
      if (uncaptured.has(rel.replace(/\\/g, '/').toLocaleLowerCase())) {
        throw new Error(
          `Cannot restore ${rel}: TeXChronicle no longer snapshots generated files like this one, so the version on disk exists in no checkpoint and restoring it would be one-way.`,
        );
      }
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
  return git(root, ['diff', ...SAFE_DIFF, base, sha, ...EXCLUDE_TOOL], ENV);
}
