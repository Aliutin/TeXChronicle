import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

test('CLI starts when Windows cannot provide os.userInfo', async () => {
  const { stdout, stderr } = await exec(process.execPath, [cli, 'preview', '--help'], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '--require=./test/fixtures/failing-user-info.cjs' },
  });
  assert.match(stdout, /Open a TeXChronicle workspace without an LLM/);
  assert.equal(stderr, '');
});
