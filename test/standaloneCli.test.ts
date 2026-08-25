import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { busytexPresent } from '../src/engine/assetsDir.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

test('standalone preview has a human-facing help command', async () => {
  const { stdout, stderr } = await exec(process.execPath, [cli, 'preview', '--help'], { cwd: root });
  assert.match(stdout, /Open a TeXChronicle workspace without an LLM/);
  assert.match(stdout, /texchronicle preview \[main\.tex\]/);
  assert.equal(stderr, '');
});

test('top-level help preserves the no-argument MCP entry point', async () => {
  const { stdout, stderr } = await exec(process.execPath, [cli, '--help'], { cwd: root });
  assert.match(stdout, /Start the MCP server on stdio/);
  assert.equal(stderr, '');
});

test('top-level help documents how to point the MCP server at a paper', async () => {
  const { stdout } = await exec(process.execPath, [cli, '--help'], { cwd: root });
  assert.match(stdout, /--project <dir>/);
  assert.match(stdout, /TEXCHRONICLE_PROJECT/);
});

// argv[2] was treated as a subcommand, so an option in that position was
// rejected outright — and `--project` is the documented way to tell the MCP
// server which folder to preview.
test('an option in the subcommand position is not an unknown command', async () => {
  const unknown = await exec(process.execPath, [cli, 'nonsense'], { cwd: root }).then(
    () => null,
    (error: { stderr?: string }) => error.stderr ?? '',
  );
  assert.match(String(unknown), /Unknown command: nonsense/);

  // The same run with --project must reach the server instead. It speaks stdio
  // and would sit there forever, so kill it as soon as it says it is ready.
  const started = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, '--project', root], { cwd: root });
    let stderr = '';
    const done = (value: string) => { child.kill(); resolvePromise(value); };
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (/ready on stdio|Unknown command/.test(stderr)) done(stderr);
    });
    child.on('error', rejectPromise);
    child.on('exit', () => resolvePromise(stderr));
  });
  assert.match(started, /ready on stdio/);
  assert.doesNotMatch(started, /Unknown command/);
});

// `--exit-after-initial-compile` is the portable build's self-test and the CI
// diagnostic: it prints its verdict and must then END. It did not, unless
// --desktop was also passed. enableLifecycleMonitoring() resumes stdin to notice
// a terminal wrapper closing the pipe, and a resumed stdin is a live libuv
// handle that keeps the loop turning by itself — so main() returned, shutdown()
// ran, the verdict was printed, and the process then sat there until something
// killed it.
//
// The stdin PIPE below is the whole fixture. Run from a shell with a redirect,
// stdin is already at EOF and its 'close' event calls shutdownAndExit() on its
// own, which hid the bug completely: the failing case is the one a real terminal
// produces, where stdin stays open.
test('--exit-after-initial-compile ends the process even with a terminal-like stdin', {
  timeout: 180_000,
  skip: busytexPresent() ? false : 'the bundled WASM TeX Live has not been downloaded on this machine',
}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'texchronicle-exit-'));
  writeFileSync(join(project, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nExit test.\n\\end{document}\n');
  try {
    const child = spawn(
      process.execPath,
      [cli, 'preview', '--exit-after-initial-compile', '--no-open', '--backend', 'wasm', '-p', project, 'main.tex'],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { output += String(chunk); });
    const timedOut = await new Promise<boolean>((done) => {
      const giveUp = setTimeout(() => { child.kill('SIGKILL'); done(true); }, 120_000);
      child.on('exit', () => { clearTimeout(giveUp); done(false); });
    });
    assert.match(output, /initial compile running/, output);
    assert.equal(timedOut, false, `the process never exited after its initial compile:\n${output}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('CLI starts when Windows cannot provide os.userInfo', async () => {
  const { stdout, stderr } = await exec(process.execPath, [cli, 'preview', '--help'], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '--require=./test/fixtures/failing-user-info.cjs' },
  });
  assert.match(stdout, /Open a TeXChronicle workspace without an LLM/);
  assert.equal(stderr, '');
});
