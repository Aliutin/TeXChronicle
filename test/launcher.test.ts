import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonicalizeLaunchTarget, inferLaunchTarget, pickerPlans, recentProjectsPickerPlan, resolveLaunchTarget } from '../src/launcher.js';
import { windowsLauncherPlan } from '../src/installLauncher.js';

const run = promisify(execFile);

test('an absolute dropped tex file makes its own directory the project root', () => {
  const file = resolve('launcher-fixtures/papers/study/main.tex');
  const target = resolveLaunchTarget(resolve('launcher-fixtures/unrelated'), undefined, file);
  assert.equal(target.projectRoot, resolve('launcher-fixtures/papers/study'));
  assert.equal(target.mainFile, 'main.tex');
});

test('an explicit project keeps a nested main file relative to that root', () => {
  const root = resolve('launcher-fixtures/papers/study');
  const target = resolveLaunchTarget(resolve('launcher-fixtures/unrelated'), root, resolve(root, 'draft/main.tex'));
  assert.equal(target.projectRoot, root);
  assert.equal(target.mainFile, 'draft/main.tex');
});

// The function takes a cwd because the caller's directory and the process's can
// differ — the desktop picker passes the folder it was opened in. A relative
// --project used to ignore that argument and resolve against process.cwd(), so
// `texchronicle preview -p . main.tex` run from the paper landed on whatever
// directory the process had been started in.
test('a relative --project resolves against the caller cwd, not the process cwd', () => {
  const cwd = resolve('launcher-fixtures/papers/study');
  const target = resolveLaunchTarget(cwd, '.', 'draft/main.tex');
  assert.equal(target.projectRoot, cwd);
  assert.equal(target.mainFile, 'draft/main.tex');
  assert.notEqual(target.projectRoot, resolve('.'), 'process.cwd() must not leak in');
});

test('a relative --project pointing at a sibling resolves under the caller cwd', () => {
  const cwd = resolve('launcher-fixtures/papers');
  const target = resolveLaunchTarget(cwd, 'study', 'main.tex');
  assert.equal(target.projectRoot, resolve('launcher-fixtures/papers/study'));
  assert.equal(target.mainFile, 'main.tex');
});

test('an absolute --project is still taken as given', () => {
  const root = resolve('launcher-fixtures/papers/study');
  const target = resolveLaunchTarget(resolve('launcher-fixtures/unrelated'), root, 'main.tex');
  assert.equal(target.projectRoot, root);
});

test('a main file outside an explicit project is rejected', () => {
  assert.throws(
    () => resolveLaunchTarget(resolve('launcher-fixtures/x'), resolve('launcher-fixtures/papers/a'), resolve('launcher-fixtures/papers/b/main.tex')),
    /inside the project root/,
  );
});

test('Windows picker passes the initial directory through the environment, not shell quoting', () => {
  const initial = resolve('C:/Users/A Person/My Papers');
  const [plan] = pickerPlans('win32', initial);
  assert.equal(plan.env?.TEXCHRONICLE_PICKER_DIR, initial);
  assert.equal(plan.windowsHide, false, 'the interactive WinForms picker would be created but invisible');
  assert.ok(plan.args.includes('-STA'));
  assert.doesNotMatch(plan.args.join(' '), /A Person[\\/]My/);
});

