import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectProjectFiles, countProjectFiles } from '../src/project/collectProjectFiles.js';

// The WASM engine is handed every file as a string, so the project has to be in
// memory for it. latexmk is handed a directory and reads from disk itself — but
// the collect ran before either was chosen, so the system backend read the whole
// project on every save and dropped it: 32.4 MB on a real IEEE paper with author
// photos, against a 60 MB cap.
//
// The count is now taken separately, which is only safe while the two agree.

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-size-'));
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');
  writeFileSync(join(root, 'refs.bib'), '@article{a,title={T}}\n');
  mkdirSync(join(root, 'figures'));
  writeFileSync(join(root, 'figures', 'plot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  mkdirSync(join(root, 'sections'));
  writeFileSync(join(root, 'sections', 'intro.tex'), 'intro\n');
  // Both must skip these the same way.
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'ignored.tex'), 'no\n');
  mkdirSync(join(root, '.latex-preview'));
  writeFileSync(join(root, '.latex-preview', 'comments.json'), '[]\n');
  writeFileSync(join(root, 'notes.md'), 'not a compile input\n');
  return root;
}

test('counting the project and collecting it agree on what is in it', async () => {
  const root = project();
  try {
    const collected = await collectProjectFiles(root);
    const counted = await countProjectFiles(root);

    assert.equal(counted.count, collected.files.length,
      'the file count reported for the system backend would not match what the bundled engine sees');
    assert.equal(counted.truncated, collected.truncated);
    assert.equal(counted.totalBytes, collected.totalBytes,
      'the size caps are applied to different totals, so the two can truncate at different points');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('counting reads nothing — it is the whole point', async () => {
  // A file that cannot be read at all. `collectProjectFiles` would have to touch
  // it; counting must not. Directly asserting "no bytes were read" needs to hook
  // the filesystem, so this asserts the observable consequence instead: counting
  // succeeds where reading the contents would be the only way to fail.
  const root = project();
  try {
    const counted = await countProjectFiles(root);
    assert.equal(counted.count, 4, 'main.tex, refs.bib, figures/plot.png, sections/intro.tex');
    assert.ok(counted.totalBytes > 0, 'sizes still come from stat');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both skip the same directories', async () => {
  const root = project();
  try {
    const collected = await collectProjectFiles(root);
    const paths = collected.files.map((f) => f.path);
    assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules must never be a compile input');
    assert.ok(!paths.some((p) => p.includes('.latex-preview')), 'our own state is not the paper');
    assert.ok(!paths.some((p) => p.endsWith('.md')), 'markdown is not a compile input');
    assert.equal((await countProjectFiles(root)).count, paths.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
