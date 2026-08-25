// A highlight must sit on its words at every zoom level.
//
// The column boundaries a highlight is grouped by used to be inferred from the
// rendered text layer, which is an approximation that degrades at small font
// sizes — so the same document produced two boundaries at 150%, one at 124% and
// none at 102%, where a highlight then spanned the whole page. They now come
// from the PDF itself, whose coordinates do not move when the reader zooms.
//
// This drives the real workspace in a real browser and compares the drawn
// highlight against the actual glyph rectangles at several zoom levels.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const QUOTE = 'quick brown fox jumps over the lazy dog and keeps running well past the end of this line to force a wrap onto the next and then onto a third line so the middle one is drawn flush';
// A pixel of slack: sub-pixel rounding differs between the Range rect and the
// span rect. Anything larger is a real misplacement, and the bug being guarded
// against moved highlights by tens of pixels.
const TOLERANCE_PX = 2;

const proj = mkdtempSync(join(tmpdir(), 'texchronicle-zoom-'));
writeFileSync(join(proj, 'main.tex'), [
  String.raw`\documentclass[twocolumn]{article}`,
  String.raw`\begin{document}`,
  String.raw`\section{One}`,
  'The quick brown fox jumps over the lazy dog and keeps running well past the end of this line to force a wrap onto the next and then onto a third line so the middle one is drawn flush across its whole width.',
  'Filler follows so both columns carry text and the column detection has something to work with. ' .repeat(40),
  String.raw`\end{document}`,
  '',
].join('\n'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')],
  cwd: proj,
  stderr: 'ignore',
});
const client = new Client({ name: 'zoom-smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);

const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: 15 * 60 * 1000 });
const out = r.content.map((c) => c.text ?? '').join('\n');
const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
if (!base) { console.error('no workspace URL:\n' + out.slice(0, 400)); process.exit(1); }

// Rect-less reviewer comment: the highlight is re-anchored from the quote, which
// is the path whose geometry is under test.
await client.callTool({ name: 'add_comment', arguments: { quote: QUOTE, comment: 'zoom geometry', accepted: true } });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const checks = [];

try {
  await page.goto(`${base}/app`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('.page canvas', { timeout: 60_000 });
  await page.waitForSelector('.hl', { timeout: 60_000 });

  // Ground truth is a DOM Range over the quoted characters, not the spans that
  // contain them. pdf.js emits spans covering many words, so a span's own edges
  // sit before and after the quote — comparing against those reports a constant
  // error at every zoom, which is exactly what a first version of this did.
  const measure = () => page.evaluate((quote) => {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const pg = document.querySelector('.page');
    const hls = [...pg.querySelectorAll('.hl')];
    let concat = ''; const map = [];
    for (const el of pg.querySelectorAll('.textLayer span')) {
      const n = norm(el.textContent);
      if (!n) continue;
      map.push({ start: concat.length, len: n.length, el });
      concat += n + ' ';
    }
    const q = norm(quote);
    const at = concat.indexOf(q);
    if (at < 0 || !hls.length) return null;
    const end = at + q.length;

    // The fixture is plain ASCII with single spaces, so normalized offsets map
    // onto raw offsets one-for-one inside a span.
    const rects = [];
    for (const m of map) {
      if (m.start >= end || m.start + m.len <= at) continue;
      const node = m.el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const raw = node.textContent;
      const from = Math.max(0, at - m.start);
      const to = Math.min(raw.length, end - m.start);
      if (to <= from) continue;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      rects.push(...range.getClientRects());
    }
    if (!rects.length) return null;
    const h = hls.map((el) => el.getBoundingClientRect());
    return {
      scale: getComputedStyle(pg).getPropertyValue('--scale-factor').trim(),
      boxes: hls.length,
      errLeft: Math.min(...h.map((r) => r.left)) - Math.min(...rects.map((r) => r.left)),
      errRight: Math.max(...h.map((r) => r.right)) - Math.max(...rects.map((r) => r.right)),
    };
  }, QUOTE);

  const zoomTo = async (label, clicks, dir) => {
    for (let i = 0; i < clicks; i++) {
      await page.click(`.pdf-toolbar button:has-text("${dir}")`);
      await page.waitForTimeout(400);
    }
    await page.waitForSelector('.hl', { timeout: 30_000 });
    await page.waitForTimeout(300);
    const m = await measure();
    if (!m) { checks.push([`${label}: highlight found`, false]); return; }
    const ok = Math.abs(m.errLeft) <= TOLERANCE_PX && Math.abs(m.errRight) <= TOLERANCE_PX;
    console.log(`  ${label.padEnd(22)} scale ${String(m.scale).padEnd(6)} ${m.boxes} box(es)  left ${m.errLeft.toFixed(1)}px  right ${m.errRight.toFixed(1)}px  ${ok ? '' : '← off'}`);
    checks.push([`${label}: highlight sits on its words`, ok]);
  };

  const first = await measure();
  console.log(`  ${'initial'.padEnd(22)} scale ${String(first?.scale).padEnd(6)} ${first?.boxes} box(es)  left ${first?.errLeft.toFixed(1)}px  right ${first?.errRight.toFixed(1)}px`);
  checks.push(['initial: highlight sits on its words',
    !!first && Math.abs(first.errLeft) <= TOLERANCE_PX && Math.abs(first.errRight) <= TOLERANCE_PX]);

  // Zooming OUT is where this was reported — 150% down to 100% and below.
  await zoomTo('after zooming out', 2, '−');
  await zoomTo('further out', 2, '−');
  await zoomTo('back in', 3, '+');
} finally {
  await browser.close();
  await client.close();
}

console.log('');
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\nSMOKE FAIL: ${failed.length}` : '\nSMOKE PASS');
process.exit(failed.length ? 1 : 0);
