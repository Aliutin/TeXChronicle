import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompile, blockedToolHelp, usesPackage } from '../src/engine/compileLog.js';

// Verbatim from a user's failing paper. Detection written against this rather
// than from memory: a pattern that doesn't match is a feature that silently
// doesn't exist, and the user spent half an hour on this one unaided.
const REAL_SVG_LOG = String.raw`
wasn't possible to launch the Inkscape export
(svg)                for ` + '`' + String.raw`fig/Fed_CMA architecture diagram2.svg' on input line 113.

! Package svg Error: File ` + '`' + String.raw`Fed_CMA architecture diagram2_svg-tex.pdf' is missing.

See the svg package documentation for explanation.
Did you run the export with Inkscape? There's no file
` + '`' + String.raw`./svg-inkscape/Fed_CMA architecture diagram2_svg-tex.pdf'
`;

test('the real svg failure is recognised as a blocked tool', () => {
  const v = classifyCompile(REAL_SVG_LOG, 30416);
  assert.deepEqual(v.blockedTools, ['Inkscape']);
});

test('a clean log reports no blocked tools', () => {
  // Otherwise every successful compile would carry an explanation for a
  // problem it doesn't have.
  const v = classifyCompile('This is XeTeX\nOutput written on main.pdf (7 pages)\n', 30416);
  assert.deepEqual(v.blockedTools, []);
});

test('a refused \\write18 is caught even without a package saying so', () => {
  // gnuplottex and friends produce no branded error — only TeX's own line.
  const v = classifyCompile('runsystem(gnuplot main.gnuplot)...disabled\n', 100);
  assert.deepEqual(v.blockedTools, ['an external program']);
});

test('wasm is told the flag cannot help, because it cannot', () => {
  // The bundled engine has no subprocesses. Telling this reader to enable
  // shell-escape is the same mistake as naming latexmk and stopping.
  const h = blockedToolHelp(['Inkscape'], 'wasm', false);
  assert.match(h, /cannot run external programs at all/);
  assert.match(h, /no flag will enable it/);
  assert.match(h, /\\includegraphics/, 'the route that actually works comes first');
});

test('system without the flag is told how to turn it on, and what it costs', () => {
  const h = blockedToolHelp(['Inkscape'], 'system', false);
  assert.match(h, /shellEscape: true/);
  assert.match(h, /execute shell commands/, 'the risk is stated, not buried');
  assert.match(h, /sources you trust/);
});

test('system WITH the flag is told the tool is probably missing', () => {
  // Repeating "enable shell-escape" to someone who already did is the dead end
  // this whole class of message keeps falling into.
  const h = blockedToolHelp(['Inkscape'], 'system', true);
  assert.match(h, /isn't installed or isn't on PATH/);
  assert.doesNotMatch(h, /shellEscape: true/);
});

test('no blocked tools means no advice at all', () => {
  assert.equal(blockedToolHelp([], 'wasm', false), '');
  assert.equal(blockedToolHelp([], 'system', true), '');
});

// minted rewrote every one of its messages for v3 (MiKTeX 25.x, TeX Live 2024+)
// and stopped naming shell-escape. Verbatim lines, so a change in our patterns
// cannot pass a test that the real log would fail.

test('minted v3 — the version shipping on current distributions — is recognised', () => {
  const v3 = 'Package minted Error: minted v3+ executable is not installed, is not added to PATH, or is not permitted with restricted shell escape';
  assert.deepEqual(classifyCompile(v3, 0).blockedTools, ['Pygments'],
    'the reader got no explanation at all on any up-to-date TeX install');
});

test('and its two quieter phrasings, which carry no "Error" prefix', () => {
  assert.deepEqual(classifyCompile('... (minted executable is unavailable or disabled)', 30416).blockedTools, ['Pygments']);
  assert.deepEqual(classifyCompile('Cannot highlight code (minted executable is unavailable)', 30416).blockedTools, ['Pygments']);
});

// ── which packages may be stubbed ────────────────────────────────────────────
//
// A false "no" here stubs something load-bearing and silently changes the PDF,
// which is worse than the compile failing: nobody goes looking for a problem
// they were told does not exist.

test('a package is "used" through the macros it provides, not only its name', () => {
  assert.ok(usesPackage('graphicx', '\\includegraphics[width=1cm]{fig.png}'), 'stubbing this drops every figure');
  assert.ok(usesPackage('booktabs', 'x \\toprule y \\midrule z'), 'stubbing this drops every rule from every table');
  assert.ok(usesPackage('hyperref', 'see \\url{https://example.com}'));
  assert.ok(usesPackage('cleveref', 'as \\cref{sec:intro} shows'));
  assert.ok(usesPackage('natbib', 'reported by \\citet{knuth1984}'));
  assert.ok(usesPackage('siunitx', 'the speed was \\SI{5}{\\meter\\per\\second}'));
  assert.ok(usesPackage('subcaption', '\\begin{subfigure}{0.5\\textwidth}'));
  assert.ok(usesPackage('amsmath', '\\begin{align}a &= b\\end{align}'));
});

test('option-only packages are never stubbed, because nothing ever "uses" them', () => {
  // They are configured entirely through \usepackage options and their effect is
  // invisible in the body. Stubbing one silently resets the paper to Computer
  // Modern at the default margins and calls it a successful compile.
  for (const pkg of ['geometry', 'setspace', 'parskip', 'newtxtext', 'mathptmx']) {
    assert.ok(usesPackage(pkg, '\\begin{document}nothing mentions it\\end{document}'), pkg);
  }
});

test('a package nothing refers to is still stubbable', () => {
  // The whole point of stubbing: a \usepackage left behind after the code that
  // needed it was deleted must not cost the author their preview.
  assert.equal(usesPackage('tikz', '\\begin{document}plain text\\end{document}'), false);
  assert.equal(usesPackage('graphicx', '\\begin{document}no figures here\\end{document}'), false);
});
