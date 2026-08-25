import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from '../src/git/checkpoints.js';
import { historyRepo, forgetHistoryRepo } from '../src/git/historyRepo.js';
import { cacheRoot, legacyCacheRoot } from '../src/engine/assetsDir.js';

// History was keyed by a hash of the project PATH, so it belonged to the path
// rather than to the project. Rename a folder and the timeline was gone; reuse a
// path and the new project inherited a deleted one's checkpoints, with Restore
// standing by to write that other paper's files over it.

// Every test here redirects the per-user cache into a temp dir. Two reasons: the
// migration path reads the real one, and against the UNFIXED code these tests
// create shadow repos full of the fixture's text — which would otherwise be left
// in the developer's own legacy cache/history forever, which is itself one of
// the things being fixed.
const HOME_VARS = ['LOCALAPPDATA', 'XDG_CACHE_HOME', 'HOME'] as const;
const saved: Record<string, string | undefined> = {};
let fakeCache: string;

before(() => {
  fakeCache = mkdtempSync(join(tmpdir(), 'texchronicle-cache-'));
  for (const k of HOME_VARS) { saved[k] = process.env[k]; process.env[k] = fakeCache; }
});
after(() => {
  for (const k of HOME_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(fakeCache, { recursive: true, force: true });
});

/**
 * Exactly how <= 0.1.8 chose the directory. Written out here rather than
 * imported: it pins the on-disk layout the migration has to read, so it keeps
 * meaning what it means even if our own code stops agreeing.
 *
 * `realpath`, not `realpathSync` — on Windows the async one expands an 8.3 short
 * name (`C:\Users\APERSON~1\…` -> `C:\Users\A Person\…`) and the sync one returns
 * it as given. Using the wrong one here produced a different hash from the same
 * directory, and the migration test failed against the working migration.
 */
async function legacyDir(root: string): Promise<string> {
  let key = await realpath(root);
  if (process.platform === 'win32') key = key.toLowerCase();
  return join(legacyCacheRoot(), 'history', createHash('sha256').update(key).digest('hex').slice(0, 16));
}

/** A plain (non-git) project folder — the case the shadow repo exists for. */
function plainProject(text = 'ORIGINAL\n'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'texchronicle-id-')));
  writeFileSync(join(root, 'main.tex'), text);
  return root;
}

const trash: string[] = [];
const cleanup = (p: string) => { trash.push(p); return p; };
after(() => { for (const p of trash) rmSync(p, { recursive: true, force: true }); });

test('renaming a project keeps its history', async () => {
  forgetHistoryRepo();
  const root = cleanup(plainProject());
  const first = await createCheckpoint(root);
  assert.ok(first.created, `no checkpoint to begin with: ${JSON.stringify(first)}`);

  // The author renames the folder in Finder/Explorer — draft -> submitted.
  const moved = cleanup(join(dirname(root), `renamed-${Math.random().toString(16).slice(2)}`));
  renameSync(root, moved);
  forgetHistoryRepo();

  const after = await listCheckpoints(moved);
  assert.equal(after.length, 1,
    'the timeline was lost by renaming the folder — history followed the path, not the paper');
});

test('a new project at a reused path does not inherit the old one\'s history', async () => {
  // The dangerous half. ~/papers/draft is deleted and a different paper is
  // started under the same name; the History panel then shows the deleted
  // paper's checkpoints as this one's own past, and Restore writes its files
  // over the new paper.
  forgetHistoryRepo();
  const path = cleanup(plainProject('THE FIRST PAPER\n'));
  await createCheckpoint(path);

  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'main.tex'), 'A COMPLETELY DIFFERENT PAPER\n');
  forgetHistoryRepo();

  const inherited = await listCheckpoints(path);
  assert.equal(inherited.length, 0,
    'the new project was shown a deleted project\'s checkpoints as its own history');

  // And the consequence, spelled out: nothing can put the old text back.
  for (const cp of inherited) await restoreCheckpoint(path, cp.sha).catch(() => {});
  assert.match(readFileSync(join(path, 'main.tex'), 'utf8'), /COMPLETELY DIFFERENT/,
    'restoring wrote a different project\'s paper over this one');
});

test('a copy of a project gets its own history, not a shared one', async () => {
  forgetHistoryRepo();
  const original = cleanup(plainProject('SHARED START\n'));
  await createCheckpoint(original);

  const copy = cleanup(join(dirname(original), `copy-${Math.random().toString(16).slice(2)}`));
  cpSync(original, copy, { recursive: true });
  forgetHistoryRepo();

  writeFileSync(join(copy, 'main.tex'), 'ONLY IN THE COPY\n');
  await createCheckpoint(copy);
  forgetHistoryRepo();

  assert.equal((await listCheckpoints(copy)).length, 2, 'the copy did not record its own edit');
  assert.equal((await listCheckpoints(original)).length, 1,
    'an edit made in the copy appeared in the original\'s timeline — one history for two projects');
});

