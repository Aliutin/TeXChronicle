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

/** Inherit the environment, then let `extraEnv` REPLACE a variable rather than
 *  sit beside it. A plain spread is wrong on Windows: the inherited name is
 *  `Path`, so overriding `PATH` would leave both keys in the object and the
 *  child would take whichever it liked — which is precisely the variable the
 *  no-git test below depends on. */
const envWith = (extraEnv: Record<string, string>): Record<string, string> => {
  const clashes = (key: string) => Object.keys(extraEnv).some((k) => k.toLowerCase() === key.toLowerCase());
  const merged = Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !clashes(key)));
  // Never pop a browser tab out of a test run.
  return { ...merged, TEXCHRONICLE_NO_OPEN: '1', ...extraEnv };
};

const connect = async (cwd: string, args: string[] = [], extraEnv: Record<string, string> = {}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, ...args],
    cwd,
    env: envWith(extraEnv),
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

// The third way to point at the paper, and the only one the agent holding the
// tools can apply on its own: --project and $TEXCHRONICLE_PROJECT both need the
// human to edit the client's config and restart it, which is a dead end in the
// middle of a conversation. Unlike the tests above this one really compiles, so
// it starts Chromium and the WASM engine — the claim is that the parameter
// re-points the WHOLE session, and only a real render proves the watcher and the
// history store moved with it.
test('render_preview projectRoot re-points a server started in the wrong folder, and sticks', { timeout: 180_000 }, async () => {
  const home = fakeHome();
  const proj = mkdtempSync(join(tmpdir(), 'e2e-param-'));
  writeFileSync(join(proj, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nA parameter-rescued sentence.\n\\end{document}\n');
  const { client, call } = await connect(home);
  try {
    // Fail closed first: a mistyped path is refused, and must not become the
    // session's root on its way out. Everything after this would still pass if
    // it had, so it is checked before the good one is ever offered.
    const bad = await call('render_preview', { projectRoot: join(proj, 'no-such-folder') });
    assert.equal(bad.isError, true, bad.text);
    assert.match(bad.text, /does not look like a LaTeX project/);

    const rendered = await call('render_preview', { projectRoot: proj });
    // A compile can legitimately fail here (no TeX assets on the machine, a
    // missing package). What it may never do is refuse the folder.
    assert.doesNotMatch(rendered.text, /does not look like a LaTeX project/, rendered.text);

    // Sticky: a later tool that takes no root of its own must use the new one.
    const posted = await call('add_comment', { quote: 'A parameter-rescued sentence', comment: 'Rescued by parameter.', accepted: true });
    assert.equal(posted.isError, false, posted.text);
    const checked = await call('check_comments');
    assert.match(checked.text, /main\.tex:3/, 'the anchor must be found in the paper, not the cwd');
  } finally {
    await client.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(existsSync(join(home, '.latex-preview')), false, 'nothing may be written into the cwd');
  assert.equal(existsSync(join(proj, '.latex-preview')), true, 'the store belongs to the folder the parameter named');
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

// Resolution is a provenance claim, so it is gated on the source matching the
// latest successful checkpoint. With no git there is no checkpoint and never
// will be, so the gate could not open no matter what the author did: every
// resolve_comment answered "not the latest successful checkpoint", forever, and
// the review loop was simply unusable on that machine. The claim is what has to
// go — not the resolution.
test('a machine with no git resolves the comment anyway, and says it is unlinked', { timeout: 60_000 }, async () => {
  const proj = mkdtempSync(join(tmpdir(), 'e2e-nogit-'));
  writeFileSync(join(proj, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nA sentence with no version to link to.\n\\end{document}\n');
  // An empty directory as the entire PATH: no `git` anywhere the child can find
  // one. process.execPath is absolute, so spawning the server itself is safe.
  const noPath = mkdtempSync(join(tmpdir(), 'e2e-nopath-'));
  const { client, call } = await connect(proj, [], { PATH: noPath });
  try {
    const checkpoints = await call('list_checkpoints');
    assert.match(checkpoints.text, /History needs git/, 'the fixture must really look like a machine without git');

    const posted = await call('add_comment', { quote: 'A sentence with no version', comment: 'Reword it.', accepted: true });
    assert.equal(posted.isError, false, posted.text);
    const id = posted.text.match(/comment ([0-9a-f]{6,})/)?.[1];
    assert.ok(id, posted.text);

    const resolved = await call('resolve_comment', { id, note: 'reworded' });
    assert.equal(resolved.isError, false, resolved.text);
    assert.match(resolved.text, /Resolved comment/);
    assert.match(resolved.text, /History is off on this machine/);

    const checked = await call('check_comments', { includeResolved: true });
    assert.match(checked.text, /No accepted comments/);
    // Resolved, but with no version attached: the card must not carry a
    // provenance line it cannot back up.
    assert.doesNotMatch(checked.text, /resolved at [0-9a-f]/);
  } finally {
    await client.close();
  }
  rmSync(proj, { recursive: true, force: true });
  rmSync(noPath, { recursive: true, force: true });
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
