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
