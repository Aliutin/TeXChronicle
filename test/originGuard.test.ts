import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { request } from 'node:http';
import { startPreviewServer } from '../src/preview/previewServer.js';
import { setProjectRoot } from '../src/session.js';

// This server is reachable from every web page the user visits, because
// localhost is reachable from every origin. Binding 127.0.0.1 keeps other
// machines out; it does nothing about the user's own browser.
//
// The attack needs nothing clever:
//
//   fetch('http://127.0.0.1:' + p + '/api/fs', {
//     method: 'POST', mode: 'no-cors', body: '{"op":"delete","path":"main.tex"}' })
//
// text/plain is a CORS-simple request, so there is no preflight: the browser
// delivers it and the server executes it. The attacker cannot read the reply and
// does not need to — deleteEntry runs rm(recursive, force).

/** A GET with headers `fetch` refuses to set (Host is a forbidden header name). */
function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function server() {
  const root = mkdtempSync(join(tmpdir(), 'magictex-origin-'));
  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
  writeFileSync(join(root, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  setProjectRoot(root);
  const preview = await startPreviewServer();
  return { root, preview, base: `http://127.0.0.1:${preview.port}` };
}

test('a cross-origin POST cannot delete a file', async () => {
  const { root, preview, base } = await server();
  try {
    const res = await fetch(`${base}/api/fs`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: JSON.stringify({ op: 'delete', path: 'main.tex' }),
    });
    assert.equal(res.status, 403, 'the request was not refused');
    assert.ok(existsSync(join(root, 'main.tex')), 'main.tex was deleted by a cross-origin request');
  } finally { await preview.close(); }
});

test('a cross-origin POST cannot overwrite a file', async () => {
  const { root, preview, base } = await server();
  try {
    const res = await fetch(`${base}/api/upload?path=main.tex`, {
      method: 'POST', headers: { Origin: 'https://evil.example' }, body: 'OWNED',
    });
    assert.equal(res.status, 403);
    assert.ok(!(await import('node:fs')).readFileSync(join(root, 'main.tex'), 'utf8').includes('OWNED'));
  } finally { await preview.close(); }
});

test('a mutation with no Origin at all is refused', async () => {
  // Browsers always set Origin on non-GET. A missing one is a client we did not
  // ship, and this is a security boundary rather than a convenience.
  const { preview, base } = await server();
  try {
    const res = await fetch(`${base}/api/fs`, {
      method: 'POST', body: JSON.stringify({ op: 'mkdir', path: 'sneaky' }),
    });
    assert.equal(res.status, 403);
    const body = await res.text();
    assert.match(body, /Origin/, `the refusal should say which rule fired: ${body}`);
  } finally { await preview.close(); }
});

test('Sec-Fetch-Site: cross-site is refused even on a GET', async () => {
  const { preview, base } = await server();
  try {
    const res = await fetch(`${base}/api/files`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 403);
  } finally { await preview.close(); }
});

test('a rebound Host is refused — this is the read half', async () => {
  // DNS rebinding points evil.com at 127.0.0.1, making the attacker's page
  // same-origin with us: Origin and Sec-Fetch-Site both pass, and GET
  // /api/file or /export.zip becomes exfiltration of the whole project. The
  // browser still sends the name from the URL bar.
  //
  // Sent with node:http, not fetch. `Host` is a forbidden header name, so
  // undici drops it silently — a first version of this test used fetch, watched
  // the request go out with the correct Host, and passed while testing nothing.
  const { preview } = await server();
  try {
    const { status, body } = await rawGet(preview.port, '/api/files', { Host: 'evil.example' });
    assert.equal(status, 403, 'a rebound Host was served');
    assert.match(body, /Host/, 'the refusal should name the rule');
  } finally { await preview.close(); }
});

test('a loopback Host on the right port is still served', async () => {
  const { preview } = await server();
  try {
    const { status } = await rawGet(preview.port, '/api/files', { Host: `localhost:${preview.port}` });
    assert.equal(status, 200, 'localhost is a legitimate way to reach this server');
  } finally { await preview.close(); }
});

test('the workspace itself still works', async () => {
  // The guard is worthless if it blocks our own page. These are the exact
  // headers a browser sends for a same-origin fetch from /app.
  const { preview, base } = await server();
  try {
    const origin = `http://127.0.0.1:${preview.port}`;
    const get = await fetch(`${base}/api/files`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(get.status, 200, 'a same-origin GET was refused');

    const asset = await fetch(`${base}/api/asset?path=figure.png`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(asset.status, 200, 'a same-origin project image was refused');
    assert.equal(asset.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);

    const post = await fetch(`${base}/api/fs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ op: 'mkdir', path: 'sections' }),
    });
    assert.equal(post.status, 200, 'a same-origin POST was refused');

    // And a plain navigation (typed URL, or the auto-opened tab): no Origin,
    // Sec-Fetch-Site: none.
    const nav = await fetch(`${base}/viewer`, { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(nav.status, 200, 'a navigation was refused');
  } finally { await preview.close(); }
});

test('a WebSocket from another origin is refused', async () => {
  const { preview } = await server();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${preview.port}`, { origin: 'https://evil.example' });
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('opened'));
      ws.once('error', () => resolve('refused'));
    });
    assert.equal(outcome, 'refused', 'a hostile page could open the live channel');
  } finally { await preview.close(); }
});

test('a WebSocket from the workspace still connects', async () => {
  const { preview } = await server();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${preview.port}`, {
      origin: `http://127.0.0.1:${preview.port}`,
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('opened'));
      ws.once('error', (e) => resolve('refused: ' + e.message));
    });
    assert.equal(outcome, 'opened');
    ws.close();
  } finally { await preview.close(); }
});
