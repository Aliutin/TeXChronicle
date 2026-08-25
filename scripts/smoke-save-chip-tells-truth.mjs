// The save chip must not say a compile finished before it has, or that it
// worked when it did not.
//
// It used to clear on a two-second timer with nothing to do with the compile. On
// a real paper an edit takes ~12.5s, so Ctrl+S showed "recompiling" for two
// seconds and then went quiet with ten seconds still to run — and did the same
// when the compile FAILED. A save that broke the document looked like one that
// worked. That is the worst thing a tool for writing papers can say.
//
// Driven through the real workspace, because the lie only exists between the PUT
// returning and the compile finishing.
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ui/dist is gitignored and built separately; a stale one makes every result
// here meaningless. This cost a confusing red once already.
{
  const newest = (dir) => {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!e.isFile()) continue;
      t = Math.max(t, statSync(join(e.parentPath ?? e.path, e.name)).mtimeMs);
    }
    return t;
  };
  let dist = 0;
  try { dist = newest(join(REPO, 'ui', 'dist')); } catch { /* not built */ }
  if (dist < newest(join(REPO, 'ui', 'src'))) {
    console.error('ui/dist is older than ui/src — run `npm run build:ui` first, or this tests the wrong code.');
    process.exit(1);
  }
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

// Deliberately not a hello-world. Measured: a bare one compiles in ~2.8s, close
// enough to the old two-second timer that the probe below would be racing the
// real compile instead of measuring it — the first version of this test failed
// for exactly that reason. A .bib plus a \cite forces bibtex and a rerun.
const proj = mkdtempSync(join(tmpdir(), 'texchronicle-chip-'));
writeFileSync(join(proj, 'refs.bib'), '@article{k, title={T}, author={A}, journal={J}, year={2020}}\n');
const GOOD = [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  String.raw`Hello \cite{k}.`,
  String.raw`\bibliographystyle{plain}`,
  String.raw`\bibliography{refs}`,
  String.raw`\end{document}`,
  '',
].join('\n');
writeFileSync(join(proj, 'main.tex'), GOOD);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
  cwd: proj, stderr: 'ignore',
});
const client = new Client({ name: 'chip-smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);

const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
const base = r.content.map((c) => c.text ?? '').join('\n').match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
if (!base) { console.error('no workspace URL'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('console', (m) => { if (m.text().startsWith('[chipdbg]')) console.log('      ' + m.text()); });
const chip = async () => (await page.locator('.save-state').innerText().catch(() => '')).trim();

// Every chip change with a timestamp. A one-instant reading cannot tell "cleared
// too early" from "the compile really was that fast", and this test has already
// been wrong about that once.
let timeline = [];
let t0 = Date.now();
const startWatch = () => { timeline = []; t0 = Date.now(); };
const liveClass = () => page.locator('.status').getAttribute('class').catch(() => '');
const watch = setInterval(async () => {
  // The live status too: when the chip is wrong, the question is always whether
  // it disagreed with the socket or faithfully reported something wrong.
  const now = `${await chip()}  [${((await liveClass()) ?? '').replace('status ', '')}]`;
  if (timeline.length === 0 || timeline[timeline.length - 1][1] !== now) timeline.push([Date.now() - t0, now]);
}, 100);
const dump = (label) => {
  console.log(`      ${label} — chip over time (ms from save):`);
  for (const [t, v] of timeline) console.log(`        ${String(t).padStart(6)}  ${JSON.stringify(v)}`);
};
const clickSave = () => page.click('.editor-bar button:has-text("Save")');
/**
 * Put an exact document in the editor.
 *
 * Typing at the cursor was the third layer of this test to be wrong: `click` on
 * the editor followed by `End` lands at the end of whatever *line* was clicked,
 * not of the document, so the broken command went in after `\end{document}`
 * where LaTeX ignores it. The compile was then legitimately clean, the chip
 * correctly said so, and this test called that a false success — two rounds
 * spent hunting a product bug that only ever existed in the edit.
 */
const setBuffer = async (text) => {
  await page.click('.cm-content');
  // ControlOrMeta, not Control: on macOS select-all is Cmd+A, and Control+A is
  // emacs' move-to-line-start. Written as Control it selected nothing, Delete
  // removed one character, and the replacement was inserted INTO the old
  // document — which still compiled, so CI reported the chip as lying. The same
  // trap as `Mod-s` in smoke-editor-keeps-text.mjs, hit a second time.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
  await page.waitForTimeout(150);
  // Never assume the edit landed: a buffer that did not change makes every
  // check below pass or fail for reasons that have nothing to do with the chip.
  const got = await page.locator('.cm-content').textContent();
  const head = text.split('\n')[0];
  if (!got?.includes(head)) throw new Error(`setBuffer did not take — editor starts ${JSON.stringify((got ?? '').slice(0, 60))}`);
};
/**
 * Wait for the chip to ENTER a state, then to leave it.
 *
 * Waiting only for it to leave returns instantly, because at the moment of the
 * click the chip still reads "" or "saving…" — neither of which matches. A first
 * version did exactly that and reported the compile as resolved 31 ms in, which
 * looked like a product bug and was the test measuring nothing.
 */
const enter = (re) => page.waitForFunction(
  (p) => new RegExp(p, 'i').test(document.querySelector('.save-state')?.textContent ?? ''),
  re, { timeout: 60_000 },
);
const leave = (re) => page.waitForFunction(
  (p) => !new RegExp(p, 'i').test(document.querySelector('.save-state')?.textContent ?? ''),
  re, { timeout: 120_000 },
);
const throughCompile = async () => { await enter('recompil'); await leave('recompil'); };

try {
  await page.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
  await page.click('.tabs button:has-text("Source")').catch(() => {});
  await page.waitForSelector('.cm-content', { timeout: 30_000 });

  // ── 1. A good edit resolves only when the compile really ends ─────────────
  await setBuffer(GOOD.replace('Hello', 'Hello EDIT-ONE'));
  startWatch();
  const savedAt = Date.now();
  await clickSave();
  await throughCompile();
  // Timed directly rather than read off the 100ms sampler: the sampler races the
  // last transition and reported -1 ("never cleared") for a chip that had just
  // cleared correctly.
  const clearedAt = Date.now() - savedAt;
  const settled = await chip();

  // The claim is not "it took longer than two seconds" — a fast compile legitimately
  // finishes sooner. It is that the chip changed WHEN THE COMPILE DID. The old
  // timer fired at a fixed 2000ms regardless, so a resolution that lands within a
  // few tens of ms of 2000 every time is the signature of the bug.
  check('the chip resolves when the compile ends, not on a fixed timer',
    clearedAt > 0 && Math.abs(clearedAt - 2000) > 150,
    `chip cleared at ${clearedAt}ms — suspiciously close to the old fixed 2000ms timer`);
  if (!(clearedAt > 0 && Math.abs(clearedAt - 2000) > 150)) dump('good edit');

  check('and it says the save succeeded', /saved/i.test(settled) && !/failed/i.test(settled),
    `chip read ${JSON.stringify(settled)}`);

  // ── 2. A broken edit must say the compile failed ──────────────────────────
  // Inside the document body, where an undefined control sequence is fatal.
  // Verified independently of the browser: compileProject on this exact source
  // returns success=false with one error, both with and without a bibliography
  // pass — so a chip that says "saved" here is the product lying, not the test.
  await setBuffer(GOOD.replace('Hello \\cite{k}.', 'Hello \\cite{k}.\n\\undefinedcommandthatcannotwork'));
  startWatch();
  await clickSave();
  await throughCompile();
  const afterBad = await chip();

  check('a failed compile is never reported as a plain success',
    !/^✓ saved$/.test(afterBad),
    `chip read ${JSON.stringify(afterBad)} — this is the false compile success being fixed`);
  check('and it blames the compile, not the save',
    /compile failed/i.test(afterBad) && /saved/i.test(afterBad),
    `chip read ${JSON.stringify(afterBad)} — the text WAS saved; only the build broke`);
  if (!/compile failed/i.test(afterBad)) dump('broken edit');
} finally {
  clearInterval(watch);
  await browser.close();
  await client.close().catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
