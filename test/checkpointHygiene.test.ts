import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, createSuccessfulCheckpoint, latestCheckpointSha } from '../src/git/checkpoints.js';
import { forgetHistoryRepo, historyRepo } from '../src/git/historyRepo.js';
import { git } from '../src/git/exec.js';

// What a checkpoint is allowed to cost, and what it is allowed to contain.
//
// Both questions have the same shape: `git add -A` is deliberately broad, and
// everything downstream of it is about narrowing that back down to the author's
// paper — without paying for the files that were never candidates, and without
// carrying the ones they told us to leave alone.

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-hygiene-'));
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Text\\end{document}\n');
  return root;
}

/** Every path the checkpoint recorded. */
async function recordedPaths(root: string, sha: string): Promise<string[]> {
  const { env } = await historyRepo(root);
  const listed = await git(root, ['ls-tree', '-r', '--name-only', sha], env);
  return listed.split(/\r?\n/).filter(Boolean);
}

/** A gitignored interpreter cache of the size real projects have. */
function venv(root: string, files: number): void {
  writeFileSync(join(root, '.gitignore'), '.venv/\n');
  for (let pkg = 0; pkg < files / 100; pkg++) {
    const dir = join(root, '.venv', 'Lib', 'site-packages', `pkg${pkg}`);
    mkdirSync(dir, { recursive: true });
    for (let module = 0; module < 100; module++) writeFileSync(join(dir, `mod${module}.py`), 'x');
  }
}

test('a large gitignored cache is neither recorded nor paid for', async () => {
  // The cost was real and it was on the critical path: collecting generated
  // output walked the whole cache directory and then handed every file in it to
  // `update-index --force-remove`, in batches of 100 with a process per batch —
  // thousands of paths git had never staged, because .gitignore had already
  // excluded them. Measured before the fix on a 4 000-file .venv: 606 ms bare,
  // 2 980 ms with the cache, and a tree is written twice per compile plus once
  // per working diff and once per resolve gate, all inside the project lock.
  const bare = project();
  const heavy = project();
  venv(heavy, 4000);
  try {
    forgetHistoryRepo();
    await createCheckpoint(bare);
    await createCheckpoint(heavy);

    writeFileSync(join(bare, 'main.tex'), 'edited\n');
    const bareStarted = Date.now();
    await createCheckpoint(bare);
    const bareMs = Date.now() - bareStarted;

    writeFileSync(join(heavy, 'main.tex'), 'edited\n');
    const heavyStarted = Date.now();
    const checkpoint = await createCheckpoint(heavy);
    const heavyMs = Date.now() - heavyStarted;

    assert.ok(checkpoint.sha);
    const recorded = await recordedPaths(heavy, checkpoint.sha!);
    assert.deepEqual(recorded.filter((path) => path.includes('.venv')), [],
      'a gitignored cache directory reached the checkpoint tree');
    // Generous on purpose: this is a guard against the cache costing seconds
    // again, not a benchmark. The regression it catches was +2.4 s.
    assert.ok(heavyMs - bareMs < 1500,
      `a 4 000-file gitignored cache added ${heavyMs - bareMs}ms to a checkpoint (bare ${bareMs}ms, with cache ${heavyMs}ms)`);
  } finally {
    forgetHistoryRepo();
    rmSync(bare, { recursive: true, force: true });
    rmSync(heavy, { recursive: true, force: true });
  }
});

