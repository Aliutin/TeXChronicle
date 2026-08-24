import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  listRecentProjects,
  MAX_RECENT_PROJECTS,
  recentProjectsPath,
  rememberRecentProject,
} from '../src/recentProjects.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'magictex-recents-'));

test('recent-project storage follows each operating system convention', () => {
  assert.equal(
    recentProjectsPath('win32', { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' }, 'C:\\Users\\Ada'),
    join('C:\\Users\\Ada\\AppData\\Roaming', 'MagicTeX', 'recent-projects.json'),
  );
  assert.equal(
    recentProjectsPath('darwin', {}, '/Users/ada'),
    join('/Users/ada', 'Library', 'Application Support', 'MagicTeX', 'recent-projects.json'),
  );
  assert.equal(
    recentProjectsPath('linux', { XDG_CONFIG_HOME: '/config' }, '/home/ada'),
    join('/config', 'magictex', 'recent-projects.json'),
  );
});

test('opening a project remembers it and opening it again moves it to the front', async () => {
  const d = tmp();
  const store = join(d, 'config', 'recent-projects.json');
  try {
    const first = resolve(d, 'paper-one');
    const second = resolve(d, 'paper-two');
    await rememberRecentProject(first, 'main.tex', store);
    await rememberRecentProject(second, 'draft.tex', store);
    await rememberRecentProject(first, 'main.tex', store);
    const recents = await listRecentProjects(store);
    assert.equal(recents.length, 2);
    assert.equal(recents[0].projectRoot, first);
    assert.equal(recents[0].mainFile, 'main.tex');
    assert.equal(recents[1].projectRoot, second);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the recent list stays bounded and refuses paths outside the project', async () => {
  const d = tmp();
  const store = join(d, 'recent-projects.json');
  try {
    for (let i = 0; i < MAX_RECENT_PROJECTS + 4; i++) {
      await rememberRecentProject(resolve(d, `paper-${i}`), 'main.tex', store);
    }
    assert.equal((await listRecentProjects(store)).length, MAX_RECENT_PROJECTS);
    await assert.rejects(
      () => rememberRecentProject(resolve(d, 'paper'), '../other/main.tex', store),
      /outside its project root/,
    );
  } finally { rmSync(d, { recursive: true, force: true }); }
});
