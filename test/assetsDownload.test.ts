import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadCommand } from '../src/engine/assets.js';

// The 480 MB first-run download is the very first thing TeXChronicle does on a new
// machine, and on Windows it was launched through a shell with the destination
// path unquoted. A per-user cache path contains a space for every user whose
// account name does — which is most people who use their real name — so the
// download went to the wrong place, or nowhere.

/** A stand-in for the downloader: prints the argv it was actually given. Kept at
 *  a path with no space of its own, so the only space in play is the one under
 *  test. */
function argvEcho(): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'argv-'));
  const script = join(dir, 'echo-argv.cjs');
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  return { dir, script };
}

const DEST_WITH_SPACE = join(tmpdir(), 'A User', 'AppData', 'Local', 'texchronicle');

test('the downloader is launched without a shell, so a path with a space stays one argument', () => {
  const plan = downloadCommand(DEST_WITH_SPACE);

  // No shell means Node passes an argv array, and the OS hands it to the child
  // unchanged. There is no quoting for the destination to be lost in.
  assert.equal(plan.command, process.execPath,
    'run by the node we are already running, not by npx through a shell');
  assert.ok(existsSync(plan.args[0]), `the CLI does not exist at ${plan.args[0]}`);
  assert.deepEqual(plan.args.slice(1), ['download-assets', DEST_WITH_SPACE]);
  assert.equal(plan.args.filter((a) => a === DEST_WITH_SPACE).length, 1,
    'the destination must appear exactly once, whole');
});

test('and the launch really delivers it — measured, not assumed', () => {
  // Assert about the child's argv rather than about our own object, because the
  // bug was never in the arguments we assembled. It was in what the shell did to
  // them on the way.
  const { dir, script } = argvEcho();
  try {
    const out = execFileSync(process.execPath, [script, 'download-assets', DEST_WITH_SPACE], { stdio: 'pipe' }).toString();
    assert.deepEqual(JSON.parse(out), ['download-assets', DEST_WITH_SPACE],
      'the child did not receive the destination as a single argument');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the old shell launch tears the path in half — the same call, one option different', () => {
  // Why this runs on every platform and not just Windows: `shell: true` makes
  // Node join the arguments into one command line without quoting any of them,
  // and the shell then re-splits on whitespace. That is true on macOS and Linux
  // too. The shipped code only set it on win32, so only Windows users were hit —
  // but the mechanism is not platform-specific, so neither is the evidence.
  //
  // A bare command name on PATH, because that is exactly what the shipped code
  // launched: `npx`. Using `process.execPath` instead makes this fail earlier and
  // for a second reason on Windows, where node itself lives under
  // "C:\Program Files\" — same missing quoting, but it never gets far enough to
  // show what happens to the destination.
  const { dir, script } = argvEcho();
  try {
    const out = execFileSync('node', [script, 'download-assets', DEST_WITH_SPACE],
      { stdio: 'pipe', shell: true }).toString();
    const received = JSON.parse(out) as string[];
    assert.notDeepEqual(received, ['download-assets', DEST_WITH_SPACE],
      'shell: true delivered the path intact here, so this says nothing about why it was dropped');
    assert.ok(received.length > 2,
      `expected the shell to split the destination; it returned ${JSON.stringify(received)}`);
    // Measured on Windows:
    //   ["download-assets", "C:\\Users\\...\\A", "User\\AppData\\Local\\texchronicle"]
    // The download went to `C:\Users\...\A`.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
