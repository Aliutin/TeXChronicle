import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, listCheckpoints, restoreFile } from '../src/git/checkpoints.js';

// A review reported that `git checkout-index -- <arg>` reads <arg> as a pathspec,
// so `path=*` would turn the per-file restore into a whole-tree revert.
//
// It does not. Measured against real git:
//
//   $ git checkout-index -f -- '*'
//   git checkout-index: * is not in the cache        (exit 1, nothing written)
//
// checkout-index is plumbing and looks entries up in the index by exact name.
// The "fix" for the reported bug — prefixing with `:(literal)` — broke the real
// feature for the same reason, and this file caught that.
//
// These tests stay because the claim was plausible and the behaviour is not
// obvious: if a future git starts interpreting these arguments, a red test here
// is how we find out, rather than a user losing an afternoon's edits.

// git's core.autocrlf rewrites LF to CRLF on checkout on Windows, so a file that
// has been through git does not come back byte-identical to what was written.
// Comparing raw content made two of these fail while restoreFile was working
// perfectly — the test being wrong about the platform, not the code.
const lines = (s: string) => s.split('\r\n').join('\n');

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-pathspec-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(root, 'main.tex'), 'v1 main\n');
  writeFileSync(join(root, 'intro.tex'), 'v1 intro\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

test('a glob never reverts a file it did not name', async () => {
  const root = repo();
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);
  assert.ok(cp, 'expected a checkpoint');

  writeFileSync(join(root, 'main.tex'), 'v2 main\n');
  writeFileSync(join(root, 'intro.tex'), 'v2 intro\n');

  for (const evil of ['*', '*.tex', ':(glob)**/*.tex', '?ain.tex', '[mi]*.tex']) {
    // Either refused by us, or refused by git as "not in the cache" — what
    // matters is that neither file moves.
    await restoreFile(root, cp.sha, evil).catch(() => {});
    assert.equal(lines(readFileSync(join(root, 'main.tex'), 'utf8')), 'v2 main\n', `"${evil}" reverted main.tex`);
    assert.equal(lines(readFileSync(join(root, 'intro.tex'), 'utf8')), 'v2 intro\n', `"${evil}" reverted intro.tex`);
  }
});

test('restoring one real file still works, and touches only that file', async () => {
  // The guard is worthless if it breaks the feature — and the first attempt at
  // one did exactly that, failing here with ":(literal)main.tex is not in the
  // cache" before anything shipped.
  const root = repo();
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);

  writeFileSync(join(root, 'main.tex'), 'v2 main\n');
  writeFileSync(join(root, 'intro.tex'), 'v2 intro\n');

  await restoreFile(root, cp.sha, 'main.tex');

  assert.equal(lines(readFileSync(join(root, 'main.tex'), 'utf8')), 'v1 main\n', 'the named file was not restored');
  assert.equal(lines(readFileSync(join(root, 'intro.tex'), 'utf8')), 'v2 intro\n', 'an unnamed file was reverted too');
});

test('traversal is rejected before git ever sees it', async () => {
  const root = repo();
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);
  for (const bad of ['../outside.tex', '..\\outside.tex', '', '.', 'a/../../b.tex']) {
    await assert.rejects(() => restoreFile(root, cp.sha, bad), `"${bad}" was accepted`);
  }
});

test('a folder standing where the file was is refused, not deleted', async () => {
  // `checkout-index -f` handed a path that is now a directory removes the
  // directory — everything in it — and writes the file in its place, reporting
  // success. The author asked to revert one file and lost a folder of work they
  // never named, with nothing in the UI to suggest it had happened.
  const root = repo();
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);

  unlinkSync(join(root, 'intro.tex'));
  mkdirSync(join(root, 'intro.tex'));
  writeFileSync(join(root, 'intro.tex', 'inner.txt'), 'user data inside');

  await assert.rejects(
    () => restoreFile(root, cp.sha, 'intro.tex'),
    /a folder now occupies that path/,
  );
  assert.ok(statSync(join(root, 'intro.tex')).isDirectory(), 'the folder was replaced by a file');
  assert.ok(existsSync(join(root, 'intro.tex', 'inner.txt')), 'the folder\'s contents were destroyed');
});

test('restoring a file that has since been deleted still works', async () => {
  // The refusal above must not become a refusal to restore anything missing —
  // "I deleted this by accident, put it back" is the feature.
  const root = repo();
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);
  unlinkSync(join(root, 'intro.tex'));
  await restoreFile(root, cp.sha, 'intro.tex');
  assert.equal(lines(readFileSync(join(root, 'intro.tex'), 'utf8')), 'v1 intro\n');
});

test('a legitimate filename containing dots is not rejected', async () => {
  // The check is segment-wise, not `includes('..')` — the latter also refuses a
  // real file called notes..old.tex.
  const root = repo();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'notes..old.tex'), 'v1 notes\n');
  git('add', '-A');
  git('commit', '-qm', 'notes');
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);

  writeFileSync(join(root, 'notes..old.tex'), 'v2 notes\n');
  await restoreFile(root, cp.sha, 'notes..old.tex');
  assert.equal(lines(readFileSync(join(root, 'notes..old.tex'), 'utf8')), 'v1 notes\n');
});
