import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkingDiff, createCheckpoint } from '../src/git/checkpoints.js';
import { forgetHistoryRepo } from '../src/git/historyRepo.js';
import { startPreviewServer, type PreviewServerHandle } from '../src/preview/previewServer.js';
import { setProjectRoot } from '../src/session.js';

// "No changes" is a claim about the author's work, and the diff pane made it
// every time git could not be run: a full temp directory, a stale index.lock, a
// figure another application was holding open — each of them became `''`, and
// `''` reaches the reader as a blank pane saying they have not written anything
// since the last checkpoint. An hour of edits was sitting on disk.

function paper(): string {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-workingdiff-'));
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}First\\end{document}\n');
  forgetHistoryRepo();
  return root;
}

const headers = (url: string) => ({ Origin: url, 'Sec-Fetch-Site': 'same-origin' });

async function withServer(root: string, fn: (preview: PreviewServerHandle) => Promise<void>): Promise<void> {
  setProjectRoot(root);
  const preview = await startPreviewServer();
  try { await fn(preview); } finally { await preview.close(); }
}

test('a working diff that cannot be read is an error, not an empty diff', async () => {
  const root = paper();
  try {
    await createCheckpoint(root);
    writeFileSync(join(root, 'main.tex'), 'AN HOUR OF UNSAVED THINKING\n');
    // Break git for this project the way a real failure does — every call it
    // makes now fails, and the working tree is what is at stake.
    rmSync(root, { recursive: true, force: true });
    await assert.rejects(getWorkingDiff(root), /./, 'a failure was still reported as "no changes"');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/git/diff with no sha is the working diff, and says so when it fails', async () => {
  const root = paper();
  try {
    await createCheckpoint(root);
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Second\\end{document}\n');
    await withServer(root, async (preview) => {
      const ok = await fetch(`${preview.url}/git/diff`, { headers: headers(preview.url) });
      assert.equal(ok.status, 200);
      const diff = await ok.text();
      assert.match(diff, /-.*First/);
      assert.match(diff, /\+.*Second/);

      rmSync(root, { recursive: true, force: true });
      const broken = await fetch(`${preview.url}/git/diff`, { headers: headers(preview.url) });
      assert.ok(broken.status >= 400, `a failed working diff answered ${broken.status}`);
      assert.match(broken.headers.get('content-type') ?? '', /text\/plain/);
      const body = await broken.text();
      assert.match(body, /^TeXChronicle could not read your working changes: /);
      assert.ok(body.length > 'TeXChronicle could not read your working changes: '.length,
        'the reason git gave was dropped, so the reader has nothing to act on');
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/diff-view refuses to screenshot a blank page it could not fill', async () => {
  // This page is what show_diff hands to an agent as a picture. A blank one
  // tells it, in an image, that nothing has changed.
  const root = paper();
  try {
    await createCheckpoint(root);
    await withServer(root, async (preview) => {
      const ok = await fetch(`${preview.url}/diff-view`, { headers: headers(preview.url) });
      assert.equal(ok.status, 200);

      rmSync(root, { recursive: true, force: true });
      const broken = await fetch(`${preview.url}/diff-view`, { headers: headers(preview.url) });
      assert.ok(broken.status >= 400, `a failed working diff rendered as a page with status ${broken.status}`);
      assert.match(await broken.text(), /^TeXChronicle could not read your working changes: /);
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown checkpoint still answers the way it always has', async () => {
  // Only the working-diff path changed. `sha` is caller-supplied and a bad one
  // is a client error, not a report about the author's files.
  const root = paper();
  try {
    await createCheckpoint(root);
    await withServer(root, async (preview) => {
      const bad = await fetch(`${preview.url}/git/diff?sha=notasha`, { headers: headers(preview.url) });
      assert.equal(bad.status, 400);
      assert.doesNotMatch(await bad.text(), /working changes/);
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Latin-1 include is shown as its author wrote it', async () => {
  // `readFile(p,'utf8')` decodes leniently, so every byte it could not make
  // sense of became U+FFFD: Live rendered the author's own prose full of
  // replacement characters while the compiled PDF beside it was perfect. This
  // route never writes anything back, so the answer here is to read the file
  // the way it actually is rather than to refuse it.
  const root = paper();
  try {
    writeFileSync(join(root, 'chapter.tex'), Buffer.from('Le r\u00e9sum\u00e9 de Fran\u00e7ois co\u00fbte 5\u00a0\u20ac.\n', 'latin1'));
    await withServer(root, async (preview) => {
      const response = await fetch(`${preview.url}/api/include?path=chapter.tex`, { headers: headers(preview.url) });
      assert.equal(response.status, 200);
      const include = await response.json() as { content: string };
      assert.match(include.content, /Le r\u00e9sum\u00e9 de Fran\u00e7ois/);
      assert.ok(!include.content.includes('\uFFFD'),
        `the include came back with replacement characters: ${JSON.stringify(include.content)}`);
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a UTF-8 include is still decoded as UTF-8', async () => {
  const root = paper();
  try {
    writeFileSync(join(root, 'chapter.tex'), 'Le r\u00e9sum\u00e9 co\u00fbte 5\u00a0\u20ac — vraiment.\n', 'utf8');
    await withServer(root, async (preview) => {
      const response = await fetch(`${preview.url}/api/include?path=chapter.tex`, { headers: headers(preview.url) });
      const include = await response.json() as { content: string };
      assert.match(include.content, /r\u00e9sum\u00e9 co\u00fbte 5\u00a0\u20ac — vraiment/,
        'a perfectly ordinary UTF-8 include was decoded as Latin-1');
    });
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
