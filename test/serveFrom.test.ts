import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { startPreviewServer, type PreviewServerHandle } from '../src/preview/previewServer.js';

// `serveFrom` decides what the local server hands out of our asset directories.
// Its guard compared a joined-and-normalised path against a root that was
// neither, which got two different things wrong.
//
// Driven over real HTTP rather than by calling the function: the guard's job is
// what comes back on the wire, and the function is not exported.

const trash: string[] = [];

/** What `TEXCHRONICLE_ASSETS_DIR` points at: the directory holding busytex.wasm
 *  itself. `/busytex/<rel>` is served from it directly — a first version of this
 *  test nested the file one level deeper and everything 404'd, including the
 *  case that was supposed to pass. */
function assetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'texchronicle-assets-'));
  trash.push(dir);
  writeFileSync(join(dir, 'busytex.wasm'), 'WASM BYTES');
  return dir;
}

/** Raw request, path sent verbatim. `fetch` runs its argument through the WHATWG
 *  URL parser, which collapses `..` and `%2e%2e` before anything is sent — so a
 *  traversal test written with `fetch` measures the client, not the server. */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(assets: string, fn: (h: PreviewServerHandle) => Promise<void>): Promise<void> {
  const prev = process.env.TEXCHRONICLE_ASSETS_DIR;
  process.env.TEXCHRONICLE_ASSETS_DIR = assets;
  let handle: PreviewServerHandle | undefined;
  try {
    handle = await startPreviewServer();
    await fn(handle);
  } finally {
    await handle?.close().catch(() => {});
    if (prev === undefined) delete process.env.TEXCHRONICLE_ASSETS_DIR; else process.env.TEXCHRONICLE_ASSETS_DIR = prev;
    for (const p of trash.splice(0)) rmSync(p, { recursive: true, force: true });
  }
}

test('an assets directory written with forward slashes still serves', async () => {
  // The path in TEXCHRONICLE_ASSETS_DIR is typed by a human, and the natural place
  // to put it is a JSON config — where a backslash has to be doubled and a
  // forward slash does not. `join`/`normalize` return the platform separator, so
  // on Windows the resolved file had backslashes and the root did not; the
  // prefix check failed and every engine asset 403'd. What the user saw was
  // "BusyTeX worker failed to initialize", pointing nowhere near the setting.
  const dir = assetsDir();
  const forward = dir.split('\\').join('/');
  await withServer(forward, async (h) => {
    const res = await rawGet(h.port, '/busytex/busytex.wasm');
    assert.equal(res.status, 200,
      `HTTP ${res.status} for the engine's own asset with the path written as ${forward}`);
    assert.equal(res.body, 'WASM BYTES');
  });
});

test('the same directory in native form serves too — the fix did not just invert the bug', async () => {
  const dir = assetsDir();
  await withServer(dir, async (h) => {
    const res = await rawGet(h.port, '/busytex/busytex.wasm');
    assert.equal(res.status, 200, `HTTP ${res.status} for ${dir}`);
    assert.equal(res.body, 'WASM BYTES');
  });
});

test('a file outside the served directory is refused, however the traversal is encoded', async () => {
  // A prefix match on a path is not containment: `…/assets-elsewhere/x` starts
  // with `…/assets`. I first wrote this off as unreachable, on the reasoning that
  // both URL parsers collapse dot segments. Measured instead of assumed, two
  // encodings walk straight through: `%2f` is NOT a segment separator to the URL
  // parser, so `%2e%2e%2f` and `..%2f` survive it intact — and the server
  // decodeURIComponent()s the pathname afterwards, turning them back into `../`.
  //
  // Against the old guard both returned HTTP 200 with the file's contents.
  const dir = assetsDir();
  const sibling = `${dir}-elsewhere`;
  mkdirSync(sibling, { recursive: true });
  trash.push(sibling);
  writeFileSync(join(sibling, 'secret.txt'), 'NOT YOURS');
  const name = basename(sibling);

  await withServer(dir, async (h) => {
    for (const [label, path] of [
      ['encoded dots and slash', `/busytex/%2e%2e%2f${name}/secret.txt`],
      ['encoded slash only', `/busytex/..%2f${name}/secret.txt`],
      // These two are collapsed by the server's own `new URL()` before the guard
      // ever sees them. Kept so that if a future parser stops collapsing them,
      // the guard is already being asked the question.
      ['literal dots', `/busytex/../${name}/secret.txt`],
      ['encoded dots only', `/busytex/%2e%2e/${name}/secret.txt`],
    ] as const) {
      const res = await rawGet(h.port, path);
      assert.notEqual(res.body, 'NOT YOURS',
        `${label}: a file outside the served directory was returned (HTTP ${res.status})`);
      assert.notEqual(res.status, 200, `${label}: expected a refusal, got HTTP 200`);
    }

    // And the guard did not simply start refusing everything.
    const ok = await rawGet(h.port, '/busytex/busytex.wasm');
    assert.equal(ok.status, 200, 'the real asset stopped being served');
  });
});
