// Regression guard for the way a broken edit used to cost you your preview.
//
// busytex reports success: true even when LaTeX stopped on an error, so a run
// that only got as far as page 1 was published over a good 13-page render and
// written into the checkpoint history as though it were fine. The author's own
// paper hit this: "renders only the first page, lost all other pages after
// recompiling".
//
// None of this is reachable from the fast test suite, which is deliberately
// browser-free, so it lives here alongside smoke-compile.mjs and runs in the
// same CI job that already pays for the engine assets.
//
//   node scripts/smoke-error-handling.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPILE_TIMEOUT_MS = 15 * 60 * 1000;

const doc = (body) => [
  String.raw`\documentclass{article}`,
  String.raw`\usepackage{amsmath}`,
  String.raw`\begin{document}`,
  String.raw`\section{One}`,
  'First page.',
  String.raw`\newpage`,
  String.raw`\section{Two}`,
  body,
  String.raw`\newpage`,
  String.raw`\section{Three}`,
  'Third page.',
  String.raw`\end{document}`,
  '',
].join('\n');

const proj = mkdtempSync(join(tmpdir(), 'texchronicle-errors-'));
const tex = join(proj, 'main.tex');
writeFileSync(tex, doc('Second page.'));

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', join(REPO, 'src', 'server.ts')], cwd: proj });
const client = new Client({ name: 'smoke-errors', version: '0' }, { capabilities: {} });
await client.connect(transport);

let base = null;
// backend is pinned, never left to the default. Every assertion below is about
// the bundled WASM engine — its stubbing, its missing-package handling, its
// bundled classes. Under the 'auto' default a runner that happens to have
// latexmk installed would quietly exercise system TeX instead and pass without
// testing any of it.
const render = async (label, args = {}) => {
  const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm', ...args } }, undefined, { timeout: COMPILE_TIMEOUT_MS });
  const out = r.content.map((c) => c.text ?? '').join('\n');
  base ??= out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  let pages = 0;
  if (base) {
    const res = await fetch(`${base}/latest.pdf?t=` + Date.now());
    if (res.ok) pages = (await getDocument({ data: new Uint8Array(Buffer.from(await res.arrayBuffer())) }).promise).numPages;
  }
  console.log(`${label.padEnd(34)} ${pages} pages | ${out.split('\n')[0].slice(0, 72)}`);
  return { out, pages };
};

const good = await render('1 good source');

// An undefined control sequence: LaTeX "recovers" and emits a truncated PDF
// rather than stopping outright, which is exactly the case that used to slip
// through as a success.
writeFileSync(tex, doc(String.raw`\notARealCommand` + '\nSecond page.'));
const broken = await render('2 broken source');

writeFileSync(tex, doc('Second page.'));
const restored = await render('3 restored');

// A package the bundled TeX Live doesn't have, that this document never uses:
// a stale \usepackage must not cost the author their compile.
writeFileSync(tex, doc('Second page.').replace(String.raw`\usepackage{amsmath}`, String.raw`\usepackage{amsmath}` + '\n' + String.raw`\usepackage{texchroniclenosuchpkg}`));
const stubbed = await render('4 unused missing package');

// A vendored document class. IEEEtran is in no tier of the bundled TeX Live, so
// without assets/fallback-styles/IEEEtran.cls this is an Emergency stop and no
// PDF at all — deleting the file has to fail here rather than silently ship.
// \IEEEPARstart only exists in the real class, so it also catches a stub or a
// truncated download standing in for it.
writeFileSync(tex, [
  String.raw`\documentclass[conference]{IEEEtran}`,
  String.raw`\begin{document}`,
  String.raw`\title{Bundled Class Check}`,
  String.raw`\author{\IEEEauthorblockN{Smoke Test}}`,
  String.raw`\maketitle`,
  String.raw`\begin{abstract}`,
  'The class must typeset a real two-column IEEE paper, not merely be found.',
  String.raw`\end{abstract}`,
  String.raw`\begin{IEEEkeywords}`,
  'document class, regression test',
  String.raw`\end{IEEEkeywords}`,
  String.raw`\section{Body}`,
  String.raw`\IEEEPARstart{T}{his} macro exists only in IEEEtran.`,
  String.raw`\end{document}`,
  '',
].join('\n'));
const ieee = await render('5 bundled IEEEtran class');

const checks = [
  ['good source renders all 3 pages', good.pages === 3],
  ['a broken recompile keeps the good preview', broken.pages === 3],
  ['a broken recompile is not reported as clean', !/^✓ Compiled/.test(broken.out)],
  ['recovery restores a clean compile', restored.pages === 3 && /^✓ Compiled/.test(restored.out)],
  ['an unused missing package still compiles', stubbed.pages === 3],
  ['the stub is disclosed to the user', /Stubbed out/.test(stubbed.out)],
  ['a bundled IEEEtran paper compiles clean', ieee.pages >= 1 && /^✓ Compiled/.test(ieee.out)],
  ['the run reports which backend produced it', / · wasm /.test(ieee.out)],
];

console.log('');
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length} check(s)` : '\nSMOKE PASS');

await client.close();
process.exit(failed.length ? 1 : 0);
