// A project that is NOT a git repository must still get history — and must get
// it without anything appearing in the author's folder.
//
// This drives the real server over MCP, compiles twice with an edit in between,
// and reads the checkpoints back through the same endpoint the History panel
// uses. The interesting assertions are the last two: the project directory has
// no .git, and the author's own `git` still reports no repository there.
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pexec = promisify(execFile);
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPILE_TIMEOUT_MS = 15 * 60 * 1000;
const NODE_ARGS = ['--import', pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(REPO, 'src', 'server.ts')];

const doc = (body) => [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  body,
  String.raw`\end{document}`,
  '',
].join('\n');

const proj = mkdtempSync(join(tmpdir(), 'texchronicle-nogit-'));
const tex = join(proj, 'main.tex');
writeFileSync(tex, doc('First version.'));

const transport = new StdioClientTransport({ command: process.execPath, args: NODE_ARGS, cwd: proj });
const client = new Client({ name: 'smoke-history', version: '0' }, { capabilities: {} });
await client.connect(transport);

let base = null;
const render = async (label) => {
  const r = await client.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: COMPILE_TIMEOUT_MS });
  const out = r.content.map((c) => c.text ?? '').join('\n');
  base ??= out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  console.log(`${label.padEnd(28)} ${out.split('\n')[0].slice(0, 64)}`);
  return out;
};

const out1 = await render('1 first compile');
writeFileSync(tex, doc('Second version, edited.'));
await render('2 after an edit');

const status = await (await fetch(`${base}/git/status`)).json();
const checkpoints = await (await fetch(`${base}/git/checkpoints`)).json();

let authorSees = 'not a repo';
try { authorSees = (await pexec('git', ['rev-parse', '--git-dir'], { cwd: proj })).stdout.trim(); } catch { /* expected */ }

const checks = [
  ['history is available in a non-git project', status.isRepo === true],
  ['it is tracked in a shadow repo, not the project', status.mode === 'shadow'],
  ['two edits produced two checkpoints', Array.isArray(checkpoints) && checkpoints.length === 2],
  ['nothing was created in the project directory', !existsSync(join(proj, '.git'))],
  ["the author's own git still sees no repository", authorSees === 'not a repo'],
];

console.log('');
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`\nproject contains: ${readdirSync(proj).join(', ')}`);
console.log(`status: ${JSON.stringify(status)} · checkpoints: ${Array.isArray(checkpoints) ? checkpoints.length : checkpoints}`);

await client.close();

// ── Phase 2: a project that IS a git repo must be unchanged ────────────────
// Every git call site was rewritten to thread a per-project environment, so the
// path that already worked needs proving too — a fix for the missing case that
// broke the working one would be a poor trade.
const repo = mkdtempSync(join(tmpdir(), 'texchronicle-gitrepo-'));
await pexec('git', ['init', '--quiet'], { cwd: repo });
await pexec('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
await pexec('git', ['config', 'user.name', 'Test'], { cwd: repo });
writeFileSync(join(repo, 'main.tex'), doc('Repo version one.'));

const t2 = new StdioClientTransport({ command: process.execPath, args: NODE_ARGS, cwd: repo });
const c2 = new Client({ name: 'smoke-history-repo', version: '0' }, { capabilities: {} });
await c2.connect(t2);
let base2 = null;
for (const [i, body] of [['3 git repo, first compile', 'Repo version one.'], ['4 git repo, after an edit', 'Repo version two.']]) {
  writeFileSync(join(repo, 'main.tex'), doc(body));
  const r = await c2.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: COMPILE_TIMEOUT_MS });
  const out = r.content.map((c) => c.text ?? '').join('\n');
  base2 ??= out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  console.log(`${i.padEnd(28)} ${out.split('\n')[0].slice(0, 64)}`);
}
const status2 = await (await fetch(`${base2}/git/status`)).json();
const cps2 = await (await fetch(`${base2}/git/checkpoints`)).json();
// Checkpoints live on a hidden ref; the author's own log must stay empty.
let authorLog = '';
try { authorLog = (await pexec('git', ['log', '--oneline'], { cwd: repo })).stdout.trim(); } catch { /* no commits yet — expected */ }
const hiddenRef = (await pexec('git', ['rev-parse', '--verify', '-q', 'refs/latex-preview/checkpoints'], { cwd: repo }).catch(() => ({ stdout: '' }))).stdout.trim();

