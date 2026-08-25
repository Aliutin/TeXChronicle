// The editor must not lose what the user typed.
//
// Three ways it did, all reachable from ordinary use and all silent:
//
//   1. Switching files threw the unsaved buffer away. The cache only ever held
//      the last text fetched or saved, never the dirty buffer, so paragraphs
//      typed into main.tex and then a click on another file existed nowhere.
//   2. The reload refetch applied its result to whichever file was open when it
//      landed, not the one it fetched — so file A's body appeared in file B's
//      editor, and the next save wrote it over B.
//   3. save() cleared the dirty flag after its await, so keystrokes typed during
//      the PUT were marked saved while disk held the older text; the flag never
//      came back, and the next reload replaced the editor with the older version.
//
// Driven through the real workspace in a real browser, because all three are
// timing bugs that only exist between a click and a response.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// The smoke drives ui/dist, which is gitignored and built separately — so a dist
// left over from another branch makes every result below meaningless. That cost
// a confusing red here: a build from `main` was still on disk, and the parked-
// buffer check failed against code that did not contain the fix.
//
// CI always builds fresh, so this only bites locally, which is exactly where a
// misleading result does the most damage.
{
  const newest = (dir) => {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!e.isFile()) continue;
      t = Math.max(t, statSync(join(e.parentPath ?? e.path, e.name)).mtimeMs);
    }
    return t;
  };
  const src = newest(join(REPO, 'ui', 'src'));
  let dist = 0;
  try { dist = newest(join(REPO, 'ui', 'dist')); } catch { /* not built */ }
  if (dist < src) {
    console.error('ui/dist is older than ui/src — run `npm run build:ui` first, or this tests the wrong code.');
    process.exit(1);
  }
}

const checks = [];
let failedOnce = false;
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  if (!ok) failedOnce = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
};

