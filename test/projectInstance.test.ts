import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireProjectInstance, projectInstancePath } from '../src/projectInstance.js';

/** A server that answers, so "is this workspace still up?" has a real answer. */
async function listening(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => res.writeHead(200).end('ok'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/app`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test('a second desktop launch reuses the live project workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-instance-'));
  // The published URL has to be one something is actually listening on. It used
  // to be an invented port number, which passed only because the record was
  // trusted without ever being probed — the very thing the fix changes.
  const workspace = await listening();
  try {
    const first = await acquireProjectInstance(root);
    assert.equal(first.owned, true);
    if (!first.owned) return;
    await first.publish(workspace.url);

    const second = await acquireProjectInstance(root);
    assert.deepEqual(second, { owned: false, pid: process.pid, url: workspace.url });

    await first.release();
    const third = await acquireProjectInstance(root);
    assert.equal(third.owned, true, 'releasing the first instance left the project permanently locked');
    if (third.owned) await third.release();
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a record whose server is gone is taken over, not opened as a dead tab', async () => {
  // A hard kill (Task Manager, a closed terminal, a crash) leaves the ownership
  // record behind, and on Windows its PID can even have been handed to
  // something else by then — so "the PID is alive" proves nothing. Every later
  // launch announced "already open", opened a browser tab at an address nothing
  // was listening on, and exited, with no way back short of finding and
  // deleting a file inside .latex-preview.
  //
  // process.pid is the sharpest form of the bug: unambiguously alive, same
  // user, no ambiguity left except whether the URL answers.
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-instance-dead-'));
  try {
    // acquireProjectInstance keys the record off the canonical path, and on
    // Windows a temp directory reaches us through an 8.3 alias often enough
    // that writing to the uncanonical one would test nothing.
    const canonical = await realpath(root);
    const record = projectInstancePath(canonical);
    await mkdir(dirname(record), { recursive: true });
    const dead = await listening();
    const url = dead.url;
    await dead.close(); // the port is now closed: the record outlived its server
    await writeFile(record, JSON.stringify({
      pid: process.pid, token: 'stale', root: canonical, started: new Date().toISOString(), url,
    }), 'utf8');

    const instance = await acquireProjectInstance(root);
    assert.equal(instance.owned, true, `handed back a workspace at ${url} that nothing is serving`);
    if (instance.owned) await instance.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
