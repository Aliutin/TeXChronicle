import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMainFile } from '../src/project/resolveMainFile.js';

test('an extensionless explicit main resolves to the real tex file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-main-name-'));
  try {
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n');
    writeFileSync(join(root, 'paper_20260818.tex'), '\\documentclass{article}\n');
    assert.equal(await resolveMainFile(root, 'paper_20260818'), 'paper_20260818.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extensionless explicit paths work in subdirectories too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-main-subdir-'));
  try {
    mkdirSync(join(root, 'drafts'));
    writeFileSync(join(root, 'drafts', 'paper.tex'), '\\documentclass{article}\n');
    assert.equal(await resolveMainFile(root, 'drafts/paper'), 'drafts/paper.tex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
