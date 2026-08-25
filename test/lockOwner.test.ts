import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../src/lock.js';

// The lock file is a machine-local answer to a question this project made
// cross-machine: `.latex-preview/` is in Dropbox by design, so the lock
// synchronises to the author's other computer, where the pid it names belongs
// to some unrelated local process, or to none at all.

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-lock-'));
  mkdirSync(join(root, '.latex-preview'), { recursive: true });
  return root;
}

const lockFile = (root: string) => join(root, '.latex-preview', '.lock');

test('the lock says which machine holds it, not only which pid', async () => {
  const root = project();
  try {
    let held = '';
    await withLock(root, async () => { held = readFileSync(lockFile(root), 'utf8'); });
    assert.equal(held, `${hostname()}:${process.pid}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lock synchronised from another machine is stale on sight', async () => {
  // The failure this fixes, both halves of it: a pid that happens to be alive
  // here made this machine wait the full 15 s and then refuse — "another agent
  // appears to be mid-edit" — for a computer that had been switched off for a
  // week. `process.pid` is guaranteed to be alive, so it is exactly that case.
  const root = project();
  try {
    writeFileSync(lockFile(root), `some-other-laptop:${process.pid}`);
    const started = Date.now();
    let ran = false;
    await withLock(root, async () => { ran = true; });
    const took = Date.now() - started;
    assert.equal(ran, true);
    assert.ok(took < 1000, `waited ${took}ms for a lock held by a different computer`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live lock on THIS machine is still respected', async () => {
  // The other half: within one machine the pid is the right answer, and
  // breaking a live lock walks a second process straight into the checkpoint
  // critical section this exists to serialise. Bare digits are what versions
  // before the hostname wrote, and they still mean "this machine".
  const root = project();
  try {
    writeFileSync(lockFile(root), String(process.pid));
    let acquired = false;
    const pending = withLock(root, async () => { acquired = true; });
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(acquired, false, 'a live lock from this machine was broken');
    rmSync(lockFile(root), { force: true }); // the holder finishes
    await pending;
    assert.equal(acquired, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bare-pid lock whose owner is gone is cleared, as it always was', async () => {
  const root = project();
  try {
    writeFileSync(lockFile(root), '999999');
    const started = Date.now();
    await withLock(root, async () => {});
    assert.ok(Date.now() - started < 1000, 'a dead legacy lock blocked the project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
