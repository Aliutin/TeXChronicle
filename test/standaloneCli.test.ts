import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

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

test('CLI starts when Windows cannot provide os.userInfo', async () => {
  const { stdout, stderr } = await exec(process.execPath, [cli, 'preview', '--help'], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '--require=./test/fixtures/failing-user-info.cjs' },
  });
  assert.match(stdout, /Open a TeXChronicle workspace without an LLM/);
  assert.equal(stderr, '');
});