test('desktop shortcut uses a durable shim with the exact install as an offline fallback', () => {
  const plan = windowsLauncherPlan('C:\\Program Files\\nodejs\\node.exe', 'C:\\TeX Chronicle\\bin\\cli.mjs');
  assert.equal(plan.env.TEXCHRONICLE_NODE, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(plan.env.TEXCHRONICLE_CLI, 'C:\\TeX Chronicle\\bin\\cli.mjs');
  assert.match(plan.args.at(-1) ?? '', /CreateShortcut/);
  assert.match(plan.args.at(-1) ?? '', /open --desktop/);
  assert.match(plan.args.at(-1) ?? '', /launch\.cmd/);
  assert.match(plan.args.at(-1) ?? '', /where texchronicle/);
  assert.match(plan.args.at(-1) ?? '', /WindowStyle = 7/);
  assert.match(plan.args.at(-1) ?? '', /Startup failed with exit code/);
});

// The script runs under $ErrorActionPreference='Stop', where Join-Path on an
// unset variable is not an empty string but a thrown
// ParameterBindingValidationException — so on an account without LOCALAPPDATA
// (a scheduled task, a service account, a stripped-down shell) the installer
// died on its first line having created nothing. `??` would be the obvious
// guard and is a syntax error here: the plan targets WindowsPowerShell\v1.0,
// which is 5.1.
test('the shortcut installer survives an environment without LOCALAPPDATA', () => {
  const script = windowsLauncherPlan().args.at(-1) ?? '';
  assert.doesNotMatch(script, /Join-Path \$env:LOCALAPPDATA/,
    'the unguarded form throws before anything is created');
  // An `if`, not `??` — PowerShell 5.1 has no null-coalescing operator, and the
  // whole script would then fail to parse rather than merely fail to run.
  assert.match(script, /if \(-not \$localAppData\)/);
  assert.match(script, /\$env:USERPROFILE/);
});

test('Windows recent-project chooser reads its index through the environment', () => {
  const recents = resolve('C:/Users/A Person/App Data/TeXChronicle/recent-projects.json');
  const plan = recentProjectsPickerPlan(resolve('C:/Users/A Person/Documents'), recents);
  assert.equal(plan.env?.TEXCHRONICLE_RECENTS_FILE, recents);
  assert.equal(plan.windowsHide, false, 'the Recent Projects form would inherit a hidden startup window');
  assert.doesNotMatch(plan.args.join(' '), /A Person/);
  assert.match(plan.args.at(-1) ?? '', /Recent projects/);
  assert.match(plan.args.at(-1) ?? '', /DoubleClick/);
  assert.match(plan.args.at(-1) ?? '', /Browse/);
  assert.match(plan.args.at(-1) ?? '', /Get-Content -Raw -Encoding UTF8/);
  assert.match(plan.args.at(-1) ?? '', /OpenStandardOutput/);
  assert.match(plan.args.at(-1) ?? '', /TopMost = \$true/);
});

test('browsing to a nested main file reuses the marked project root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-launch-root-'));
  try {
    mkdirSync(join(root, '.latex-preview'));
    mkdirSync(join(root, 'src'));
    const main = join(root, 'src', 'main.tex');
    writeFileSync(main, '\\documentclass{article}\n');
    const target = await inferLaunchTarget(tmpdir(), main);
    assert.equal(target.projectRoot, root);
    assert.equal(target.mainFile, 'src/main.tex');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canonical launch keeps extensionless main-file shorthand', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-launch-extensionless-'));
  try {
    writeFileSync(join(root, 'paper.tex'), '\\documentclass{article}\n');
    const target = await canonicalizeLaunchTarget({ projectRoot: root, mainFile: 'paper' });
    assert.equal(target.mainFile, 'paper.tex');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canonical launch containment rejects a junction escaping the project', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'texchronicle-launch-link-'));
  const root = join(base, 'paper');
  const outside = join(base, 'outside');
  try {
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'main.tex'), '\\documentclass{article}\n');
    try { symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { t.skip(`cannot create a directory link on this machine: ${(error as Error).message}`); return; }
    await assert.rejects(
      () => canonicalizeLaunchTarget({ projectRoot: root, mainFile: 'linked/main.tex' }),
      /real project root/,
    );
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Windows can construct and close the real Recent Projects window', { skip: process.platform !== 'win32' }, async () => {
  const plan = recentProjectsPickerPlan(process.cwd(), resolve('missing-recents.json'));
  const { stdout } = await run(plan.command, plan.args, {
    cwd: tmpdir(),
    env: { ...plan.env, TEXCHRONICLE_PICKER_AUTOCLOSE: '1' },
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(stdout, '');
});
