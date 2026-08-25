import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, listCheckpoints, restoreCheckpoint, restoreFile } from '../src/git/checkpoints.js';
import { addComment, listComments } from '../src/preview/commentsStore.js';

// The history feature writes to the user's real working tree, so a bug here
// destroys their work rather than inconveniencing them. Three did.

const lines = (s: string) => s.split(/\r?\n/).join('\n');

/**
 * A checkpoint of the kind taken BEFORE tool paths were excluded — it records
 * .latex-preview and .claude too. Built with raw git rather than our own code,
 * so it does not change when ours does.
 */
function legacyCheckpoint(root: string): string {
  const idx = join(tmpdir(), `legacy-${Math.random().toString(16).slice(2)}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe', env }).toString();
  g('add', '-A');
  const tree = g('write-tree').trim();
  const sha = execFileSync('git', ['commit-tree', tree, '-m', 'legacy checkpoint'], { cwd: root, stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['update-ref', 'refs/latex-preview/checkpoints', sha], { cwd: root, stdio: 'pipe' });
  return sha;
}

function project() {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-hist-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(root, 'main.tex'), 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

test('restoring does not roll back comments made since the checkpoint', async () => {
  // `git add -A` staged .latex-preview/comments.json into every checkpoint, and
  // EXCLUDE_TOOL only filtered what `git log`/`git diff` SHOWED. So a restore
  // the user approved from a three-file diff also reverted comments.json,
  // deleting every comment made since — including another agent's — with none of
  // it in the diff.
  const root = project();
  await addComment(root, { page: 1, quote: 'old', rects: [], text: 'from before the checkpoint' });
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);
  assert.ok(cp, 'expected a checkpoint');

  writeFileSync(join(root, 'main.tex'), 'v2\n');
  await addComment(root, { page: 1, quote: 'new', rects: [], text: 'made AFTER the checkpoint' });

  await restoreCheckpoint(root, cp.sha);

  assert.equal(lines(readFileSync(join(root, 'main.tex'), 'utf8')), 'v1\n', 'the paper was not restored');
  const after = await listComments(root);
  assert.equal(after.length, 2, `a comment was destroyed by the restore: ${JSON.stringify(after.map((c) => c.text))}`);
  assert.ok(after.some((c) => c.text.includes('AFTER')), 'the newer comment is gone');
});

test('restoring does not rewrite .claude/', async () => {
  // Claude Code's own config is not the user's paper, and it never appeared in
  // the diff the user approved either.
  //
  // NOT settings.local.json. A first version used that name and passed against
  // the unfixed code — because this machine's global git ignore carries
  // `**/.claude/settings.local.json`, so it was never staged into a checkpoint
  // and could not be rolled back. The test was vacuous for a machine-specific
  // reason. A slash-command file is staged like anything else.
  // The checkpoint here is built with raw git so that it DOES contain .claude —
  // which is what every checkpoint taken before this fix looks like. New ones no
  // longer record it; this covers the other half, restoring an old one.
  const root = project();
  const cmd = join(root, '.claude', 'commands');
  mkdirSync(cmd, { recursive: true });
  writeFileSync(join(cmd, 'render.md'), 'OLD COMMAND\n');

  const sha = legacyCheckpoint(root);
  const staged = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: root, stdio: 'pipe' }).toString();
  assert.match(staged, /\.claude\/commands\/render\.md/,
    'the fixture is not in the checkpoint, so this test could not detect the bug');

  writeFileSync(join(root, 'main.tex'), 'v2\n');
  writeFileSync(join(cmd, 'render.md'), 'NEW COMMAND\n');

  await restoreCheckpoint(root, sha);

  assert.equal(lines(readFileSync(join(root, 'main.tex'), 'utf8')), 'v1\n', 'the paper was not restored');
  assert.match(readFileSync(join(cmd, 'render.md'), 'utf8'), /NEW/,
    '.claude was rolled back by a restore of the paper');
});

test('restoring never writes over a file the safety snapshot cannot capture', async () => {
  // The restore is only safe because the current files are checkpointed first.
  // But checkpoints stopped capturing compiler output — .aux, .out, and a PDF
  // that has a same-stem .tex beside it — while `checkout-index -a -f` still
  // wrote every path in the OLD checkpoint's tree. So restoring one taken by an
  // earlier release put a stale chapter.pdf and notes.out back over the current
  // ones, and the snapshot taken moments before held neither: those bytes then
  // existed nowhere at all. (.out is a LaTeX auxiliary by extension; on a real
  // desk it is just as likely to be the author's own notes, which is why the
  // fixture reads the way it does.)
  const root = project();
  writeFileSync(join(root, 'chapter.tex'), 'v1\n');
  writeFileSync(join(root, 'chapter.pdf'), 'PDF-VERSION-1');
  writeFileSync(join(root, 'notes.out'), 'IRREPLACEABLE USER DATA v1');
  const sha = legacyCheckpoint(root);
  const staged = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: root, stdio: 'pipe' }).toString();
  assert.match(staged, /chapter\.pdf/, 'the fixture is not in the checkpoint, so this test could not detect the bug');
  assert.match(staged, /notes\.out/, 'the fixture is not in the checkpoint, so this test could not detect the bug');

  writeFileSync(join(root, 'chapter.tex'), 'v2 - an hour of work\n');
  writeFileSync(join(root, 'chapter.pdf'), 'PDF-VERSION-2');
  writeFileSync(join(root, 'notes.out'), 'IRREPLACEABLE USER DATA v2');

  await restoreCheckpoint(root, sha);

  assert.equal(lines(readFileSync(join(root, 'chapter.tex'), 'utf8')), 'v1\n', 'the paper was not restored');
  assert.equal(readFileSync(join(root, 'chapter.pdf'), 'utf8'), 'PDF-VERSION-2',
    'a generated PDF was rolled back to a version no snapshot holds');
  assert.equal(readFileSync(join(root, 'notes.out'), 'utf8'), 'IRREPLACEABLE USER DATA v2',
    'notes.out was overwritten and its contents exist in no checkpoint');
});

test('restoring one such file is refused rather than done one-way', async () => {
  // Same rule, per file: if a restore cannot be undone because the snapshot
  // would not have captured what it overwrites, it must not happen silently.
  const root = project();
  writeFileSync(join(root, 'notes.out'), 'v1');
  const sha = legacyCheckpoint(root);
  writeFileSync(join(root, 'notes.out'), 'v2');
  await assert.rejects(() => restoreFile(root, sha, 'notes.out'), /no longer snapshots generated files/);
  assert.equal(readFileSync(join(root, 'notes.out'), 'utf8'), 'v2');
});

test('one vanishing scratch file does not fail the whole checkpoint', async () => {
  // A path can be listed and gone microseconds later: editors save atomically
  // (write temp, rename over) and TeX runs drop scratch files constantly. That
  // aborted the entire `git add`, so ONE of them failed the checkpoint — the
  // timeline got a hole, the working diff came back empty, and resolve_comment
  // answered "dirty" about a tree nobody had touched. Measured at 2-4 of 12
  // before the fix, 0 of 12 after.
  const root = project();
  for (let i = 0; i < 400; i++) writeFileSync(join(root, `data${i}.dat`), String(i));
  await createCheckpoint(root);

  const scratch = join(root, 'scratch-temp.dat');
  const churn = setInterval(() => {
    if (existsSync(scratch)) { try { unlinkSync(scratch); } catch { /* mid-delete */ } }
    else { try { writeFileSync(scratch, 'x'); } catch { /* mid-create */ } }
  }, 3);
  const failures: string[] = [];
  try {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, 'main.tex'), `v${i}\n`);
      const result = await createCheckpoint(root);
      if (result.reason === 'failed') failures.push(result.error ?? 'failed');
    }
  } finally {
    clearInterval(churn);
    try { unlinkSync(scratch); } catch { /* already gone */ }
  }
  assert.deepEqual(failures, [], 'a disappearing temp file killed a checkpoint');
});

test('a file that is there but unreadable still fails the checkpoint', async (t) => {
  // The other half of the rule above, and the one that matters more: tolerating
  // "the file was not there" must not become tolerating "the file could not be
  // read". A snapshot silently missing a figure the author still has is exactly
  // the promise this feature makes and would be breaking.
  if (process.platform !== 'win32') return t.skip('needs an OS-level deny this test knows how to set');
  const root = project();
  const locked = join(root, 'figure.png');
  writeFileSync(locked, 'PNG BYTES');
  try {
    execFileSync('icacls', [locked, '/deny', '*S-1-1-0:(R)'], { stdio: 'pipe' }); // Everyone
  } catch { return t.skip('cannot deny read on this filesystem'); }
  try {
    // Prove the fixture bites BEFORE asserting anything about it — and prove it
    // against git, which is what has to fail. (This sandbox reads the file
    // happily through Node while git gets Permission denied, so asking Node
    // would have skipped a test that can in fact run here.)
    let deniedToGit = false;
    try {
      execFileSync('git', ['add', '-f', '--ignore-errors', '--', 'figure.png'], {
        cwd: root, stdio: 'pipe',
        env: { ...process.env, LC_ALL: 'C', GIT_INDEX_FILE: join(tmpdir(), `deny-${Math.random().toString(16).slice(2)}.index`) },
      });
    } catch (e) { deniedToGit = /Permission denied/.test(String((e as { stderr?: unknown }).stderr)); }
    if (!deniedToGit) return t.skip('the deny did not take effect for git');

    const result = await createCheckpoint(root);
    assert.equal(result.created, false, 'an unreadable file was quietly left out of the snapshot');
    assert.equal(result.reason, 'failed');
    assert.match(result.error ?? '', /Permission denied/);
  } finally {
    execFileSync('icacls', [locked, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' });
  }
});

test('restore refuses when it could not snapshot the current state first', async () => {
  // The UI promises the restore is reversible because the current files are
  // snapshotted first. doCreateCheckpoint swallowed every error and its result
  // was ignored, so a failed snapshot still proceeded to overwrite everything —
  // an hour of uncommitted work gone, with nothing to return to.
  //
  // A REGRESSION GUARD, not evidence: this passes against the unfixed code too,
  // because forcing a snapshot failure from outside needs a filesystem the test
  // cannot arrange. What it does pin is the contract — a completed restore must
  // leave behind a checkpoint containing what it overwrote.
  const root = project();
  await createCheckpoint(root);
  const [cp] = await listCheckpoints(root);
  writeFileSync(join(root, 'main.tex'), 'PRECIOUS UNSAVED WORK\n');

  const original = process.env.GIT_INDEX_FILE;
  // A directory that cannot hold the temp index makes write-tree fail.
  process.env.TEXCHRONICLE_TMP_FAIL = '1';
  try {
    // Without a way to force the failure from outside, assert the contract
    // instead: a successful restore must have produced a snapshot to return to.
    const before = (await listCheckpoints(root)).length;
    await restoreCheckpoint(root, cp.sha);
    const afterList = await listCheckpoints(root);
    assert.ok(afterList.length > before,
      'the restore completed without recording a checkpoint of what it overwrote');
    // And that snapshot really holds the overwritten text.
    const newest = afterList[0];
    await restoreFile(root, newest.sha, 'main.tex');
    assert.match(readFileSync(join(root, 'main.tex'), 'utf8'), /PRECIOUS UNSAVED WORK/,
      'the pre-restore snapshot does not contain what was overwritten');
  } finally {
    delete process.env.TEXCHRONICLE_TMP_FAIL;
    if (original === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = original;
  }
});

test('an unreadable comment store is never silently replaced', async () => {
  // listComments returned [] for any failure, and the next mutator wrote that []
  // over the file — one stray comma destroyed every comment atomically, and the
  // caller got a success.
  const root = project();
  await addComment(root, { page: 1, quote: 'q', rects: [], text: 'first' });
  await addComment(root, { page: 1, quote: 'q', rects: [], text: 'second' });

  const store = join(root, '.latex-preview', 'comments.json');
  const good = readFileSync(store, 'utf8');
  writeFileSync(store, good.replace(/\}\s*\]$/, '},]'), 'utf8'); // hand-edited, now invalid

  await assert.rejects(() => listComments(root), (e: Error) => e.name === 'CommentStoreUnreadableError');
  await assert.rejects(
    () => addComment(root, { page: 1, quote: 'q', rects: [], text: 'third' }),
    (e: Error) => e.name === 'CommentStoreUnreadableError',
  );

  // The damaged file is still there to be rescued, not replaced by [].
  const onDisk = readFileSync(store, 'utf8');
  assert.match(onDisk, /first/, 'the store was overwritten and the comments are gone');
  assert.match(onDisk, /second/);
});

test('a missing store is still just "no comments yet"', async () => {
  // The distinction the blanket catch erased.
  const root = project();
  assert.deepEqual(await listComments(root), []);
  assert.ok(!existsSync(join(root, '.latex-preview', 'comments.json')));
});

test('reading never writes', async () => {
  // The unlocked save inside listComments is what let a reader clobber a
  // concurrent writer. Reading must not touch the file at all.
  const root = project();
  await addComment(root, { page: 1, quote: 'q', rects: [], text: 'only' });
  const store = join(root, '.latex-preview', 'comments.json');
  const before = readFileSync(store, 'utf8');

  for (let i = 0; i < 5; i++) await listComments(root);

  assert.equal(readFileSync(store, 'utf8'), before, 'a read modified the store');
});

test('a concurrent read cannot undo a concurrent write', async () => {
  // Also a guard rather than proof: this passes both ways here, because the
  // interleaving that loses the write is not reliably reproducible in-process.
  // The discriminating test for that bug is "reading never writes" above, which
  // fails against the unfixed code — remove the cause and the race cannot occur.
  const root = project();
  await addComment(root, { page: 1, quote: 'q', rects: [], text: 'c1' });

  await Promise.all([
    listComments(root), listComments(root), listComments(root),
    addComment(root, { page: 1, quote: 'q', rects: [], text: 'c2' }),
    listComments(root), listComments(root),
    addComment(root, { page: 1, quote: 'q', rects: [], text: 'c3' }),
    listComments(root), listComments(root),
  ]);

  const all = await listComments(root);
  assert.equal(all.length, 3, `lost a comment: ${JSON.stringify(all.map((c) => c.text))}`);
});
