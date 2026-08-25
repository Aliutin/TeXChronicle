import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextFile, readTextFileWithEtag, writeTextFile } from '../src/preview/filesApi.js';
import { forgetHistoryRepo } from '../src/git/historyRepo.js';
import { startPreviewServer } from '../src/preview/previewServer.js';
import { setProjectRoot } from '../src/session.js';

// What the editor's read/save path has to guarantee: it never silently changes
// bytes it did not mean to change, it never leaves half a file on disk, and it
// never throws away a save it cannot see.

const bytes = (root: string, rel: string) => readFileSync(join(root, rel));

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-files-'));
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Text\\end{document}\n');
  return root;
}

test('a non-UTF-8 source is refused instead of being corrupted by opening it', async () => {
  // `readFile(p,'utf8')` decodes leniently: any byte it cannot make sense of
  // becomes U+FFFD, silently and one-way. A Latin-1 .tex — still ordinary in
  // older papers, `\usepackage[latin1]{inputenc}` — opened fine, and the next
  // save, even one that changed nothing, wrote every é back as a replacement
  // character. Measured: e9 in, ef bf bd out.
  const root = project();
  try {
    const latin1 = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]); // "Café naïve\n"
    writeFileSync(join(root, 'legacy.tex'), latin1);
    await assert.rejects(() => readTextFile(root, 'legacy.tex'), /is not UTF-8/);
    // The message has to be actionable: what it is, why we will not open it,
    // how to convert it, and what still works meanwhile.
    const message = await readTextFile(root, 'legacy.tex').then(() => '', (e: Error) => e.message);
    assert.match(message, /iconv/);
    assert.match(message, /compiling and history still work/);
    assert.deepEqual(bytes(root, 'legacy.tex'), latin1, 'the file was touched by a failed read');

    // UTF-16 from Notepad lost its whole text the same way.
    const utf16 = Buffer.from('\uFEFFab\n', 'utf16le');
    writeFileSync(join(root, 'notepad.tex'), utf16);
    await assert.rejects(() => readTextFile(root, 'notepad.tex'), /is not UTF-8/);
    assert.deepEqual(bytes(root, 'notepad.tex'), utf16);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a save that changes nothing changes no bytes — BOM and CRLF included', async () => {
  // The decoder must keep a UTF-8 BOM in the string (dropping it is what makes
  // an untouched save rewrite the file's first three bytes), and nothing may
  // normalise line endings behind the author's back.
  const root = project();
  try {
    for (const [name, original] of [
      ['bom.tex', Buffer.from('\uFEFF\\documentclass{article}\r\nHello\r\n', 'utf8')],
      ['crlf.tex', Buffer.from('line one\r\nline two\r\n', 'utf8')],
      ['lf.tex', Buffer.from('line one\nline two\n', 'utf8')],
      ['utf8.tex', Buffer.from('Caf\u00e9 na\u00efve — ok\n', 'utf8')],
    ] as Array<[string, Buffer]>) {
      writeFileSync(join(root, name), original);
      await writeTextFile(root, name, await readTextFile(root, name));
      assert.deepEqual(bytes(root, name), original, `${name} did not round-trip byte-identically`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a save leaves no temp file behind', async () => {
  // The write goes to a sibling temp file and renames, so a crash mid-write
  // cannot truncate the paper and the watcher cannot read half of one. The
  // temp must not survive the write, or the project fills up with them.
  const root = project();
  try {
    await writeTextFile(root, 'main.tex', 'saved\n');
    const leftovers = readdirSync(root).filter((name) => name.includes('tc-save'));
    assert.deepEqual(leftovers, []);
    assert.equal(readFileSync(join(root, 'main.tex'), 'utf8'), 'saved\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the ETag identifies the exact bytes on disk', async () => {
  const root = project();
  try {
    const first = await readTextFileWithEtag(root, 'main.tex');
    assert.match(first.etag, /^[0-9a-f]{64}$/);
    assert.equal((await readTextFileWithEtag(root, 'main.tex')).etag, first.etag, 'a read changed the etag');
    const written = await writeTextFile(root, 'main.tex', 'different\n');
    assert.notEqual(written.etag, first.etag);
    assert.equal((await readTextFileWithEtag(root, 'main.tex')).etag, written.etag,
      'the etag returned by a write is not the etag of what is now on disk');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a conditional save refuses rather than flatten a change it never saw', async () => {
  // Two browser tabs, or a tab and Claude's own Edit, and the last save used to
  // win with no sign that anything was lost. The whole contract lives on the
  // wire, so it is tested there: GET hands out an ETag, PUT sends it back as
  // If-Match, and a stale one is a 409 that writes nothing at all.
  const root = project();
  let preview: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
  try {
    forgetHistoryRepo();
    setProjectRoot(root);
    preview = await startPreviewServer();
    const url = preview.url;
    const headers = { Origin: url, 'Sec-Fetch-Site': 'same-origin' };
    const get = () => fetch(`${url}/api/file?path=main.tex`, { headers });
    const put = (body: string, ifMatch?: string) => fetch(`${url}/api/file?path=main.tex`, {
      method: 'PUT',
      headers: { ...headers, ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) },
      body,
    });

    const loaded = await get();
    assert.equal(loaded.status, 200);
    const etag = loaded.headers.get('etag');
    assert.ok(etag && /^"[0-9a-f]{64}"$/.test(etag), `no usable ETag on the read: ${etag}`);

    // Somebody else saves — another tab, an agent, an external editor.
    writeFileSync(join(root, 'main.tex'), 'THEIR WORK\n');

    const stale = await put('MY WORK\n', etag!);
    assert.equal(stale.status, 409);
    assert.equal((await stale.text()).trim(), 'file changed on disk');
    assert.equal(readFileSync(join(root, 'main.tex'), 'utf8'), 'THEIR WORK\n',
      'the refused save was written anyway');

    // Re-read, then save against the version actually on disk.
    const current = await get();
    const fresh = current.headers.get('etag')!;
    assert.notEqual(fresh, etag);
    const accepted = await put('MERGED WORK\n', fresh);
    assert.equal(accepted.status, 200);
    assert.equal(readFileSync(join(root, 'main.tex'), 'utf8'), 'MERGED WORK\n');
    const returned = accepted.headers.get('etag');
    assert.ok(returned && returned !== fresh, 'the save did not hand back the new version');
    assert.equal(returned, (await get()).headers.get('etag'));

    // Quoting is optional on the way in, and W/ is tolerated.
    const unquoted = (await get()).headers.get('etag')!.replace(/"/g, '');
    assert.equal((await put('AGAIN\n', unquoted)).status, 200);

    // No header at all keeps the historical unconditional save, so an older UI
    // and any non-browser caller are unaffected.
    assert.equal((await put('UNCONDITIONAL\n')).status, 200);
    assert.equal(readFileSync(join(root, 'main.tex'), 'utf8'), 'UNCONDITIONAL\n');
  } finally {
    await preview?.close();
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
