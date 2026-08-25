// Regression guard for a bug that shipped in v0.1.0.
//
// previewServer.ts used to locate its static assets at
// `<pkg-root>/node_modules/<dep>`. That path only exists in a cloned repo. When
// TeXChronicle is installed from npm, npm hoists dependencies to the CONSUMER's
// top-level node_modules, so the engine, pdf.js and diff2html assets all 404 —
// and because the engine loads lazily on the first render_preview, the server
// still printed "ready on stdio" and looked fine. Nothing in the suite caught it.
//
// These tests encode both halves of the lesson: the dirs must resolve, and the
// resolution must not go back to assuming a hardcoded node_modules layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const depDir = (pkg: string) => dirname(require.resolve(`${pkg}/package.json`));

test('static asset directories resolve to real paths', () => {
  const dirs = {
    ENGINE_DIST: join(depDir('texlyre-busytex'), 'dist'),
    PDFJS_ROOT: depDir('pdfjs-dist'),
    DIFF2HTML_ROOT: join(depDir('diff2html'), 'bundles'),
  };
  for (const [name, dir] of Object.entries(dirs)) {
    assert.ok(existsSync(dir), `${name} does not exist: ${dir}`);
  }
});

test('previewServer locates deps via the resolver, not a hardcoded node_modules path', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/preview/previewServer.ts', import.meta.url)),
    'utf8',
  );

  // Strip comments so the explanation of the bug doesn't trip its own guard.
  // Line comments FIRST: this file's header documents routes like `/busytex/*`,
  // and a naive block-comment pass reads that `/*` as an opening delimiter and
  // swallows the imports below it.
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Building a path out of a literal 'node_modules' segment is the bug.
  // (Bare mentions in a skip-list are fine — those aren't path construction.)
  assert.ok(
    !/join\([^)]*['"]node_modules['"]/.test(code),
    "previewServer.ts builds a path with a literal 'node_modules' segment — that " +
      'breaks when npm hoists deps to the consumer\'s node_modules. Use depDir() instead.',
  );

  assert.match(code, /createRequire/, 'expected previewServer.ts to resolve deps via createRequire');
});