checks.push(
  ['a real git repo still tracks history', status2.isRepo === true],
  ['it uses the project repo, not a shadow', status2.mode === 'project'],
  ['checkpoints were recorded there', Array.isArray(cps2) && cps2.length >= 1],
  ['they live on the hidden ref', /^[0-9a-f]{40}$/.test(hiddenRef)],
  ["the author's own git log stays empty", authorLog === ''],
);
await c2.close();

console.log('');
for (const [name, ok] of checks.slice(5)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`status: ${JSON.stringify(status2)} · checkpoints: ${Array.isArray(cps2) ? cps2.length : cps2} · author log: ${authorLog === '' ? '(empty)' : authorLog}`);


// ── Phase 3: the no-git note is said once, and only when it's true ──────────
// Verified by running the server with git stripped from PATH. The "once" part
// matters as much as the message: repeated every compile it becomes noise, and
// noise is what teaches people to skim past the notes that do matter.
const gitless = mkdtempSync(join(tmpdir(), 'texchronicle-gitless-'));
writeFileSync(join(gitless, 'main.tex'), doc('No git here.'));
// Hide git without dismantling the machine. Filtering it out of PATH works on
// Windows but is fatal on macOS, where git lives in /usr/bin alongside
// everything the server needs — the first compile survived on the runner and
// the process died before the second. A shim that fails is surgical: only git
// is affected, every other tool stays exactly where it was.
function gitlessEnv() {
  if (process.platform === 'win32') {
    const keep = (process.env.PATH ?? '').split(';').filter((p) => p && !/git|mingw/i.test(p));
    return { ...process.env, PATH: keep.join(';'), Path: keep.join(';') };
  }
  const shim = mkdtempSync(join(tmpdir(), 'texchronicle-nogit-shim-'));
  writeFileSync(join(shim, 'git'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  return { ...process.env, PATH: `${shim}:${process.env.PATH ?? ''}` };
}
const strippedEnv = gitlessEnv();

const t3 = new StdioClientTransport({
  command: process.execPath,
  args: NODE_ARGS,
  cwd: gitless, env: strippedEnv, stderr: 'ignore',
});
const c3 = new Client({ name: 'smoke-history-nogit', version: '0' }, { capabilities: {} });
await c3.connect(t3);
const outs = [];
for (const label of ['5 no git, first compile', '6 no git, second compile']) {
  writeFileSync(join(gitless, 'main.tex'), doc(`No git here. ${label}`));
  const r = await c3.callTool({ name: 'render_preview', arguments: { backend: 'wasm' } }, undefined, { timeout: COMPILE_TIMEOUT_MS });
  const out = r.content.map((c) => c.text ?? '').join('\n');
  outs.push({ out, isError: !!r.isError });
  console.log(`${label.padEnd(28)} ${out.split('\n')[0].slice(0, 64)}`);
}
await c3.close();

const mentions = (s) => /Change history is off/.test(s);
checks.push(
  ['a compile without git still succeeds', /^✓ Compiled/.test(outs[0].out) && !outs[0].isError],
  ['the first compile says history is off', mentions(outs[0].out)],
  ['it names git and where to get it', /git-scm\.com/.test(outs[0].out)],
  ['it says no account or remote is involved', /no account or remote/.test(outs[0].out)],
  ['the second compile does NOT repeat it', !mentions(outs[1].out)],
  // Phase 1 had git. If the note appeared there it would be a plain lie, and
  // this is the only check that can catch it — the first draft asserted against
  // an emptied string, which passes no matter what the code does.
  ['a project WITH git is never told this', !mentions(out1)],
);

console.log('');
for (const [name, ok] of checks.slice(10)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed3 = checks.filter(([, ok]) => !ok);
console.log(failed3.length ? `\nSMOKE FAIL: ${failed3.length}` : '\nSMOKE PASS');
process.exit(failed3.length ? 1 : 0);
