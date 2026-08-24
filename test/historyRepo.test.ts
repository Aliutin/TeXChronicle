import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyRepo, forgetHistoryRepo } from '../src/git/historyRepo.js';

// The distinction these tests exist for: "no git" and "couldn't create the
// history store" are different problems with different answers, and they were a
// single state whose message always said the first. Someone whose cache was
// unwritable got told to install software they already had.

test('a plain folder gets a shadow repo', async () => {
  forgetHistoryRepo();
  const dir = mkdtempSync(join(tmpdir(), 'hr-plain-'));
  try {
    writeFileSync(join(dir, 'main.tex'), '');
    const r = await historyRepo(dir);
    assert.equal(r.mode, 'shadow');
    assert.equal(r.env.GIT_DIR, join(dir, '.latex-preview', 'history.git'),
      'history lives with the project, so it moves and is deleted with it');
    assert.equal(r.env.GIT_WORK_TREE, dir);
    assert.equal(r.detail, undefined, 'nothing went wrong, so nothing to explain');
  } finally {
    forgetHistoryRepo();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable history store reports where and why — not "no git"', async () => {
  // Put a regular file where the store's directory has to go. mkdir then fails
  // with ENOTDIR/EEXIST, which is the shape of every real cause here — bad
  // permissions, a full disk, a stale file where a directory should be.
  //
  // The blocker is `.latex-preview` itself rather than a redirected cache: the
  // store moved into the project, so that is now where creating it can fail.
  // Works the same on Windows, where chmod does not.
  const project = mkdtempSync(join(tmpdir(), 'hr-proj-'));
  writeFileSync(join(project, '.latex-preview'), 'this is a file, not a directory');
  try {
    forgetHistoryRepo();
    const r = await historyRepo(project);
    // On a machine without git this would be 'no-git' and the test would be
    // meaningless, so assert we're exercising the branch we think we are.
    assert.notEqual(r.mode, 'no-git', 'this machine must have git for the test to mean anything');
    assert.equal(r.mode, 'unwritable');
    assert.ok(r.detail, 'the reason must survive to the caller');
    assert.match(r.detail!, /\.latex-preview/, 'names the path it tried');
    assert.ok(r.detail!.length > '.latex-preview'.length + 2, 'and carries the OS error, not just the path');
  } finally {
    forgetHistoryRepo();
    rmSync(project, { recursive: true, force: true });
  }
});

test('an existing git repo is left alone', async () => {
  forgetHistoryRepo();
  const dir = mkdtempSync(join(tmpdir(), 'hr-repo-'));
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    const r = await historyRepo(dir);
    assert.equal(r.mode, 'project');
    assert.equal(r.env.GIT_DIR, undefined, 'no shadow repo — checkpoints belong in theirs');
  } finally {
    forgetHistoryRepo();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a project nested inside a larger git repo gets its own portable history', async () => {
  forgetHistoryRepo();
  const repository = mkdtempSync(join(tmpdir(), 'hr-parent-repo-'));
  const project = join(repository, 'papers', 'draft');
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'main.tex'), '');
    const r = await historyRepo(project);
    assert.equal(r.mode, 'shadow');
    assert.equal(r.env.GIT_DIR, join(project, '.latex-preview', 'history.git'));
    assert.equal(r.env.GIT_WORK_TREE, project,
      'the paper history must not be rooted at the parent repository');
  } finally {
    forgetHistoryRepo();
    rmSync(repository, { recursive: true, force: true });
  }
});
