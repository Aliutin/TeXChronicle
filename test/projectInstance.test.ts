import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProjectInstance } from '../src/projectInstance.js';

test('a second desktop launch reuses the live project workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-instance-'));
  try {
    const first = await acquireProjectInstance(root);
    assert.equal(first.owned, true);
    if (!first.owned) return;
    await first.publish('http://127.0.0.1:54321/app');

    const second = await acquireProjectInstance(root);
    assert.deepEqual(second, {
      owned: false,
      pid: process.pid,
      url: 'http://127.0.0.1:54321/app',
    });

    await first.release();
    const third = await acquireProjectInstance(root);
    assert.equal(third.owned, true, 'releasing the first instance left the project permanently locked');
    if (third.owned) await third.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
