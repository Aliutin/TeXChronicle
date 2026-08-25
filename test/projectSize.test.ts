import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectProjectFiles, countProjectFiles } from '../src/project/collectProjectFiles.js';

const paths = (r: { files: { path: string }[] }) => r.files.map((f) => f.path);

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
    const found = paths(collected);
    assert.ok(!found.some((p) => p.includes('node_modules')), 'node_modules must never be a compile input');
    assert.ok(!found.some((p) => p.includes('.latex-preview')), 'our own state is not the paper');
    assert.ok(!found.some((p) => p.endsWith('.md')), 'markdown is not a compile input');
    assert.equal((await countProjectFiles(root)).count, found.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the caps ────────────────────────────────────────────────────────────────
//
// Measured, not imagined: a thesis with 70 MB of plots under `figures/` and a
// 20 MB stale build PDF came back with 60 files, every one of them a PNG, and no
// main.tex at all. The engine compiled an empty string, said "Emergency stop",
// and nothing anywhere mentioned that the paper had been dropped.

test('a wall of figures cannot evict the paper it illustrates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-caps-'));
  try {
    mkdirSync(join(root, 'figures'));
    mkdirSync(join(root, 'sections'));
    const big = Buffer.alloc(1024 * 1024, 0x41); // 1 MB each, 70 MB in total
    for (let i = 0; i < 70; i++) writeFileSync(join(root, 'figures', `plot${String(i).padStart(3, '0')}.png`), big);
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');
    writeFileSync(join(root, 'refs.bib'), '@article{a,title={T}}\n');
    writeFileSync(join(root, 'sections', 'intro.tex'), 'intro\n');

    const collected = await collectProjectFiles(root, { mainFile: 'main.tex' });
    const found = paths(collected);
    assert.ok(collected.truncated, 'the fixture is deliberately over the 60 MB cap');
    assert.ok(found.includes('main.tex'), 'the document root was dropped in favour of its own illustrations');
    assert.ok(found.includes('refs.bib'), 'the bibliography is a text source and outranks a figure');
    assert.ok(found.includes('sections/intro.tex'), 'a chapter is not optional the way a figure is');
    assert.ok(collected.skippedFiles > 0 && collected.skippedBytes > 0, 'the caller has to be able to say what was left out');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the file-count cap cannot drop the main file either', async () => {
  // 900 tiny .tex under `aaa/`, which sorts before `main.tex`. Text-first
  // ordering alone does not save it — only exempting the document root does.
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-caps-n-'));
  try {
    mkdirSync(join(root, 'aaa'));
    for (let i = 0; i < 900; i++) writeFileSync(join(root, 'aaa', `f${String(i).padStart(4, '0')}.tex`), 'x\n');
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');

    const collected = await collectProjectFiles(root, { mainFile: 'main.tex' });
    assert.ok(collected.truncated);
    assert.ok(paths(collected).includes('main.tex'), 'a budget that can drop the document root is not a budget');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the project's own build output is not one of its inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-stale-'));
  try {
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}\n');
    writeFileSync(join(root, 'main.pdf'), Buffer.alloc(4 * 1024 * 1024, 0x42));
    writeFileSync(join(root, 'main.synctex.gz'), Buffer.alloc(1024, 0x43));
    writeFileSync(join(root, 'figure.pdf'), Buffer.alloc(16, 0x44));

    const collected = await collectProjectFiles(root, { mainFile: 'main.tex' });
    const found = paths(collected);
    assert.ok(!found.includes('main.pdf'), 'a stale 20 MB render was eating a third of the budget');
    assert.ok(!found.includes('main.synctex.gz'));
    assert.ok(found.includes('figure.pdf'), 'an ordinary PDF figure is still an input');
    assert.equal((await countProjectFiles(root, { mainFile: 'main.tex' })).count, found.length,
      'counting and collecting must agree about what a build output is');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Latin-1 paper reaches the engine byte-exact, not full of U+FFFD', async () => {
  // `\usepackage[latin1]{inputenc}` is still what a lot of older European theses
  // say. Read as UTF-8 the accents become replacement characters and the PDF
  // comes out full of question marks, with no error anywhere.
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-latin1-'));
  try {
    const latin1 = Buffer.concat([
      Buffer.from('\\documentclass{article}\n\\begin{document}\nCaf', 'ascii'),
      Buffer.from([0xe9]), // é in Latin-1, not valid UTF-8
      Buffer.from('\n\\end{document}\n', 'ascii'),
    ]);
    writeFileSync(join(root, 'main.tex'), latin1);
    writeFileSync(join(root, 'clean.tex'), 'plain ascii\n');

    const collected = await collectProjectFiles(root, { mainFile: 'main.tex' });
    const main = collected.files.find((f) => f.path === 'main.tex')!;
    assert.equal(main.encoding, 'base64', 'undecodable bytes were passed off as text');
    assert.deepEqual(Buffer.from(main.content, 'base64'), latin1, 'the engine must see the original bytes');
    assert.equal(collected.files.find((f) => f.path === 'clean.tex')!.encoding, 'utf8',
      'ordinary UTF-8 sources must not be base64-encoded for nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the extensions a real project actually ships are collected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-ext-'));
  try {
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n');
    // .bbl is how arXiv ships a bibliography; .pdf_tex is Inkscape's LaTeX
    // overlay; .csv is what pgfplots reads; .txt is a plain \input.
    for (const name of ['main.bbl', 'fig.pdf_tex', 'data.csv', 'notes.txt', 'style.ist', 'font.pfb']) {
      writeFileSync(join(root, name), 'x\n');
    }
    const found = paths(await collectProjectFiles(root, { mainFile: 'main.tex' }));
    for (const name of ['main.bbl', 'fig.pdf_tex', 'data.csv', 'notes.txt', 'style.ist', 'font.pfb']) {
      assert.ok(found.includes(name), `${name} was invisible to the engine, which reports it as an unrelated failure`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('textOnly reads no binaries but still describes the whole project', async () => {
  const root = project();
  try {
    const text = await collectProjectFiles(root, { textOnly: true });
    assert.ok(!paths(text).some((p) => p.endsWith('.png')), 'the figures are the bytes this option exists to avoid');
    assert.equal(text.count, (await countProjectFiles(root)).count,
      'the counts have to keep meaning "this project", not "what this call read"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
