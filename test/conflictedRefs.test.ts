import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, historyStatus } from '../src/git/checkpoints.js';
import { forgetHistoryRepo, historyRepo } from '../src/git/historyRepo.js';
import { git, gitOrNull } from '../src/git/exec.js';

// A ref is a 41-byte file, and this history lives in a Dropbox folder by design.
// When two machines advance the same ref, Dropbox does not merge: it keeps one
// and renames the loser to "checkpoints (LAPTOP's conflicted copy 2025-08-24)".
// Git has never heard of that name, so everything the other machine wrote
// becomes unreferenced — invisible in History, and eligible for `git gc` to
// delete outright, with nothing said to the author about either.

const REF = 'refs/latex-preview/checkpoints';

async function paper(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-conflicted-'));
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Text\\end{document}\n');
  forgetHistoryRepo();
  return root;
}

const runner = async (root: string) => {
  const { env } = await historyRepo(root);
  return {
    env,
    run: (args: string[]) => git(root, args, env).then((out) => out.trim()),
    maybe: (args: string[]) => gitOrNull(root, args, env),
  };
};

/** The exact file Dropbox leaves behind, written by hand. */
function writeStray(gitDir: string, name: string, sha: string): string {
  const path = join(gitDir, 'refs', 'latex-preview', name);
  writeFileSync(path, sha + '\n');
  return path;
}

test('an orphaned conflicted copy is re-anchored where gc cannot reach it', async () => {
  const root = await paper();
  try {
    const first = await createCheckpoint(root);
    assert.ok(first.sha);
    const { run, maybe } = await runner(root);
    const gitDir = await run(['rev-parse', '--absolute-git-dir']);

    // What the other machine wrote: a checkpoint on top of the shared one that
    // this machine's ref file never came to name.
    const tree = await run(['rev-parse', `${first.sha}^{tree}`]);
    const orphan = await run(['commit-tree', tree, '-p', first.sha!, '-m', 'checkpoint from the laptop']);
    const stray = writeStray(gitDir, "checkpoints (LAPTOP's conflicted copy 2025-08-24)", orphan);
    assert.equal(await maybe(['merge-base', '--is-ancestor', orphan, REF]), null,
      'the fixture did not actually orphan the commit');

    forgetHistoryRepo();
    const status = await historyStatus(root);
    assert.equal(status.recoveredRefs?.length, 1, 'the orphaned chain was not reported');
    const recovered = status.recoveredRefs![0];
    assert.match(recovered, /^refs\/latex-preview\/recovered\/\d{8}-\d{6}-[0-9a-f]{7}$/);
    assert.equal(await run(['rev-parse', recovered]), orphan,
      'the recovery ref does not point at the checkpoints it was meant to save');
    assert.equal(existsSync(stray), false, 'the stray file was left for Dropbox to conflict again');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a conflicted copy that adds nothing is removed without inventing a ref', async () => {
  const root = await paper();
  try {
    const first = await createCheckpoint(root);
    writeFileSync(join(root, 'main.tex'), 'second\n');
    await createCheckpoint(root);
    const { run } = await runner(root);
    const gitDir = await run(['rev-parse', '--absolute-git-dir']);
    // The common case: both machines had this commit; Dropbox simply could not
    // decide which copy of the file to keep. Nothing to recover.
    const stray = writeStray(gitDir, 'checkpoints (conflicted copy 2025-08-24)', first.sha!);

    forgetHistoryRepo();
    const status = await historyStatus(root);
    assert.equal(status.recoveredRefs, undefined, 'a duplicate was reported as a rescue');
    assert.equal(existsSync(stray), false);
    assert.deepEqual((await run(['for-each-ref', '--format=%(refname)', 'refs/latex-preview/recovered']))
      .split(/\r?\n/).filter(Boolean), []);
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a conflicted copy naming a commit this machine does not have is left alone', async () => {
  const root = await paper();
  try {
    await createCheckpoint(root);
    const { run } = await runner(root);
    const gitDir = await run(['rev-parse', '--absolute-git-dir']);
    // Dropbox synchronises the 41-byte ref file long before the objects it
    // names. Deleting this would throw away the only record that those
    // checkpoints ever existed.
    const stray = writeStray(gitDir, 'checkpoints (DESKTOP conflicted copy 2025-08-24)', 'b'.repeat(40));

    forgetHistoryRepo();
    const status = await historyStatus(root);
    assert.equal(status.recoveredRefs, undefined);
    assert.equal(existsSync(stray), true, 'the only pointer to unsynced checkpoints was deleted');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery also works in the author\'s own repository', async () => {
  const root = await paper();
  try {
    await git(root, ['init', '--quiet']);
    await git(root, ['config', 'user.email', 'a@b.c']);
    await git(root, ['config', 'user.name', 'Test']);
    forgetHistoryRepo();
    const first = await createCheckpoint(root);
    assert.ok(first.sha, 'the project-mode checkpoint was not created');
    const { run, maybe } = await runner(root);
    const gitDir = await run(['rev-parse', '--absolute-git-dir']);
    const tree = await run(['rev-parse', `${first.sha}^{tree}`]);
    const orphan = await run(['commit-tree', tree, '-p', first.sha!, '-m', 'from the laptop']);
    const stray = writeStray(gitDir, "checkpoints (LAPTOP's conflicted copy 2025-08-24)", orphan);
    assert.equal(await maybe(['merge-base', '--is-ancestor', orphan, REF]), null);

    forgetHistoryRepo();
    const status = await historyStatus(root);
    assert.equal(status.mode, 'project');
    assert.equal(status.recoveredRefs?.length, 1);
    assert.equal(existsSync(stray), false);
    // The author's branches, HEAD and index are none of our business, and
    // reading a ref changed none of them.
    assert.equal(await run(['status', '--porcelain', '--untracked-files=no']), '');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
