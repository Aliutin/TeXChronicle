// When rendering fails, the pane must say WHERE it failed.
//
// This exists because of what a bare failure cost. A real report read only
//
//   render failed: TypeError: undefined is not a function (near '...e of t...')
//
// with no step, no page, no stack, no browser. Three separate root causes were
// proposed from that one line and all three were wrong, because there was
// nothing in it to be right about. The message a user can screenshot is the
// whole evidence base for a bug nobody can reproduce, so it has to carry its own
// context.
//
// A corrupt PDF is served to the real workspace in a real browser, and the note
// it produces is checked for the things that were missing.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const proj = mkdtempSync(join(tmpdir(), 'texchronicle-err-'));
writeFileSync(join(proj, 'main.tex'), [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  'A page, so there is a real preview to break.',
  String.raw`\end{document}`,
  '',
].join('\n'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
  cwd: proj,
  stderr: 'ignore',
});
const client = new Client({ name: 'render-error-smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);

const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
const out = r.content.map((c) => c.text ?? '').join('\n');
const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
if (!base) { console.error('no workspace URL:\n' + out.slice(0, 400)); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  if (!ok && detail) console.log(`      ${detail}`);
};

try {
  // Hand the viewer bytes that are not a PDF. getDocument rejects, which is a
  // genuine failure through the real code path rather than a stubbed throw.
  await page.route('**/latest.pdf*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: 'not a pdf at all' }));

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
  // Wait on the note itself, not on the report variant. A build without this
  // change still shows a note, so waiting for the variant fails as a 60-second
  // timeout with no output — which is the same "unactionable message" problem
  // this whole script exists to fix, reintroduced in the test for it.
  // ...and wait for the note to actually become the failure. `.pdf-note` is on
  // screen from the first paint holding "waiting for first compile…", so waiting
  // for the element alone matches before anything has gone wrong — which is how
  // a first version of this reported nine failures against a build that was fine.
  await page.waitForFunction(
    () => !/waiting for first compile/.test(document.querySelector('.pdf-note')?.textContent ?? 'waiting for first compile'),
    null, { timeout: 60_000 });
  const note = await page.textContent('.pdf-note');
  check('the failure is presented as a report',
    await page.evaluate(() => document.querySelector('.pdf-note')?.classList.contains('pdf-note-report')),
    'note rendered as prose: ' + JSON.stringify(note?.slice(0, 100)));

  console.log('\n  the pane now says:\n');
  console.log(note.split('\n').map((l) => '    │ ' + l).join('\n'));
  console.log('');

  check('names the step it failed at', /failed while parsing PDF/.test(note), note.slice(0, 120));
  check('names the error type', /Error|Exception/i.test(note));
  // A stack is the thing worth having, but pdf.js rebuilds worker exceptions on
  // this side of a postMessage and a stack does not survive that trip. Silence
  // there reads as "the report forgot"; the absence has to be stated, because
  // the absence is itself evidence that the failure was inside the worker.
  check('accounts for the stack — frames, or why there are none',
    /\n\s*(at |\w+@)/.test(note) || /no stack — the error crossed the pdf\.js worker boundary/.test(note),
    'neither stack frames nor an explanation of their absence');
  check('this pdf.js worker error is reported as having no stack',
    /no stack — the error crossed the pdf\.js worker boundary/.test(note));
  check('names the pdf.js version', /pdf\.js \d+\.\d+/.test(note));
  check('names the browser', /Mozilla\/|Chrome\/|Safari\//.test(note));
  // The old message was one line. Anything that fits on one line is back to
  // being unactionable, whatever it says.
  check('is more than a single line', note.trim().split('\n').length >= 3);
  check('the console got the error object too',
    consoleErrors.some((t) => t.includes('[TeXChronicle] PDF render failed during')),
    'console errors: ' + JSON.stringify(consoleErrors.slice(0, 3)));

  // A worker that cannot start must not hang the pane forever.
  //
  // Swapping pdf.js's `workerSrc` for a `workerPort` quietly gave up pdf.js's own
  // safety net: the workerSrc path wraps construction in try/catch, listens for
  // 'error' and falls back to a main-thread fake worker; the workerPort path
  // attaches a handler and resolves. So a worker chunk that failed to load left
  // getDocument().promise never settling — no pages, no error, the pane stuck on
  // "waiting for first compile…". Worse than the bare message this file exists to
  // improve, and invisible to every other check here.
  await page.unroute('**/latest.pdf*');
  await page.route('**/assets/pdfWorker-*.js', (route) => route.abort());
  await page.reload({ waitUntil: 'load' });

  const settled = await Promise.race([
    page.waitForSelector('.page canvas', { timeout: 45_000 }).then(() => 'rendered'),
    page.waitForFunction(
      () => /render failed/i.test(document.querySelector('.pdf-note')?.textContent ?? ''),
      null, { timeout: 45_000 },
    ).then(() => 'reported'),
  ]).catch(() => 'hung');

  check('a broken worker still resolves — rendered or reported, never hung',
    settled !== 'hung',
    'the pane never settled: getDocument() neither resolved nor rejected');
  console.log(`      (with the worker blocked, the pane ${settled})`);
  await page.unroute('**/assets/pdfWorker-*.js');

  // Prose notes are for reading, not copying, and must not turn monospace.
  await page.unroute('**/latest.pdf*');
  await page.route('**/latest.pdf*', (route) => route.fulfill({ status: 404, body: '' }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.pdf-note', { timeout: 30_000 });
  const proseIsReport = await page.evaluate(() =>
    document.querySelector('.pdf-note')?.classList.contains('pdf-note-report'));
  check('an ordinary note is not styled as a report', proseIsReport === false);
} finally {
  await browser.close();
  await client.close();
}

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
