import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MainFileError, resolveMainFile } from '../src/project/resolveMainFile.js';

const ARTICLE = '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n';

function project(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-mainfile-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content as never);
  }
  return root;
}

async function failure(root: string, explicit?: string): Promise<string> {
  try {
    const resolved = await resolveMainFile(root, explicit);
    assert.fail(`expected a MainFileError, got ${JSON.stringify(resolved)}`);
  } catch (e) {
    assert.ok(e instanceof MainFileError, `wrong error type: ${e}`);
    return (e as Error).message;
  }
}

test('an extensionless explicit main resolves to the real tex file', async () => {
  const root = project({ 'main.tex': ARTICLE, 'paper_20260818.tex': ARTICLE });
  try {
    assert.equal(await resolveMainFile(root, 'paper_20260818'), 'paper_20260818.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extensionless explicit paths work in subdirectories too', async () => {
  const root = project({ 'drafts/paper.tex': ARTICLE });
  try {
    assert.equal(await resolveMainFile(root, 'drafts/paper'), 'drafts/paper.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── an explicit main file is now checked before it is believed ───────────────
//
// All three of these used to be returned verbatim. `join(root, 'C:/other/
// main.tex')` on Windows produces a path that is not merely wrong but nonsense;
// the compile then went ahead with an empty source, skipped the bibliography
// pass, and reported success over a PDF whose citations were all `[?]`.

test('an absolute explicit main file is refused, not silently joined', async () => {
  const other = project({ 'main.tex': ARTICLE });
  const root = project({ 'paper.tex': ARTICLE });
  try {
    const msg = await failure(root, `${other.replace(/\\/g, '/')}/main.tex`);
    assert.match(msg, /inside the project/);
    assert.match(msg, /absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('a path that climbs out of the project is refused', async () => {
  const root = project({ 'paper.tex': ARTICLE });
  try {
    assert.match(await failure(root, '../sibling/main.tex'), /stay inside the project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a main file that is not there is an error, not a name to compile', async () => {
  const root = project({ 'paper.tex': ARTICLE });
  try {
    assert.match(await failure(root, 'does-not-exist.tex'), /Main file not found in the project: does-not-exist\.tex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare name whose file lives in a subdirectory is still found', async () => {
  // The lookup compileProject used to do for itself, now done where the answer
  // can be validated.
  const root = project({ 'paper/main.tex': ARTICLE });
  try {
    assert.equal(await resolveMainFile(root, 'main.tex'), 'paper/main.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── subfiles and standalone are not candidate roots ──────────────────────────

test('subfiles chapters are not candidate main files', async () => {
  // Every subfiles thesis whose root is not literally named main.tex used to
  // dead-end here, because each chapter carries a \documentclass of its own.
  const root = project({
    'paper.tex': '\\documentclass{article}\n\\usepackage{subfiles}\n\\begin{document}\n\\subfile{chapter1}\n\\end{document}\n',
    'chapter1.tex': '\\documentclass[paper.tex]{subfiles}\n\\begin{document}\nOne\n\\end{document}\n',
    'chapter2.tex': '\\documentclass[paper.tex]{subfiles}\n\\begin{document}\nTwo\n\\end{document}\n',
  });
  try {
    assert.equal(await resolveMainFile(root), 'paper.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone figures beside the paper are not candidate main files', async () => {
  const root = project({
    'paper.tex': ARTICLE,
    'fig1.tex': '\\documentclass{standalone}\n\\begin{document}\n\\end{document}\n',
    'fig2.tex': '\\documentclass[tikz]{standalone}\n\\begin{document}\n\\end{document}\n',
  });
  try {
    assert.equal(await resolveMainFile(root), 'paper.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── % !TEX root ──────────────────────────────────────────────────────────────

test('opening a chapter compiles the root it declares', async () => {
  const root = project({
    'thesis.tex': '\\documentclass{book}\n\\begin{document}\n\\include{chapters/intro}\n\\end{document}\n',
    'chapters/intro.tex': '% !TEX root = ../thesis.tex\n\\chapter{Intro}\nText.\n',
  });
  try {
    assert.equal(await resolveMainFile(root, 'chapters/intro.tex'), 'thesis.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a declared root collapses what would otherwise be a tie', async () => {
  const root = project({
    'thesis.tex': '\\documentclass{book}\n\\begin{document}\n\\end{document}\n',
    'appendix.tex': '%!TEX root=thesis.tex\n\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n',
  });
  try {
    assert.equal(await resolveMainFile(root), 'thesis.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a declared root pointing outside the project is ignored', async () => {
  const outside = project({ 'main.tex': ARTICLE });
  const root = project({ 'chapter.tex': `% !TEX root = ${outside.replace(/\\/g, '/')}/main.tex\n\\chapter{One}\n` });
  try {
    // Nothing to escape to: the one .tex left is returned on its own merits.
    assert.equal(await resolveMainFile(root, 'chapter.tex'), 'chapter.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── encodings and messages ───────────────────────────────────────────────────

test('a UTF-16 source is recognised as the document root', async () => {
  // What a Windows editor writes when someone picks "Unicode". Read as UTF-8 it
  // is a string of interleaved NULs and \documentclass is nowhere in it, so the
  // paper lost a tie against the author's notes file.
  const root = project({
    'paper.tex': Buffer.from('\ufeff' + ARTICLE, 'utf16le'),
    'notes.tex': 'notes only\n',
  });
  try {
    assert.equal(await resolveMainFile(root), 'paper.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('"none of these has a documentclass" is not reported as "too many candidates"', async () => {
  const root = project({ 'a.tex': 'text\n', 'b.tex': 'text\n' });
  try {
    const msg = await failure(root);
    assert.match(msg, /None of the \.tex files/);
    assert.match(msg, /\\documentclass/);
    assert.doesNotMatch(msg, /Multiple candidate/, 'they are not candidates; that is the whole problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a single .tex with no documentclass is still returned', async () => {
  const root = project({ 'fragment.tex': 'text\n' });
  try {
    assert.equal(await resolveMainFile(root), 'fragment.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the messages tell a CLI user something they can actually type', async () => {
  // "Pass mainFile" names the MCP tool's parameter. A CLI user types a
  // positional argument and has no such flag, and went looking for one.
  const root = project({ 'paper.tex': ARTICLE, 'poster.tex': ARTICLE });
  try {
    const msg = await failure(root);
    assert.match(msg, /texchronicle preview <file>\.tex/);
    assert.match(msg, /"mainFile" from an MCP client/, 'the MCP route must stay visible too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a main file only in a subdirectory is named in the error', async () => {
  const root = project({ 'src/main.tex': ARTICLE, 'README.md': 'x\n' });
  try {
    const msg = await failure(root);
    assert.match(msg, /src\/main\.tex/, 'the answer was sitting one directory down and went unmentioned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
