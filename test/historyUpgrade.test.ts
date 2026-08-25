import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestCheckpointSha, listCheckpoints, matchingCheckpointSha, createCheckpoint } from '../src/git/checkpoints.js';
import { forgetHistoryRepo, historyRepo } from '../src/git/historyRepo.js';

// Opening a paper whose history was written by an earlier release.
//
// The successful-render marker (refs/latex-preview/successful) is newer than
// the feature. A history that predates it has only the timeline ref, so every
// reader of the marker answered "there has never been a successful render":
// latestCheckpointSha came back undefined and matchingCheckpointSha reported
// the tree as dirty, which made resolve_comment refuse to work at all until the
// author happened to trigger a clean compile. Nothing on screen explained it.

/** A history of the shape an earlier release left behind: a timeline ref, no
 *  success marker, and tool paths inside the recorded tree. */
function legacyHistory(root: string): string {
  const env = { ...process.env, ...historyEnv };
  const index = join(tmpdir(), `legacy-upgrade-${Math.random().toString(16).slice(2)}.index`);
  execFileSync('git', ['add', '-A', '--', '.'], { cwd: root, stdio: 'pipe', env: { ...env, GIT_INDEX_FILE: index } });
  const tree = execFileSync('git', ['write-tree'], { cwd: root, stdio: 'pipe', env: { ...env, GIT_INDEX_FILE: index } }).toString().trim();
  const sha = execFileSync('git', ['commit-tree', tree, '-m', 'checkpoint'], { cwd: root, stdio: 'pipe', env }).toString().trim();
  execFileSync('git', ['update-ref', 'refs/latex-preview/checkpoints', sha], { cwd: root, stdio: 'pipe', env });
  return sha;
}

let historyEnv: NodeJS.ProcessEnv = {};

async function upgradedProject(): Promise<{ root: string; legacy: string }> {
  forgetHistoryRepo();
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-upgrade-'));
  writeFileSync(join(root, 'main.tex'), 'v1\n');
  historyEnv = (await historyRepo(root)).env;
  return { root, legacy: legacyHistory(root) };
}

test('a history written before the success marker is adopted, not treated as empty', async () => {
  const { root, legacy } = await upgradedProject();
  try {
    assert.equal((await listCheckpoints(root)).length, 1, 'the legacy fixture has no timeline');
    // Before the marker existed a checkpoint was only ever written after a
    // successful render, so the old tip IS the last known-good tree.
    assert.equal(await latestCheckpointSha(root), legacy);
    const marker = execFileSync('git', ['rev-parse', 'refs/latex-preview/successful'], {
      cwd: root, stdio: 'pipe', env: { ...process.env, ...historyEnv },
    }).toString().trim();
    assert.equal(marker, legacy, 'the marker was answered from memory but never written');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an untouched upgraded project is clean, so a comment can be resolved', async () => {
  const { root, legacy } = await upgradedProject();
  try {
    // Equal tree hashes are the fast path, not the definition of clean: a
    // legacy checkpoint also recorded .latex-preview and .claude, so its tree
    // can never hash equal to one written today even when every file of the
    // paper is identical. The comparison has to exclude the tool's own paths,
    // exactly as the History timeline and the working diff already do.
    assert.deepEqual(await matchingCheckpointSha(root), { sha: legacy, dirty: false });

    // And it must still notice a real edit.
    writeFileSync(join(root, 'main.tex'), 'v2\n');
    assert.deepEqual(await matchingCheckpointSha(root), { dirty: true });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seeding happens once and then gets out of the way', async () => {
  const { root, legacy } = await upgradedProject();
  try {
    await latestCheckpointSha(root);
    writeFileSync(join(root, 'main.tex'), 'v2\n');
    const next = await createCheckpoint(root);
    assert.equal(next.created, true);
    // A later successful render moves the marker normally; the seed must not
    // pin it to the old tip or keep re-applying itself.
    assert.equal(await latestCheckpointSha(root), next.sha);
    assert.notEqual(next.sha, legacy);
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
