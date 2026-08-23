import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, createCheckpointFromPrepared, listCheckpoints, prepareCheckpoint } from '../src/git/checkpoints.js';
import { forgetHistoryRepo } from '../src/git/historyRepo.js';
import { forgetSectionGraph, getSectionDiff, listSectionHistory, restoreSection } from '../src/git/sectionHistory.js';
import { readRenderArtifact, saveRenderArtifact } from '../src/git/renderArtifacts.js';

const firstSource = String.raw`\begin{document}
\section{Introduction}
Original introduction.
\section{Results}
Original results.
\end{document}
`;

const secondSource = String.raw`\begin{document}
\section{Background}
Rewritten introduction.
\section{Results}
Current results that must survive a section restore.
\end{document}
`;

test('Git checkpoints are projected into section timelines and one section restores reversibly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magictex-sections-'));
  try {
    forgetHistoryRepo();
    forgetSectionGraph();
    writeFileSync(join(root, 'main.tex'), firstSource);
    const first = await createCheckpoint(root);
    assert.ok(first.sha);

    writeFileSync(join(root, 'main.tex'), secondSource);
    const second = await createCheckpoint(root);
    assert.ok(second.sha);

    const history = await listSectionHistory(root);
    const introduction = history.sections.find((section) => section.versions.at(-1)?.title === 'Introduction');
    assert.ok(introduction, 'the renamed Introduction kept its semantic identity');
    assert.equal(introduction.title, 'Background');
    assert.equal(introduction.versions.length, 2);

    const diff = await getSectionDiff(root, introduction.id, second.sha!, false);
    assert.match(diff.diff, /Original introduction/);
    assert.match(diff.diff, /Rewritten introduction/);
    assert.doesNotMatch(diff.diff, /Current results/, 'the section diff excludes other sections');

    await restoreSection(root, introduction.id, first.sha!);
    const restored = readFileSync(join(root, 'main.tex'), 'utf8');
    assert.match(restored, /\\section\{Introduction\}[\s\S]*Original introduction/);
    assert.match(restored, /Current results that must survive/,
      'restoring one semantic section leaves the rest of the file alone');
  } finally {
    forgetSectionGraph();
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an exact PDF artifact is stored once beside a reachable checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magictex-render-'));
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, 'main.tex'), firstSource);
    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    const firstPdf = new Uint8Array(Buffer.from('%PDF-1.7\nfirst\n'));
    await saveRenderArtifact(root, checkpoint.sha!, firstPdf, { mainFile: 'main.tex', engine: 'xelatex', backend: 'wasm' });
    await saveRenderArtifact(root, checkpoint.sha!, new Uint8Array(Buffer.from('replacement')), { mainFile: 'main.tex', engine: 'xelatex', backend: 'wasm' });

    assert.equal((await readRenderArtifact(root, checkpoint.sha!))?.toString('utf8'), '%PDF-1.7\nfirst\n',
      'recompiling unchanged source does not replace its original exact render');
    assert.match(readFileSync(join(root, '.latex-preview', '.gitignore'), 'utf8'), /^renders\/$/m,
      'binary render artifacts cannot be swept into source Git history');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a PDF checkpoint is refused when source changes during compilation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magictex-render-race-'));
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, 'main.tex'), firstSource);
    const prepared = await prepareCheckpoint(root);
    assert.ok(prepared.tree);

    writeFileSync(join(root, 'main.tex'), secondSource);
    const stale = await createCheckpointFromPrepared(root, prepared.tree!);
    assert.equal(stale.reason, 'changed-during-compile');
    assert.equal((await listCheckpoints(root)).length, 0,
      'a render must not be attached to source it did not compile');

    const current = await prepareCheckpoint(root);
    assert.ok(current.tree);
    const saved = await createCheckpointFromPrepared(root, current.tree!);
    assert.ok(saved.sha);
    assert.equal((await listCheckpoints(root)).length, 1);
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic history follows the rendered main document and ignores old standalone drafts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magictex-main-document-'));
  try {
    forgetHistoryRepo();
    forgetSectionGraph();
    writeFileSync(join(root, 'paper.tex'), String.raw`\documentclass{article}
\begin{document}
\input{z-introduction}
\input{a-results}
\end{document}`);
    writeFileSync(join(root, 'z-introduction.tex'), String.raw`\section{Introduction}
Current introduction.`);
    writeFileSync(join(root, 'a-results.tex'), String.raw`\section{Results}
Current results.`);
    writeFileSync(join(root, 'old-draft.tex'), String.raw`\documentclass{article}
\begin{document}
\section{Obsolete duplicate}
Old text.
\end{document}`);

    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    const beforeMetadata = await listSectionHistory(root);
    assert.ok(beforeMetadata.sections.some((section) => section.title === 'Obsolete duplicate'),
      'without a recorded main file, history does not guess among standalone documents');
    await saveRenderArtifact(root, checkpoint.sha!, new Uint8Array(Buffer.from('%PDF-1.7\n')), {
      mainFile: 'paper.tex', engine: 'xelatex', backend: 'wasm',
    });

    const history = await listSectionHistory(root);
    assert.deepEqual(history.sections.map((section) => section.title), ['Introduction', 'Results']);
    assert.ok(history.sections[0].order < history.sections[1].order,
      'input order, not alphabetical filename order, determines the section tree');
  } finally {
    forgetSectionGraph();
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
