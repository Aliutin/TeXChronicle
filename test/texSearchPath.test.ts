import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPathDirs } from '../src/project/collectProjectFiles.js';
import { texSearchPathEnv } from '../src/engine/systemTex.js';

// Measured before this existed, on the system backend with MiKTeX:
//
//   styles/myvenue.cls + \documentclass{myvenue}  ->  "File `myvenue.cls' not found"
//   sty/mypkg.sty      + \usepackage{mypkg}       ->  "File `mypkg.sty' not found"
//   bib/refs.bib       + \bibliography{refs}      ->  compiled fine, and rendered
//                                                     `Cite [?]` with an empty
//                                                     References section
//
// The third is the one that matters most: it is not an error anywhere. kpathsea
// does not search a project's subdirectories, and the bundled WASM engine hides
// the whole problem by aliasing those files to the root — so the two backends
// disagreed about the same project, and only the "full fidelity" one was wrong.

test('the main file directory leads, and the root is always searched', () => {
  const dirs = searchPathDirs(['paper/main.tex', 'paper/sections/body.tex', 'styles/venue.cls'], 'paper/main.tex');
  assert.equal(dirs[0], 'paper', 'the compile runs here under -cd; it has to be first');
  assert.ok(dirs.includes('.'), 'a project root that is not the main file directory still holds inputs');
  assert.deepEqual(dirs, ['paper', '.', 'styles', 'paper/sections'], 'then shallowest first');
});

test('a root-level main file does not put the root on twice', () => {
  const dirs = searchPathDirs(['main.tex', 'bib/refs.bib'], 'main.tex');
  assert.deepEqual(dirs, ['.', 'bib']);
});

test('the order is stable, because latexmk records the environment it ran under', () => {
  const files = ['main.tex', 'z/late.sty', 'a/early.cls', 'deep/nested/inner/x.tex'];
  const once = searchPathDirs(files, 'main.tex');
  const again = searchPathDirs([...files].reverse(), 'main.tex');
  assert.deepEqual(once, again, 'the same project must produce the same search path every compile');
  assert.deepEqual(once, ['.', 'a', 'z', 'deep/nested/inner'], 'shallowest first, then alphabetical');
});

test('only directories TeX resolves by name get on the path', () => {
  // A directory of figures or plot data is reached through a path the author
  // wrote out, so it never needs a lookup — and every extra entry is a directory
  // kpathsea stats on every single \usepackage.
  const dirs = searchPathDirs(['main.tex', 'figures/plot.pdf', 'data/points.csv', 'chapters/one.tex'], 'main.tex');
  assert.deepEqual(dirs, ['.', 'chapters']);
});

test('an entry list is capped, so one generated project cannot blow the environment', () => {
  const many = Array.from({ length: 400 }, (_, i) => `gen${i}/frag.tex`);
  const dirs = searchPathDirs(['main.tex', ...many], 'main.tex');
  assert.ok(dirs.length <= 128, `search path grew to ${dirs.length} entries`);
  assert.equal(dirs[0], '.', 'the cap must never cost us the document root');
});

// ── The environment itself ────────────────────────────────────────────────────

test('the trailing empty entry is what keeps the distribution searchable', () => {
  // kpathsea expands an empty element to the configured default. Without it this
  // list REPLACES TeX's own tree and nothing compiles — not even article.cls.
  const env = texSearchPathEnv(['/p', '/p/bib'], {}, ':');
  assert.equal(env.TEXINPUTS, '/p:/p/bib:');
  assert.equal(env.BIBINPUTS, '/p:/p/bib:');
  assert.equal(env.BSTINPUTS, '/p:/p/bib:');
});

test('and the Windows form uses semicolons', () => {
  const env = texSearchPathEnv(['C:\\p', 'C:\\p\\styles'], {}, ';');
  assert.equal(env.TEXINPUTS, 'C:\\p;C:\\p\\styles;');
});

test('a TEXINPUTS the user already set is kept, not overwritten', () => {
  // Someone with a personal macro tree still has it, and still gets the project.
  const env = texSearchPathEnv(['/p'], { TEXINPUTS: '/home/me/tex:', BIBINPUTS: '/home/me/bib:' }, ':');
  assert.equal(env.TEXINPUTS, '/p:/home/me/tex:');
  assert.equal(env.BIBINPUTS, '/p:/home/me/bib:');
  assert.equal(env.BSTINPUTS, '/p:', 'the one they did not set still gets the default entry');
});

test('never the recursive form', () => {
  const env = texSearchPathEnv(['/p', '/p/styles'], {}, ':');
  assert.doesNotMatch(env.TEXINPUTS, /\/\//,
    'kpathsea `//` makes every lookup walk the whole project — one .venv and each \\usepackage costs thousands of stats');
});

test('a directory whose name contains the separator is dropped, not split', () => {
  // Legal on POSIX, and including it would produce two entries that are both
  // wrong — silently, since kpathsea just fails to find things.
  const env = texSearchPathEnv(['/p', '/p/od:ds'], {}, ':');
  assert.equal(env.TEXINPUTS, '/p:');
});

test('no directories means no variables at all', () => {
  // The child then inherits the environment untouched, which is exactly the
  // behaviour every compile had before this existed.
  assert.deepEqual(texSearchPathEnv([], {}, ':'), {});
});
