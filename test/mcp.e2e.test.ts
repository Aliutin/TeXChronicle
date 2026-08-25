// End-to-end: spawn the real MCP server as a subprocess and drive the review
// workflow over stdio. Only the comment tools are exercised, so no browser /
// WASM engine is needed — this stays fast and reliable in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCheckpoint } from '../src/git/checkpoints.js';

const server = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

test('review workflow over MCP: post → gate → located → thread → resolve', { timeout: 90_000 }, async () => {
  const proj = mkdtempSync(join(tmpdir(), 'e2e-'));
  writeFileSync(join(proj, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nWe report a large speedup on the benchmark today.\n\\end{document}\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: proj,
    env: inheritedEnv,
  });
  const client = new Client({ name: 'ci', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })).content.map((x: { text?: string }) => x.text ?? '').join('\n');

  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['add_comment', 'check_comments', 'list_checkpoints', 'render_preview', 'reply_to_comment', 'resolve_comment', 'show_diff']);

    // A reviewer suggestion is NOT actionable until accepted.
    await call('add_comment', { quote: 'large speedup on the benchmark', comment: 'Which baseline?', role: 'reviewer' });
    let ck = await call('check_comments');
    assert.match(ck, /No accepted comments/);
    assert.match(ck, /1 reviewer suggestion/);

    // An accepted (autonomous) comment is actionable, role-tagged, and located.
    const posted = await call('add_comment', { quote: 'We report a large speedup', comment: 'Cite the runs.', role: 'defender', accepted: true });
    const id = posted.match(/comment ([0-9a-f]{6,})/)?.[1];
    assert.ok(id, 'expected a new comment id');
    ck = await call('check_comments');
    assert.match(ck, /1 accepted comment/);
    assert.match(ck, /main\.tex:3/);
    assert.match(ck, /\(defender\)/);

    // Threaded reply shows up in the work item.
    await call('reply_to_comment', { id, text: 'averaged over 5 runs', role: 'author' });
    ck = await call('check_comments');
    assert.match(ck, /author: averaged over 5 runs/);

    // A resolution cannot claim provenance until a successful-render checkpoint
    // exists. The helper below simulates that completed render without starting
    // Chromium/WASM, which this comment-workflow test deliberately avoids.
    const blocked = await call('resolve_comment', { id, note: 'added the baseline + runs' });
    assert.match(blocked, /not the latest successful checkpoint/);
    ck = await call('check_comments');
    assert.match(ck, /1 accepted comment/);

    const checkpoint = await createCheckpoint(proj);
    assert.ok(checkpoint.sha, checkpoint.error ?? 'expected a successful-render checkpoint');
    const resolved = await call('resolve_comment', { id, note: 'added the baseline + runs' });
    assert.match(resolved, /Resolved comment/);
    ck = await call('check_comments');
    assert.match(ck, /No accepted comments/);
  } finally {
    await client.close();
    rmSync(proj, { recursive: true, force: true });
  }
});

/** A directory shaped like somebody's home folder: ordinary subfolders, no .tex. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'e2e-home-'));
  for (const name of ['Documents', 'Downloads', 'Pictures']) mkdirSync(join(home, name));
  writeFileSync(join(home, 'notes.txt'), 'x');
  return home;
}

const connect = async (cwd: string, args: string[] = [], extraEnv: Record<string, string> = {}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, ...args],
    cwd,
    env: { ...inheritedEnv, ...extraEnv },
  });
  const client = new Client({ name: 'ci', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    call: async (name: string, callArgs: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: callArgs });
      return {
        isError: result.isError === true,
        text: (result.content as { text?: string }[]).map((x) => x.text ?? '').join('\n'),
      };
    },
  };
};

// Claude Code and Codex spawn the server inside the paper; other clients spawn it
// from the user's home directory. Started there, the server used to answer "No
// .tex files found" — but only AFTER startWatching() had pinned a recursive
// watcher to the home folder and the coordinator had created
// .latex-preview/history.git inside it. Both had to move behind the guard.
test('a wrong project root is refused before anything is written into it', { timeout: 60_000 }, async () => {
  const home = fakeHome();
  const { client, call } = await connect(home);
  try {
    const rendered = await call('render_preview');
    assert.equal(rendered.isError, true);
    assert.match(rendered.text, /does not look like a LaTeX project/);
    assert.ok(rendered.text.includes(home), 'the error must name the directory it refused');
    assert.match(rendered.text, /TEXCHRONICLE_PROJECT/);
    assert.match(rendered.text, /--project/);

    // The read-only tools reach historyRepo(), which CREATES the store — so they
    // are guarded too, or the second tool call undoes the first guard's work.
    for (const tool of ['list_checkpoints', 'check_comments']) {
      const result = await call(tool);
      assert.equal(result.isError, true, `${tool} should refuse the wrong root`);
      assert.match(result.text, /does not look like a LaTeX project/);
    }
  } finally {
    await client.close();
  }
  // Give the server's teardown a moment to finish before looking.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(existsSync(join(home, '.latex-preview')), false,
    'no history store may be created in a directory that is not a project');
  rmSync(home, { recursive: true, force: true });
});

// The rescue, proved through the comment tools rather than render_preview: a
// successful render would start Chromium and the WASM engine, which this file
// deliberately avoids. The store landing in the paper is the whole claim.
test('TEXCHRONICLE_PROJECT rescues a server started in the wrong directory', { timeout: 60_000 }, async () => {
  const home = fakeHome();
  const proj = mkdtempSync(join(tmpdir(), 'e2e-paper-'));
  writeFileSync(join(proj, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nA sentence to anchor a comment onto.\n\\end{document}\n');
  const { client, call } = await connect(home, [], { TEXCHRONICLE_PROJECT: proj });
  try {
    const posted = await call('add_comment', { quote: 'A sentence to anchor', comment: 'Rescued.', accepted: true });
    assert.equal(posted.isError, false, posted.text);
    const checked = await call('check_comments');
    assert.match(checked.text, /1 accepted comment/);
    assert.match(checked.text, /main\.tex:3/, 'the anchor must be found in the paper, not the cwd');
  } finally {
    await client.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(existsSync(join(home, '.latex-preview')), false, 'nothing may be written into the cwd');
  assert.equal(existsSync(join(proj, '.latex-preview')), true, 'the store belongs to the paper');
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

// bin/cli.mjs treated argv[2] as a subcommand, so this exact invocation printed
// "Unknown command: --project" and exited before the server ever started.
test('--project reaches the server through bin/cli.mjs', { timeout: 60_000 }, async () => {
  const home = fakeHome();
  const proj = mkdtempSync(join(tmpdir(), 'e2e-paper-'));
  writeFileSync(join(proj, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nAnother anchorable sentence.\n\\end{document}\n');
  const { client, call } = await connect(home, ['--project', proj]);
  try {
    const posted = await call('add_comment', { quote: 'Another anchorable', comment: 'Rescued.', accepted: true });
    assert.equal(posted.isError, false, posted.text);
  } finally {
    await client.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(existsSync(join(home, '.latex-preview')), false, 'nothing may be written into the cwd');
  assert.equal(existsSync(join(proj, '.latex-preview')), true, 'the store belongs to the paper');
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});
