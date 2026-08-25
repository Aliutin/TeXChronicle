// startWatching() used to be `if (watcher) return`, which pinned the watcher to
// whatever directory the first render_preview ran in for the life of the
// process. Pointed at a wrong root once — a client that spawns servers from the
// home directory — it stayed there, recursively polling a home folder on Windows
// and never watching the paper at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startWatching, stopWatching, watchingRoot } from '../src/watch/fileWatcher.js';

const dirs: string[] = [];
const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'watch-'));
  dirs.push(made);
  return made;
};

test.after(async () => {
  await stopWatching();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('nothing is watched until something asks', () => {
  assert.equal(watchingRoot(), null);
});

test('a different root re-targets the watcher instead of being ignored', async () => {
  const first = dir();
  const second = dir();
  startWatching(first);
  assert.equal(watchingRoot(), resolve(first));

  startWatching(second);
  assert.equal(watchingRoot(), resolve(second), 'the second root must take over');

  await stopWatching();
  assert.equal(watchingRoot(), null);
});

test('the same root twice is still a no-op', async () => {
  const root = dir();
  startWatching(root);
  const settled = watchingRoot();
  startWatching(root);
  assert.equal(watchingRoot(), settled);
  // A trailing separator or a relative spelling names the same directory.
  startWatching(`${root}${'/'}.`);
  assert.equal(watchingRoot(), settled);
  await stopWatching();
});