test('history is deleted with the project it belongs to', async () => {
  // Deleting a paper used to leave its full text in the per-user cache, with
  // nothing that would ever clean it up.
  forgetHistoryRepo();
  const root = cleanup(plainProject('CONFIDENTIAL SUBMISSION\n'));
  await createCheckpoint(root);
  const stray = join(cacheRoot(), 'history');
  const left = existsSync(stray) ? readdirSync(stray).length : 0;
  assert.equal(left, 0, `the paper's text was left behind outside the project, in ${stray}`);
});

test('a 0.1.8 cached history is brought forward when it is provably this project\'s', async () => {
  forgetHistoryRepo();
  const root = cleanup(plainProject('CARRIED FORWARD\n'));
  const legacy = await legacyDir(root);
  mkdirSync(legacy, { recursive: true });
  const env = { ...process.env, GIT_DIR: legacy, GIT_WORK_TREE: root, GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@l', GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@l' };
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, env, stdio: 'pipe' }).toString().trim();
  g('init', '--quiet');
  const idx = join(tmpdir(), `legacy-${Math.random().toString(16).slice(2)}.index`);
  const gi = (...a: string[]) => execFileSync('git', a, { cwd: root, env: { ...env, GIT_INDEX_FILE: idx }, stdio: 'pipe' }).toString().trim();
  gi('add', '-A');
  const tree = gi('write-tree');
  const sha = g('commit-tree', tree, '-m', 'checkpoint from 0.1.8');
  g('update-ref', 'refs/latex-preview/checkpoints', sha);

  const r = await historyRepo(root);
  assert.equal(r.mode, 'shadow');
  assert.equal((await listCheckpoints(root)).length, 1, 'the pre-upgrade timeline was dropped on the floor');
  assert.ok(!existsSync(join(legacy, 'HEAD')), 'the cached copy was left behind as well as moved');
});

test('a 0.1.8 cached history for a DIFFERENT project is not adopted', async () => {
  // The migration must not carry the bug across. This cache entry is keyed by
  // the path this project now occupies, but it records another paper.
  forgetHistoryRepo();
  const root = cleanup(plainProject('THIS PAPER\n'));
  const legacy = await legacyDir(root);
  mkdirSync(legacy, { recursive: true });
  const env = { ...process.env, GIT_DIR: legacy, GIT_WORK_TREE: root, GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@l', GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@l' };
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, env, stdio: 'pipe' }).toString().trim();
  g('init', '--quiet');
  // Record a different paper's bytes at the same paths.
  const other = cleanup(plainProject('SOMEBODY ELSE\'S PAPER\n'));
  const idx = join(tmpdir(), `legacy-${Math.random().toString(16).slice(2)}.index`);
  const otherEnv = { ...env, GIT_WORK_TREE: other, GIT_INDEX_FILE: idx };
  execFileSync('git', ['add', '-A'], { cwd: other, env: otherEnv, stdio: 'pipe' });
  const tree = execFileSync('git', ['write-tree'], { cwd: other, env: otherEnv, stdio: 'pipe' }).toString().trim();
  const sha = g('commit-tree', tree, '-m', 'a different paper');
  g('update-ref', 'refs/latex-preview/checkpoints', sha);

  await historyRepo(root);
  assert.equal((await listCheckpoints(root)).length, 0,
    'the migration adopted another project\'s history — the same bug, carried forward');
  assert.match(readFileSync(join(root, 'main.tex'), 'utf8'), /THIS PAPER/);
});

test('the shadow repo is kept out of the author\'s own commits', async () => {
  // A plain folder can become a git repo a week later. Without the ignore, the
  // author's first `git add -A` sweeps up a second copy of the paper and its
  // whole history as loose objects.
  forgetHistoryRepo();
  const root = cleanup(plainProject());
  await createCheckpoint(root);
  assert.ok(existsSync(join(root, '.latex-preview', 'history.git', 'HEAD')),
    'no shadow repo inside the project, so this test proves nothing');

  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  const staged = execFileSync('git', ['add', '-A', '-n', '--', '.'], { cwd: root, stdio: 'pipe' }).toString();
  assert.doesNotMatch(staged, /history\.git/,
    'the author\'s own `git add -A` would commit TeXChronicle\'s shadow repository');
});
