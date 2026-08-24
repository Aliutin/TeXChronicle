import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pickerPlans, recentProjectsPickerPlan, resolveLaunchTarget } from '../src/launcher.js';
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

test('a main file outside an explicit project is rejected', () => {
  assert.throws(
    () => resolveLaunchTarget(resolve('launcher-fixtures/x'), resolve('launcher-fixtures/papers/a'), resolve('launcher-fixtures/papers/b/main.tex')),
    /inside the project root/,
  );
});

test('Windows picker passes the initial directory through the environment, not shell quoting', () => {
  const initial = resolve('C:/Users/A Person/My Papers');
  const [plan] = pickerPlans('win32', initial);
  assert.equal(plan.env?.MAGICTEX_PICKER_DIR, initial);
  assert.ok(plan.args.includes('-STA'));
  assert.doesNotMatch(plan.args.join(' '), /A Person[\\/]My/);
});

test('desktop shortcut launches this exact Node and CLI without PATH lookup', () => {
  const plan = windowsLauncherPlan('C:\\Program Files\\nodejs\\node.exe', 'C:\\Magic TeX\\bin\\cli.mjs');
  assert.equal(plan.env.MAGICTEX_NODE, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(plan.env.MAGICTEX_CLI, 'C:\\Magic TeX\\bin\\cli.mjs');
  assert.match(plan.args.at(-1) ?? '', /CreateShortcut/);
  assert.match(plan.args.at(-1) ?? '', /open --desktop/);
});

test('Windows recent-project chooser reads its index through the environment', () => {
  const recents = resolve('C:/Users/A Person/App Data/MagicTeX/recent-projects.json');
  const plan = recentProjectsPickerPlan(resolve('C:/Users/A Person/Documents'), recents);
  assert.equal(plan.env?.MAGICTEX_RECENTS_FILE, recents);
  assert.doesNotMatch(plan.args.join(' '), /A Person/);
  assert.match(plan.args.at(-1) ?? '', /Recent projects/);
  assert.match(plan.args.at(-1) ?? '', /DoubleClick/);
  assert.match(plan.args.at(-1) ?? '', /Browse/);
});

test('Windows can construct and close the real Recent Projects window', { skip: process.platform !== 'win32' }, async () => {
  const plan = recentProjectsPickerPlan(process.cwd(), resolve('missing-recents.json'));
  const { stdout } = await run(plan.command, plan.args, {
    env: { ...plan.env, MAGICTEX_PICKER_AUTOCLOSE: '1' },
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(stdout, '');
});
