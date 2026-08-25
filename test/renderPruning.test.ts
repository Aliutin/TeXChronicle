import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, createSuccessfulCheckpoint } from '../src/git/checkpoints.js';
import { forgetHistoryRepo } from '../src/git/historyRepo.js';
import { saveRenderArtifact } from '../src/git/renderArtifacts.js';

// A render is written on every successful compile and nothing ever removed one,
// so `.latex-preview/renders/` grew by a whole PDF per save — inside the
// author's Dropbox folder, synchronised to every machine they own, with no
// setting and nothing on screen saying where the gigabytes had gone.

const pdf = (n: number) => new Uint8Array(Buffer.from(`%PDF-1.7\n% render ${n}\n`));
const info = { mainFile: 'main.tex', engine: 'xelatex', backend: 'wasm' };
const rendersDir = (root: string) => join(root, '.latex-preview', 'renders');
const stored = (root: string) => readdirSync(rendersDir(root)).filter((name) => name.endsWith('.pdf')).sort();
const settle = () => new Promise((done) => setTimeout(done, 20));

/** `count` checkpoints, each with its own stored render. Only the FIRST is a
 *  successful one, so the marker deliberately stays behind the newest. */
async function renderedHistory(root: string, count: number): Promise<string[]> {
  const shas: string[] = [];
  for (let n = 0; n < count; n++) {
    writeFileSync(join(root, 'main.tex'), `\\documentclass{article}\n\\begin{document}v${n}\\end{document}\n`);
    const checkpoint = n === 0
      ? await createSuccessfulCheckpoint(root)
      : await createCheckpoint(root, { rendered: false });
    assert.ok(checkpoint.sha, `checkpoint ${n} was not created`);
    await saveRenderArtifact(root, checkpoint.sha!, pdf(n), info);
    shas.push(checkpoint.sha!);
    await settle(); // distinct mtimes, so "newest" is not a coin toss
  }
  return shas;
}

async function withKeep<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TEXCHRONICLE_KEEP_RENDERS;
  if (value === undefined) delete process.env.TEXCHRONICLE_KEEP_RENDERS;
  else process.env.TEXCHRONICLE_KEEP_RENDERS = value;
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env.TEXCHRONICLE_KEEP_RENDERS;
    else process.env.TEXCHRONICLE_KEEP_RENDERS = previous;
  }
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-renders-'));
  forgetHistoryRepo();
  return root;
}

test('only the newest renders are kept, and the one on screen always is', async () => {
  const root = project();
  try {
    await withKeep('3', async () => {
      const shas = await renderedHistory(root, 5);
      const remaining = stored(root);
      // Three newest, plus the successful-render marker's own — which is the
      // PDF the workspace is showing and what comment resolution is anchored
      // to, and which after a restore is easily older than the newest three.
      assert.equal(remaining.length, 4, `expected 3 newest + the marker, got ${remaining.join(', ')}`);
      assert.ok(existsSync(join(rendersDir(root), `${shas[0]}.pdf`)),
        'the render the successful-render marker points at was deleted');
      for (const kept of shas.slice(2)) {
        assert.ok(existsSync(join(rendersDir(root), `${kept}.pdf`)), `a newest-3 render (${kept}) was deleted`);
      }
      assert.equal(existsSync(join(rendersDir(root), `${shas[1]}.pdf`)), false,
        'an old render was kept past the limit');
      // The sidecar goes with its PDF; a metadata file for a render that no
      // longer exists is just a smaller leak.
      assert.equal(existsSync(join(rendersDir(root), `${shas[1]}.json`)), false);
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('0 keeps every render, for anyone who wants the whole archive', async () => {
  const root = project();
  try {
    await withKeep('0', async () => {
      const shas = await renderedHistory(root, 5);
      assert.equal(stored(root).length, shas.length);
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the default keeps far more than anyone scrolls back through', async () => {
  const root = project();
  try {
    await withKeep(undefined, async () => {
      const shas = await renderedHistory(root, 4);
      assert.equal(stored(root).length, shas.length, 'the default limit pruned a four-render history');
    });
    // A meaningless setting must not silently mean "delete everything".
    await withKeep('not-a-number', async () => {
      assert.equal(stored(root).length, 4);
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
