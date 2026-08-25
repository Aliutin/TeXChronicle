import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bibPasses, biblatexWasmNote, flattenedClassAliases, truncationNote } from '../src/project/compileProject.js';

// Every one of these decisions used to be made from the main file alone, which
// is only correct for a one-file paper. A thesis whose \cite and \bibliography
// live in an \input-ed chapter got no bibliography pass at all: `[?]` for every
// citation, and success=true with zero errors reported over it.

test('a bibliography spread across chapters still gets its bibtex pass', () => {
  const project = '\\documentclass{article}\n\\begin{document}\n\\input{chapters/ch1}\n\\end{document}\n'
    + '\nLiterate programming matters~\\cite{knuth1984}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n';
  const { bibtex, rerun } = bibPasses(project, ['main.tex', 'chapters/ch1.tex', 'refs.bib']);
  assert.equal(bibtex, true);
  assert.equal(rerun, true);
});

test('the citation commands real papers use are all recognised', () => {
  const paths = ['main.tex', 'refs.bib'];
  const doc = (cite: string) => `\\documentclass{article}\\begin{document}${cite}\\bibliography{refs}\\end{document}`;
  for (const cite of ['\\citep{a}', '\\citet{a}', '\\parencite{a}', '\\textcite{a}', '\\autocite{a}', '\\nocite{*}', '\\cite[p.~3]{a}']) {
    assert.equal(bibPasses(doc(cite), paths).bibtex, true, cite);
  }
});

test('a shipped .bbl with no .bib never triggers bibtex', () => {
  // arXiv sources ship a finished bibliography and no database. Running bibtex8
  // on them finds nothing, writes an *empty* .bbl over the shipped one, and the
  // paper renders with an empty References section and `[?]` throughout —
  // strictly worse than not running it.
  const src = '\\documentclass{article}\\begin{document}~\\cite{knuth1984}\\bibliography{refs}\\end{document}';
  const { bibtex, rerun } = bibPasses(src, ['main.tex', 'main.bbl']);
  assert.equal(bibtex, false, 'bibtex8 would have clobbered the only bibliography this project has');
  assert.equal(rerun, true, 'a .bbl is only read on the second pass, so it needs one');
});

test('cross-references and contents lists in a chapter still force a rerun', () => {
  const chapters = '\\section{One}\\label{s1}\nSee~\\cref{s2}.\n\\tableofcontents\n';
  assert.equal(bibPasses(chapters, ['main.tex', 'ch1.tex']).rerun, true);
  for (const trigger of ['\\eqref{e}', '\\pageref{p}', '\\nameref{n}', '\\listoffigures', '\\printindex', '\\glsadd{g}', '\\printglossaries']) {
    assert.equal(bibPasses(trigger, ['main.tex']).rerun, true, trigger);
  }
});

test('a plain one-page document pays for no extra passes', () => {
  const { bibtex, rerun } = bibPasses('\\documentclass{article}\\begin{document}Hello.\\end{document}', ['main.tex']);
  assert.equal(bibtex, false);
  assert.equal(rerun, false);
});

// ── a venue class shipped in a subdirectory ─────────────────────────────────

test('a .cls below the root is offered again at the root, where TeX looks', () => {
  // kpathsea searches its own trees and the current directory, not the
  // project's subdirectories — so `styles/myvenue.cls` was collected, handed to
  // the engine, and still failed with "class not found".
  const aliases = flattenedClassAliases([
    { path: 'main.tex', content: '\\documentclass{myvenue}', encoding: 'utf8' },
    { path: 'styles/myvenue.cls', content: '\\ProvidesClass{myvenue}', encoding: 'utf8' },
    { path: 'styles/extra.sty', content: 'x', encoding: 'utf8' },
    { path: 'bst/venue.bst', content: 'x', encoding: 'utf8' },
    { path: 'figures/plot.png', content: 'AAAA', encoding: 'base64' },
  ]);
  assert.deepEqual(aliases.map((f) => f.path).sort(), ['extra.sty', 'myvenue.cls', 'venue.bst']);
  assert.equal(aliases.find((f) => f.path === 'myvenue.cls')?.content, '\\ProvidesClass{myvenue}');
  assert.ok(!aliases.some((f) => f.path === 'plot.png'), 'a figure is referenced by its path and must not be moved');
});

test("a root-level file of the same name always wins", () => {
  const aliases = flattenedClassAliases([
    { path: 'myvenue.cls', content: 'the real one', encoding: 'utf8' },
    { path: 'old/myvenue.cls', content: 'a stale copy', encoding: 'utf8' },
  ]);
  assert.deepEqual(aliases, []);
});

// ── notes ───────────────────────────────────────────────────────────────────

test('biblatex on the bundled engine is disclosed before the reader hunts for it', () => {
  // The compile succeeds, the log carries no error, and the PDF has raw keys
  // where the citations should be. It looks exactly like a success.
  const note = biblatexWasmNote('\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n');
  assert.match(note ?? '', /needs biber/);
  assert.match(note ?? '', /bibtex8/);
  assert.match(note ?? '', /local TeX/, 'the way out has to be in the sentence');
  assert.equal(biblatexWasmNote('\\usepackage{natbib}\n'), undefined, 'a natbib paper has nothing to explain');
});

test('a truncated project says how much was left out, and what survived', () => {
  const note = truncationNote(37, 41 * 1024 * 1024);
  assert.match(note, /37 files/);
  assert.match(note, /41\.0 MB/);
  assert.match(note, /Text sources were kept/, 'otherwise the reader cannot tell whether the paper itself was dropped');
  assert.match(note, /figure is missing/, 'name the symptom they will actually see');
  // Hitting the *file* cap with small files would otherwise read "0.0 MB", which
  // looks like a bug rather than an explanation.
  assert.match(truncationNote(101, 202 * 1024), /101 files \/ 202 KB/);
});
