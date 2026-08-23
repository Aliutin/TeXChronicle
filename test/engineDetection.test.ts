import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEngine } from '../src/project/compileProject.js';

test('ordinary and pdfTeX-specific papers use pdflatex', () => {
  assert.equal(detectEngine('\\documentclass{article}'), 'pdflatex');
  assert.equal(
    detectEngine('\\input{glyphtounicode}\n\\pdfgentounicode=1'),
    'pdflatex',
  );
});

test('fontspec and XeTeX primitives select xelatex', () => {
  assert.equal(detectEngine('\\usepackage{fontspec}'), 'xelatex');
  assert.equal(detectEngine('\\RequirePackage[quiet]{unicode-math}'), 'xelatex');
  assert.equal(detectEngine('\\XeTeXlinebreaklocale "en"'), 'xelatex');
});

test('Lua primitives select lualatex', () => {
  assert.equal(detectEngine('\\directlua{tex.print("hello")}'), 'lualatex');
  assert.equal(detectEngine('\\usepackage{luacode}'), 'lualatex');
});

test('editor magic comments override heuristic detection', () => {
  assert.equal(
    detectEngine('% !TeX program = lualatex\n\\usepackage{fontspec}'),
    'lualatex',
  );
  assert.equal(
    detectEngine('% !TEX TS-program = pdflatex\n\\usepackage{fontspec}'),
    'pdflatex',
  );
});

test('commented engine-only packages do not change the default', () => {
  assert.equal(detectEngine('% \\usepackage{fontspec}\n\\documentclass{article}'), 'pdflatex');
});
