import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { killTree } from '../src/engine/systemTex.js';

const pexec = promisify(execFile);

// latexmk is a Perl script that spawns xelatex, which spawns Inkscape. Stopping
// a wedged compile therefore means stopping a tree, and `execFile`'s own
// `timeout` option does not do that — it kills the one process it started.
//
// On this machine two failed compiles of a single paper left SEVEN live
// latexmk/perl/xelatex processes, holding handles on the build directory and
// making the next attempt slower, which made it time out too.

/** A parent that prints its child's pid and then waits. Ordinary children, not
 *  detached — the same shape as latexmk -> xelatex. */
const PARENT_SRC =
  "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' });" +
  "console.log('child=' + c.pid);" +
  'setInterval(() => {}, 1e9);';

function spawnTree(): Promise<{ parent: number; child: number; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', PARENT_SRC], {
      // Matching runLatexmk: a process group on POSIX so the group can be taken
      // down; Windows has no groups and taskkill /T walks the tree instead.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const t = setTimeout(() => reject(new Error('the probe tree never reported its child')), 15_000);
    p.stdout.on('data', (b) => {
      const m = String(b).match(/child=(\d+)/);
      if (!m) return;
      clearTimeout(t);
      resolve({ parent: p.pid!, child: Number(m[1]), kill: () => { try { killTree(p.pid!); } catch { /* done */ } } });
    });
    p.on('error', reject);
  });
}

async function alive(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    const { stdout } = await pexec('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true });
    return stdout.includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Windows reports a killed process gone a moment after the call returns. */
async function settle(pid: number): Promise<boolean> {
  for (let i = 0; i < 25; i++) {
    if (!(await alive(pid))) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
}

test('killTree takes down the whole tree, not just the process we spawned', async (t) => {
  if (process.platform === 'win32') {
    try { await alive(process.pid); }
    catch {
      t.skip('this Windows sandbox denies tasklist, so process-tree liveness cannot be measured');
      return;
    }
  }
  const tree = await spawnTree();
  try {
    assert.ok(await alive(tree.child), 'the probe child never started, so this proves nothing');
    killTree(tree.parent);
    assert.equal(await settle(tree.child), false,
      'the grandchild outlived the kill — this is the leak that left seven latexmk/perl processes behind');
    assert.equal(await settle(tree.parent), false, 'the parent survived too');
  } finally {
    tree.kill();
  }
});

// There is deliberately no test here asserting that `execFile`'s own `timeout`
// leaks the tree, even though that is the bug killTree exists for.
//
// It was written, and it failed — because a plain Node grandchild spawned this
// way does NOT survive its parent being killed on Windows:
//
//   parent alive after kill : false
//   child  alive after kill : false
//
// A grandchild launched the way PowerShell's Start-Process launches one does
// survive, and so does the real thing: two failed compiles of one paper left
// seven live latexmk/perl/xelatex processes on this machine, which is the
// observation this whole change rests on. Which of those a given launcher
// produces is not something a portable test can pin down, and tuning the probe
// until it goes red would be engineering the evidence rather than gathering it.
//
// So the justification for killTree is the field observation plus POSIX process
// groups, where the leak is unambiguous. What is tested here is the only thing a
// test can honestly settle: that killTree does what its name says.
