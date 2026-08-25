import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlive } from '../src/lock.js';

// `process.kill(pid, 0)` throws for two opposite reasons: ESRCH ("no such
// process") and EPERM ("it is there, and you may not signal it"). Reading both
// as dead is what let an ordinary session break the lock of an elevated or
// another user's TeXChronicle and walk into the checkpoint critical section the
// lock exists to serialise. The same three-line function guards the workspace
// ownership record and the recent-projects index.

test('a running process is alive', () => {
  assert.equal(isAlive(process.pid), true);
});

test('a pid nothing owns is dead', () => {
  assert.equal(isAlive(999_999), false);
});

test('a process this user may not signal is alive, not dead', (t) => {
  // PID 4 is the Windows System process: always running, never signalable from
  // a user session, so kill(4, 0) is the EPERM case exactly. PID 1 is init on
  // POSIX, with the same property for a non-root process.
  const pid = process.platform === 'win32' ? 4 : 1;
  let code: string | undefined;
  try { process.kill(pid, 0); }
  catch (error) { code = (error as NodeJS.ErrnoException).code; }
  if (code !== 'EPERM') {
    return t.skip(`pid ${pid} answers ${code ?? 'signalable'} here, so this machine cannot exercise EPERM`);
  }
  assert.equal(isAlive(pid), true, 'a live process we may not signal was reported dead, and its lock is stealable');
});
