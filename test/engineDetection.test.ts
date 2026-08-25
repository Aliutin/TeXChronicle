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

test('magic comments are matched however the editor capitalised them', () => {
  // TeXShop writes `XeLaTeX`, TeXstudio writes `PDFLaTeX`. The capture was
  // compared against lowercase literals, so every one of these fell through to
  // pdflatex — silently compiling a fontspec document on the wrong engine.
  assert.equal(detectEngine('% !TEX program = XeLaTeX\n\\documentclass{article}'), 'xelatex');
  assert.equal(detectEngine('% !TEX program = LuaLaTeX\n\\documentclass{article}'), 'lualatex');
  assert.equal(detectEngine('% !TEX program = PDFLaTeX\n\\usepackage{fontspec}'), 'pdflatex');
});

test("TeX's own %& format specifier is honoured", () => {
  // TeXShop and plain TeX both use this, and it must be the first line — so it
  // is anchored to the start of the source rather than to any line of it.
  assert.equal(detectEngine('%&xelatex\n\\documentclass{article}\n'), 'xelatex');
  assert.equal(detectEngine('%& lualatex\n\\documentclass{article}\n'), 'lualatex');
  assert.equal(detectEngine('%&pdflatex\n\\usepackage{fontspec}\n'), 'pdflatex');
  assert.equal(detectEngine('\\documentclass{article}\n%&xelatex\n'), 'pdflatex',
    'a %& line that is not the first line is not a format specifier');
});

test('the other packages that cannot run on pdfLaTeX select a Unicode engine', () => {
  assert.equal(detectEngine('\\usepackage{polyglossia}\n\\setmainlanguage{english}'), 'xelatex');
  assert.equal(detectEngine('\\usepackage{xeCJK}'), 'xelatex');
  assert.equal(detectEngine('\\usepackage{xecjk}'), 'xelatex');
  assert.equal(detectEngine('\\usepackage{luatexja}'), 'lualatex');
});

test('an engine-only package in an included preamble still selects the engine', () => {
  // What compileProject now passes in: the root plus every other TeX source. A
  // paper whose \usepackage{fontspec} lives in preamble.tex was compiled with
  // pdflatex and failed on a document that is perfectly correct.
  const project = '\\documentclass{article}\n\\input{preamble}\n\\begin{document}\n\\end{document}\n'
    + '\n\\usepackage{fontspec}\n\\setmainfont{Latin Modern Roman}\n';
  assert.equal(detectEngine(project), 'xelatex');
});

test('a byte-order mark does not hide the first line', () => {
  assert.equal(detectEngine('\ufeff%&xelatex\n\\documentclass{article}\n'), 'xelatex');
});
