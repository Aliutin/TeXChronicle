// Which folder the MCP server treats as the project, and the guard that stops it
// writing into a directory that plainly is not a paper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertKnownProject, assertLooksLikeProject, initialProjectRoot } from '../src/projectRoot.js';
import { MainFileError } from '../src/project/resolveMainFile.js';

const scratch: string[] = [];
const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'projroot-'));
  scratch.push(made);
  return made;
};
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// ── initialProjectRoot ──────────────────────────────────────────────────────

test('cwd is the default project root, as it has always been', () => {
  assert.equal(initialProjectRoot(['node', 'server.js'], {}), resolve(process.cwd()));
});

test('TEXCHRONICLE_PROJECT overrides cwd', () => {
  const root = dir();
  assert.equal(initialProjectRoot(['node', 'server.js'], { TEXCHRONICLE_PROJECT: root }), resolve(root));
});

test('--project beats the environment variable', () => {
  const argvRoot = dir();
  const envRoot = dir();
  assert.equal(
    initialProjectRoot(['node', 'server.js', '--project', argvRoot], { TEXCHRONICLE_PROJECT: envRoot }),
    resolve(argvRoot),
  );
});

test('--project=<dir> is accepted too', () => {
  const root = dir();
  assert.equal(initialProjectRoot(['node', 'server.js', `--project=${root}`], {}), resolve(root));
});

test('the answer is always absolute', () => {
  const answer = initialProjectRoot(['node', 'server.js', '--project', 'papers/draft'], {});
  assert.equal(answer, resolve('papers/draft'));
});

test('a --project with no value falls through instead of swallowing the next flag', () => {
  // `--project --backend system` must not make "--backend" the project root.
  assert.equal(initialProjectRoot(['node', 'server.js', '--project', '--backend'], {}), resolve(process.cwd()));
});

test('an empty TEXCHRONICLE_PROJECT is ignored rather than resolving to cwd twice over', () => {
  assert.equal(initialProjectRoot(['node', 'server.js'], { TEXCHRONICLE_PROJECT: '   ' }), resolve(process.cwd()));
});

// ── assertLooksLikeProject ──────────────────────────────────────────────────

test('a top-level .tex file is enough', async () => {
  const root = dir();
  writeFileSync(join(root, 'paper.tex'), '\\documentclass{article}\n');
  await assertLooksLikeProject(root);
});

test('an explicit mainFile in a subdirectory passes even with no top-level .tex', async () => {
  const root = dir();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'main.tex'), '\\documentclass{article}\n');
  await assertLooksLikeProject(root, 'src/main.tex');
});

test('the `paper` → `paper.tex` shorthand resolveMainFile accepts is accepted here too', async () => {
  const root = dir();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'thesis.tex'), '\\documentclass{book}\n');
  // Without the shorthand this guard would reject a main file that compiles.
  await assertLooksLikeProject(root, 'src/thesis');
});

test('a home-shaped directory is refused', async () => {
  const root = dir();
  for (const name of ['Documents', 'Downloads', 'Pictures']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'notes.txt'), 'x');
  await assert.rejects(() => assertLooksLikeProject(root), MainFileError);
});

test('the refusal names the directory and all three ways to point at the paper', async () => {
  const root = dir();
  const error = await assertLooksLikeProject(root).then(() => null, (e: Error) => e);
  assert.ok(error, 'expected a refusal');
  const message = error.message;
  assert.ok(message.includes(root), 'the message must name the directory it refused');
  assert.match(message, /TEXCHRONICLE_PROJECT/);
  assert.match(message, /--project/);
  assert.match(message, /start the server from the paper's own folder/);
  // The hint resolveMainFile used to give, for the project whose sources are all
  // in a subdirectory — this guard now runs first, so it has to carry it.
  assert.match(message, /"mainFile"/);
});

test('a mainFile that does not exist does not rescue a non-project', async () => {
  const root = dir();
  await assert.rejects(() => assertLooksLikeProject(root, 'src/main.tex'), /does not look like a LaTeX project/);
});

test('an unreadable or missing directory is refused rather than thrown at raw', async () => {
  const root = join(dir(), 'never-created');
  await assert.rejects(() => assertLooksLikeProject(root), MainFileError);
});

// ── assertKnownProject (the read-only tools' looser check) ──────────────────

test('a directory TeXChronicle has previewed before is readable even with no top-level .tex', async () => {
  const root = dir();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'main.tex'), '\\documentclass{article}\n');
  mkdirSync(join(root, '.latex-preview'));
  await assertKnownProject(root); // the store is already there; reading it creates nothing
  // ...while the strict check still refuses it without an explicit main file.
  await assert.rejects(() => assertLooksLikeProject(root), MainFileError);
});

test('a home-shaped directory with no store is refused by the read-only check too', async () => {
  const root = dir();
  mkdirSync(join(root, 'Documents'));
  await assert.rejects(() => assertKnownProject(root), MainFileError);
});
