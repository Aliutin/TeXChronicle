// Stopping the server must actually stop it, and any window still open must say
// so.
//
// Neither happened. `shutdownEngine()` and `stopWatching()` were both written and
// neither was ever called; there were no exit handlers at all. So Chromium, the
// preview server, its sockets and the file watcher were left to whatever the OS
// did — and when the process was not reaped, to nothing. A leaked server keeps
// watching the project and recompiling on every save.
//
// The visible half cost a round of debugging: a real "render failed" was reported
// from a window whose server had already died, while a healthy instance compiled
// the same paper fine on another port. Nothing on screen distinguished the two.
//
// This drives a real server, a real browser tab, then kills the server and checks
// both halves: the port is gone, and the tab knows.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

const proj = mkdtempSync(join(tmpdir(), 'texchronicle-shutdown-'));
writeFileSync(join(proj, 'main.tex'), [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  'A page to render, so the window has something to go stale.',
  String.raw`\end{document}`,
  '',
].join('\n'));

const portOpen = (port) => new Promise((resolve) => {
  const s = createConnection({ host: '127.0.0.1', port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
  setTimeout(() => done(false), 2000);
});

// Spawned directly rather than through npx: killing npx does not reliably kill
// the node grandchild, which is the very leak under test — routing through it
// would measure npx, not this code.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
  cwd: proj,
  stderr: 'ignore',
});
const client = new Client({ name: 'shutdown-smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);
const serverPid = transport.pid;

const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
const out = r.content.map((c) => c.text ?? '').join('\n');
const base = out.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];
const port = Number(base?.match(/:(\d+)$/)?.[1]);
if (!base) { console.error('no workspace URL:\n' + out.slice(0, 400)); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

try {
  await page.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('.page canvas', { timeout: 60_000 });
  check('the workspace is live before the shutdown',
    await portOpen(port) && !(await page.$('.banner-dead')));

  // Open the editor on a real file BEFORE the shutdown. Afterwards the file list
  // cannot be fetched at all, so a tab opened later has nothing to type into —
  // which is not the case under test. The case under test is the one that loses
  // work: an editor already open, with the user still typing into it.
  await page.click('.tabs button:has-text("Source")').catch(() => {});
  const editor = await page.waitForSelector('.cm-content', { timeout: 20_000 }).catch(() => null);
  check('the editor is open before the shutdown', !!editor, 'no CodeMirror editor appeared');

  // SIGTERM is what a supervisor sends; on Windows there are no POSIX signals, so
  // the stdio-close path is what actually fires. Both routes land in the same
  // shutdown, and this exercises whichever one the platform provides.
  if (process.platform === 'win32') await client.close();
  else process.kill(serverPid, 'SIGTERM');

  await page.waitForSelector('.banner-dead', { timeout: 30_000 }).catch(() => {});
  const banner = await page.textContent('.banner-dead').catch(() => null);

  check('the window says it is no longer live', !!banner, 'no .banner-dead appeared');
  check('it says why the contents cannot be trusted',
    /snapshot|no longer live/i.test(banner ?? ''), JSON.stringify(banner?.slice(0, 120)));
  check('the banner cannot be dismissed',
    !(await page.$('.banner-dead .ghost')), 'a dismiss control is present');
  check('the toolbar agrees', /no longer live/i.test(await page.textContent('.status') ?? ''));
  check('Recompile is disabled — it would fail silently',
    await page.isDisabled('.recompile'));

  // The one that costs more than a click. The editor was never told the server
  // had stopped, so it stayed fully editable and its 30-second autosave kept
  // PUTting into a closed port, failing into a bare `catch` that showed a small
  // "save failed" chip. The user keeps typing into a buffer that will never
  // reach disk. Losing someone's text quietly is the worst thing in this file.
  if (editor) {
    await editor.click();
    await page.keyboard.type(' edited after the server stopped');
    await page.click('.editor-bar button:has-text("Save")').catch(() => {});
    await page.waitForTimeout(800);
    const chip = await page.textContent('.save-state').catch(() => '');
    const why = await page.getAttribute('.save-state', 'title').catch(() => null);
    check('the editor says the text is NOT saved', /not saved/i.test(chip ?? ''),
      `save chip read ${JSON.stringify(chip)}`);
    check('and says why, so the user knows the text is only in this window',
      /stopped|render a preview again/i.test(why ?? ''),
      `title was ${JSON.stringify(why)}`);
  }

  // Regression guards, and honest about being only that: both of these pass
  // without the fix too, because a clean transport close tears the process down
  // anyway on this path. They catch a future shutdown that hangs rather than
  // proving anything about today's. The claim they cannot make is made instead by
  // test/previewServerClose.test.ts, which hangs outright without the fix.
  const deadline = Date.now() + 15_000;
  let stillOpen = true;
  while (Date.now() < deadline && stillOpen) {
    stillOpen = await portOpen(port);
    if (stillOpen) await new Promise((r) => setTimeout(r, 500));
  }
  check('the port is released', !stillOpen, `still listening on ${port} after 15s`);

  const alive = await new Promise((resolve) => {
    const p = spawn(process.platform === 'win32' ? 'tasklist' : 'ps',
      process.platform === 'win32' ? ['/FI', `PID eq ${serverPid}`, '/NH'] : ['-p', String(serverPid)]);
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.on('close', () => resolve(new RegExp(String(serverPid)).test(buf)));
    p.on('error', () => resolve(false));
  });
  check('the server process is gone, not orphaned', !alive, `pid ${serverPid} is still running`);
} finally {
  await browser.close();
  await client.close().catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
