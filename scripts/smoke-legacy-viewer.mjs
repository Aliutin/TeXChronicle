// The legacy /viewer must also know when its server has stopped.
//
// `render_preview` opens /viewer instead of /app whenever `ui/dist/index.html`
// is missing — a fresh clone before `npm run build:ui`, or a publish where the
// built workspace did not make the tarball. That page had no idea about the
// shutdown goodbye: it dropped the message silently and reconnected every second
// forever, keeping the last render and the last compile error on screen with
// nothing to distinguish it from a live window.
//
// That is the original bug, unfixed, on the path the README documents for a
// from-source install — and no other smoke touches it, because they all use /app.
//
// So this one hides ui/dist to force the fallback, which is also the only way to
// find out whether that fallback still works at all.
import { mkdtempSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO, 'ui', 'dist');
const HIDDEN = join(REPO, 'ui', 'dist.smoke-hidden');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

const proj = mkdtempSync(join(tmpdir(), 'texchronicle-legacy-'));
writeFileSync(join(proj, 'main.tex'), [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  'A page, so the legacy viewer has something to keep showing.',
  String.raw`\end{document}`,
  '',
].join('\n'));

// Force the fallback by moving the built workspace aside. Restored in `finally`,
// including on a crash — leaving a developer without their ui/dist would be a
// worse bug than the one under test.
let hid = false;
if (existsSync(DIST)) { renameSync(DIST, HIDDEN); hid = true; }

let client, browser;
try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
    cwd: proj,
    stderr: 'ignore',
  });
  client = new Client({ name: 'legacy-viewer-smoke', version: '0' }, { capabilities: {} });
  await client.connect(transport);

  const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
  const out = r.content.map((c) => c.text ?? '').join('\n');
  const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\S*/)?.[0] ?? '';

  check('with ui/dist absent, render_preview points at /viewer, not /app',
    url.endsWith('/viewer'), `it offered ${JSON.stringify(url)}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url || `${out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]}/viewer`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('#viewer canvas, #pages canvas, canvas', { timeout: 90_000 }).catch(() => {});

  const deadBefore = await page.isVisible('#dead').catch(() => false);
  check('the legacy viewer is live before the shutdown', !deadBefore);

  // Force the race rather than hoping for it.
  //
  // macOS CI failed "the status line agrees" and "Download PDF is disabled" while
  // Windows passed, because whether they held depended on a render() finishing
  // before or after the shutdown — render() ends by setting '✓ up to date' and
  // re-enabling the button, and its catch sets 'render failed'. Either overwrites
  // the dead state. A settle delay alone did NOT reproduce it here: nothing
  // happened to be in flight. So put something in flight on purpose.
  await page.route('**/latest.pdf*', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.reload({ waitUntil: 'commit' });
  await page.waitForTimeout(1000); // the render is now stuck inside that delay

  await client.close();
  client = null;

  await page.waitForSelector('#dead', { state: 'visible', timeout: 30_000 }).catch(() => {});

  // Let anything already in flight finish before reading the state.
  //
  // Without this the checks below raced a render() that was still running, and
  // whether they passed depended on which finished first — it passed on Windows
  // and failed on macOS CI with "the status line agrees" and "Download PDF is
  // disabled", because render() ends by setting '✓ up to date' and re-enabling
  // the button. That is the real bug (a late async run overwriting current
  // state), and a test that only catches it on one platform is barely a test.
  await page.waitForTimeout(5000); // past the 4s delay above, so the late render has landed

  const banner = await page.textContent('#dead').catch(() => null);
  const visible = await page.isVisible('#dead').catch(() => false);

  check('it says it is no longer live', visible && !!banner, 'the #dead banner never appeared');
  check('it says why the contents cannot be trusted',
    /snapshot|no longer live/i.test(banner ?? ''), JSON.stringify(banner?.slice(0, 120)));
  check('the status line agrees',
    /no longer live/i.test(await page.textContent('#status').catch(() => '') ?? ''));
  check('Download PDF is disabled — it would fail silently',
    await page.isDisabled('#download').catch(() => false));
} finally {
  await browser?.close();
  await client?.close().catch(() => {});
  if (hid && existsSync(HIDDEN)) renameSync(HIDDEN, DIST);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