const proj = mkdtempSync(join(tmpdir(), 'texchronicle-editor-'));
mkdirSync(join(proj, 'sections'));
writeFileSync(join(proj, 'main.tex'), [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  String.raw`\input{sections/intro}`,
  String.raw`\end{document}`,
  '',
].join('\n'));
writeFileSync(join(proj, 'sections', 'intro.tex'), 'INTRO ORIGINAL\n');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
  cwd: proj, stderr: 'ignore',
});
const client = new Client({ name: 'editor-smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);

const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
const base = r.content.map((c) => c.text ?? '').join('\n').match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
if (!base) { console.error('no workspace URL'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const editorText = () => page.textContent('.cm-content');

/** What the tree actually shows — printed on any failure, so a wrong selector
 *  reads as a wrong selector rather than as a product bug. */
const dumpTree = async () => {
  const rows = await page.$$eval('.tree-row', (els) =>
    els.map((e) => `${e.className} :: ${JSON.stringify(e.textContent)}`));
  console.log('      tree rows:');
  rows.forEach((r) => console.log('        ' + r));
};

const openInTree = async (name, expect) => {
  // Exact match on the row's own name span. `:has-text("intro.tex")` also
  // matches an enclosing folder row whose subtree contains it, which is how a
  // first version of this clicked the wrong thing and read the failure as the
  // editor swapping files.
  const row = page.locator('.tree-row.file', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) });
  if (await row.count() === 0) {
    // The file may be inside a collapsed folder; open every folder and retry.
    const dirs = page.locator('.tree-row.dir');
    for (let i = 0; i < await dirs.count(); i++) await dirs.nth(i).click().catch(() => {});
    await page.waitForTimeout(200);
  }
  // Click the NAME, not the row. A row is `📄intro.tex ✎ 🗑`, and clicking its
  // centre lands on the rename/delete icons — the click appeared to do nothing
  // and the resulting "wrong file's text" read exactly like the bug under test.
  await row.first().locator('.tree-name').click();

  // Then wait for the switch to have happened, rather than sleeping and hoping.
  // A fixed 400ms read the PREVIOUS file's text every time: a consistent
  // one-behind that also looked like the bug under test.
  try {
    await page.waitForFunction(
      (p) => document.querySelector('.tree-row.on .tree-name')?.textContent === p.split('/').pop(),
      name, { timeout: 10_000 },
    );
  } catch {
    // Never silent. A test that quietly proceeds on the wrong file reports the
    // product as broken when the fault is here.
    throw new Error(`the tree never made ${name} active — the click did not land`);
  }
  // And, when the caller says what the file should contain, wait for the EDITOR
  // to hold it. The tree marking a file active is not the same as the buffer
  // having been replaced, and conflating the two is how this test spent three
  // rounds reporting a product bug that was its own impatience.
  if (expect) {
    try {
      await page.waitForFunction(
        (t) => (document.querySelector('.cm-content')?.textContent ?? '').includes(t),
        expect, { timeout: 10_000 },
      );
    } catch {
      const got = (await editorText()) ?? '';
      throw new Error(`opened ${name} but the editor never showed ${JSON.stringify(expect)} — it holds ${JSON.stringify(got.slice(0, 120))}`);
    }
  }
  await page.waitForTimeout(150);
};
const type = async (text) => {
  await page.click('.cm-content');
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await page.waitForTimeout(200);
};

try {
  await page.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
  await page.click('.tabs button:has-text("Source")').catch(() => {});
  await page.waitForSelector('.cm-content', { timeout: 30_000 });

  // ── 1. Switching files must not discard unsaved text ────────────────────
  await openInTree('main.tex');
  await type(' UNSAVED-IN-MAIN');
  await openInTree('intro.tex', 'INTRO ORIGINAL');
  const introShown = (await editorText()) ?? '';
  check('switching files does not show the other file\'s text',
    introShown.includes('INTRO ORIGINAL') && !introShown.includes('UNSAVED-IN-MAIN'),
    `intro editor read: ${JSON.stringify(introShown.slice(0, 80))}`);

  await openInTree('main.tex', 'UNSAVED-IN-MAIN');
  const back = (await editorText()) ?? '';
  check('coming back, the unsaved text is still there',
    back.includes('UNSAVED-IN-MAIN'),
    `main editor read: ${JSON.stringify(back.slice(0, 120))}`);

  if (failedOnce) await dumpTree();

  // ── 2. A parked buffer is visible, not just retained ────────────────────
  await openInTree('intro.tex');
  const marked = await page.locator('.tree-row:has-text("main.tex") .tree-dirty').count();
  check('the file tree marks the file holding unsaved text', marked > 0,
    'no dirty marker on main.tex while it holds a parked buffer');

  // ── 3. A reload landing after a file switch must not cross the wires ────
  // Claude edits intro.tex on disk and the watcher pushes a reload while the
  // user is moving between files. The refetch is for whichever file was open
  // when it started.
  await openInTree('main.tex');
  writeFileSync(join(proj, 'sections', 'intro.tex'), 'INTRO EDITED BY CLAUDE\n');
  await page.route('**/api/file?path=*main.tex*', async (route) => {
    await new Promise((r) => setTimeout(r, 2500)); // still in flight across the click
    await route.continue().catch(() => {});
  });
  await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 5 * 60 * 1000 });
  await page.waitForTimeout(300);
  await openInTree('intro.tex');
  await page.waitForTimeout(3500); // the delayed main.tex fetch resolves in here
  const introAfter = (await editorText()) ?? '';
  check('a late refetch does not write one file\'s text into another',
    !introAfter.includes('documentclass') && !introAfter.includes('UNSAVED-IN-MAIN'),
    `intro editor read: ${JSON.stringify(introAfter.slice(0, 120))}`);
  await page.unroute('**/api/file?path=*main.tex*');

  // ── 4. Typing during an in-flight save must stay dirty ──────────────────
  await page.route('**/api/file?path=*&compile=*', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue().catch(() => {});
  });
  // Count the writes that actually leave the browser.
  //
  // On macOS this whole section silently tested nothing: CodeMirror binds
  // `Mod-s`, which is Cmd on macOS, so `Control+s` saved nothing — and "the text
  // is still marked unsaved" passes trivially when no save was ever attempted.
  // Two checks were green for the wrong reason until CI caught the third.
  let puts = 0;
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().includes('/api/file')) puts++;
  });
  // The button, not the shortcut: the same save(true), with no platform modifier.
  const clickSave = () => page.click('.editor-bar button:has-text("Save")');

  await openInTree('intro.tex');
  await type(' FIRST');
  await clickSave();
  await page.waitForTimeout(300);
  await type(' DURING-SAVE');        // lands while the PUT is still open
  await page.waitForTimeout(2600);   // the PUT completes

  check('the first save actually left the browser', puts >= 1,
    'no PUT was issued — the save never fired, so the two checks below prove nothing');

  const stillDirty = await page.locator('.tree-row:has-text("intro.tex") .tree-dirty').count();
  check('text typed during a save is still marked unsaved', stillDirty > 0,
    'the editor reported the in-flight keystrokes as saved');

  const shown = (await editorText()) ?? '';
  check('and it is still on screen', shown.includes('DURING-SAVE'),
    `editor read: ${JSON.stringify(shown.slice(-80))}`);
  await page.unroute('**/api/file?path=*&compile=*');

  // Saving again must actually land it — the point of keeping the buffer dirty.
  await clickSave();
  // Poll rather than sleep: the write is a round trip, and a fixed wait is how
  // the earlier checks in this file went wrong three times.
  const deadline = Date.now() + 10_000;
  let onDisk = '';
  while (Date.now() < deadline) {
    onDisk = readFileSync(join(proj, 'sections', 'intro.tex'), 'utf8');
    if (onDisk.includes('DURING-SAVE')) break;
    await page.waitForTimeout(200);
  }
  check('a second save writes the complete text to disk', onDisk.includes('DURING-SAVE'),
    `disk holds: ${JSON.stringify(onDisk.slice(0, 120))} after ${puts} PUT(s)`);
} finally {
  await browser.close();
  await client.close().catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
