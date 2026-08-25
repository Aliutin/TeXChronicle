import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseSyncTeXEdit, projectRelativeInput } from '../src/preview/synctex.js';
import { systemLatexmkArgs } from '../src/engine/systemTex.js';

test('system LaTeX always emits a SyncTeX map', () => {
  const args = systemLatexmkArgs('/tmp/build', 'paper.tex', 'pdflatex');
  assert.ok(args.includes('-synctex=1'));
});

test('an existing PDF without a map gets one forced upgrade build', () => {
  const ordinary = systemLatexmkArgs('/tmp/build', 'paper.tex', 'pdflatex', false, false);
  const upgrade = systemLatexmkArgs('/tmp/build', 'paper.tex', 'pdflatex', false, true);
  assert.ok(!ordinary.includes('-g'));
  assert.ok(upgrade.includes('-g'));
});

test('parses MiKTeX edit output and ignores its surrounding warnings', () => {
  const output = `synctex: warning\nSyncTeX result begin\nOutput:C:\\work\\build\\paper.pdf\nInput:C:\\work\\chapters\\intro.tex\nLine:117\nColumn:-1\nOffset:0\nSyncTeX result end\nmore warnings`;
  assert.deepEqual(parseSyncTeXEdit(output), {
    input: 'C:\\work\\chapters\\intro.tex',
    line: 117,
  });
});

test('never exposes a SyncTeX input outside the project', () => {
  const root = join(process.cwd(), 'project');
  assert.equal(projectRelativeInput(root, join(root, 'chapters', 'intro.tex')), 'chapters/intro.tex');
  assert.equal(projectRelativeInput(root, join(root, '..', 'other', 'secret.tex')), null);
});

// ── Relative SyncTeX inputs under a nested main file ─────────────────────────
//
// latexmk is invoked with `-cd`, so the engine runs in the main file's own
// directory. MiKTeX records absolute paths and never notices — verified on this
// machine, where `paper/main.tex` produced
// `Input:1:C:\...\i6-nested-main\paper\sections\body.tex`. TeX Live is reported
// to record them relative to that working directory instead, and resolving
// `sections/body.tex` against the PROJECT root yields `<root>/sections/body.tex`,
// which does not exist — so the guard rejects it and a PDF click returns nothing
// at all. Silently: the viewer simply does not jump, and nothing says why.

// A .synctex body as TeX Live would write it for `paper/main.tex`. The `Input:`
// records there carry a tag number; the `synctex edit` output we parse does not,
// which is why the resolution half is what these tests exercise.
const RELATIVE_SYNCTEX = [
  'SyncTeX Version:1',
  'Input:1:main.tex',
  'Input:2:sections/body.tex',
  'Output:pdf',
].join('\n');

test('a relative input resolves against the main file directory, not the project root', () => {
  const root = join(process.cwd(), 'project');
  const relative = RELATIVE_SYNCTEX.split('\n')
    .filter((l) => l.startsWith('Input:'))
    .map((l) => l.replace(/^Input:\d+:/, ''));
  assert.deepEqual(
    relative.map((input) => projectRelativeInput(root, input, 'paper')),
    ['paper/main.tex', 'paper/sections/body.tex'],
    'resolved against the root these become paths that do not exist, and the click is dropped',
  );
});

test('and an absolute input is unaffected by it', () => {
  // MiKTeX's case: the main directory is irrelevant, and must not corrupt it.
  const root = join(process.cwd(), 'project');
  assert.equal(
    projectRelativeInput(root, join(root, 'paper', 'sections', 'intro.tex'), 'paper'),
    'paper/sections/intro.tex',
  );
});

test('omitting the main directory keeps exactly the old behaviour', () => {
  // The caller in previewServer.ts is not ours to change in this pass, so the
  // five-argument call has to go on meaning what it meant.
  const root = join(process.cwd(), 'project');
  assert.equal(projectRelativeInput(root, 'chapters/intro.tex'), 'chapters/intro.tex');
});

test('a root-relative record still lands inside the project', () => {
  // If a distribution writes inputs relative to the project root after all, the
  // main-directory reading escapes and the root reading is used instead. Better
  // a second guess than a dropped click.
  const root = join(process.cwd(), 'project');
  assert.equal(projectRelativeInput(root, 'shared/macros.tex', 'paper'), 'paper/shared/macros.tex');
  assert.equal(projectRelativeInput(root, '../outside.tex', 'paper'), 'outside.tex',
    'still inside the project — one level up from paper/ is the root');
});

test('and nothing outside the project is ever exposed, main directory or not', () => {
  const root = join(process.cwd(), 'project');
  assert.equal(projectRelativeInput(root, '../../secrets/keys.tex', 'paper'), null);
  assert.equal(projectRelativeInput(root, join(root, '..', 'other', 'secret.tex'), 'paper'), null);
});

test('the whole chain, from what synctex prints to what the editor opens', () => {
  const root = join(process.cwd(), 'project');
  const output = 'SyncTeX result begin\nOutput:main.pdf\nInput:sections/body.tex\nLine:12\nColumn:-1\nSyncTeX result end';
  const parsed = parseSyncTeXEdit(output);
  assert.deepEqual(parsed, { input: 'sections/body.tex', line: 12 });
  assert.equal(projectRelativeInput(root, parsed!.input, 'paper'), 'paper/sections/body.tex');
});