test('a cache directory the author has NOT ignored is still kept out', async () => {
  // The walk this replaced existed for this case, and it still has to work: no
  // .gitignore at all, so `git add -A` really does stage node_modules.
  const root = project();
  try {
    forgetHistoryRepo();
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    const recorded = await recordedPaths(root, checkpoint.sha!);
    assert.deepEqual(recorded.filter((path) => path.includes('node_modules')), []);
    assert.ok(recorded.includes('main.tex'));
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('gitignored secrets are never forced into history, but generated inputs still are', async () => {
  // Forcing ignored files past .gitignore exists for one reason: a paper's own
  // generated compiler inputs — a .bib built by a script, a .tex table — are
  // part of the version that rendered. The extension list used to include
  // .json/.yaml/.py as "data inputs", so a gitignored credentials.json was
  // copied into the author's own repository objects under the hidden ref, from
  // where `git push --mirror`, every clone and every backup carried it — having
  // been gitignored precisely so that none of that would happen.
  const root = project();
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, '.gitignore'), [
      'credentials.json', '.env', 'deploy.py', 'settings.yaml',
      'refs.bib', 'generated.tex', 'plot.png', 'api-token.txt', 'secrets/',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'credentials.json'), '{"key":"AKIA-not-a-real-one"}\n');
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-not-a-real-one\n');
    writeFileSync(join(root, 'deploy.py'), 'print("ssh key goes here")\n');
    writeFileSync(join(root, 'settings.yaml'), 'password: hunter2\n');
    writeFileSync(join(root, 'api-token.txt'), 'ghp_not_a_real_token\n');
    mkdirSync(join(root, 'secrets'), { recursive: true });
    writeFileSync(join(root, 'secrets', 'notes.txt'), 'the recovery phrase\n');

    writeFileSync(join(root, 'refs.bib'), '@article{a, title={Generated}}\n');
    writeFileSync(join(root, 'generated.tex'), 'A GENERATED TABLE\n');
    writeFileSync(join(root, 'plot.png'), 'PNG BYTES');

    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    const recorded = await recordedPaths(root, checkpoint.sha!);

    for (const kept of ['refs.bib', 'generated.tex', 'plot.png']) {
      assert.ok(recorded.includes(kept), `the generated compiler input ${kept} was lost from the checkpoint`);
    }
    for (const secret of ['credentials.json', '.env', 'deploy.py', 'settings.yaml', 'api-token.txt', 'secrets/notes.txt']) {
      assert.ok(!recorded.includes(secret), `${secret} was gitignored and TeXChronicle stored it anyway`);
    }
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ignored file the author tracks anyway is still recorded', async () => {
  // The rule is about what we FORCE past .gitignore. A file the author has
  // actually added to their repository is theirs, whatever it is called.
  const root = project();
  try {
    forgetHistoryRepo();
    await git(root, ['init', '--quiet']);
    await git(root, ['config', 'user.email', 'a@b.c']);
    await git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'secret-santa.json'), '{"who":"me"}\n');
    await git(root, ['add', '-f', 'secret-santa.json']);
    await git(root, ['commit', '-m', 'tracked', '--quiet']);

    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    assert.ok((await recordedPaths(root, checkpoint.sha!)).includes('secret-santa.json'),
      'a file the author tracks was dropped from their own history');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('only an explicitly rendered checkpoint advances the successful-render marker', async () => {
  // The marker is a claim about a PDF: it names the version a reader saw, and
  // comment resolution is gated on it. `createCheckpoint` advanced it
  // unconditionally, so a plain snapshot — the honest reading of that name —
  // silently marked unrendered source as the last known-good version.
  const root = project();
  try {
    forgetHistoryRepo();
    const rendered = await createSuccessfulCheckpoint(root);
    assert.ok(rendered.sha);
    assert.equal(await latestCheckpointSha(root), rendered.sha);

    writeFileSync(join(root, 'main.tex'), 'unrendered\n');
    const snapshot = await createCheckpoint(root, { rendered: false });
    assert.ok(snapshot.sha);
    assert.notEqual(snapshot.sha, rendered.sha);
    assert.equal(await latestCheckpointSha(root), rendered.sha,
      'a snapshot that never rendered became the last known-good version');

    writeFileSync(join(root, 'main.tex'), 'rendered again\n');
    const next = await createSuccessfulCheckpoint(root);
    assert.equal(await latestCheckpointSha(root), next.sha);
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
