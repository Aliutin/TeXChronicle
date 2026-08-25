import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, createCheckpointFromPrepared, getCheckpointDiff, getWorkingDiff, listCheckpoints, matchingCheckpointSha, prepareCheckpoint, restoreCheckpoint } from '../src/git/checkpoints.js';
import { forgetHistoryRepo, historyRepo } from '../src/git/historyRepo.js';
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
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-sections-'));
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
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-render-'));
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, 'main.tex'), firstSource);
    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    assert.equal((await listCheckpoints(root))[0]?.hasPdf, false);
    const firstPdf = new Uint8Array(Buffer.from('%PDF-1.7\nfirst\n'));
    await saveRenderArtifact(root, checkpoint.sha!, firstPdf, { mainFile: 'main.tex', engine: 'xelatex', backend: 'wasm' });
    await saveRenderArtifact(root, checkpoint.sha!, new Uint8Array(Buffer.from('replacement')), { mainFile: 'main.tex', engine: 'xelatex', backend: 'wasm' });

    assert.equal((await listCheckpoints(root))[0]?.hasPdf, true,
      'whole-project history did not expose its stored PDF artifact');
    assert.equal((await readRenderArtifact(root, checkpoint.sha!))?.toString('utf8'), '%PDF-1.7\nfirst\n',
      'recompiling unchanged source does not replace its original exact render');
    assert.match(readFileSync(join(root, '.latex-preview', '.gitignore'), 'utf8'), /^renders\/$/m,
      'binary render artifacts cannot be swept into source Git history');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('project diffs ignore unavailable global PDF text converters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-safe-diff-'));
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, '.gitattributes'), '*.pdf diff=missing-pdf-helper\n');
    writeFileSync(join(root, 'main.tex'), 'Visible source text.\n');
    writeFileSync(join(root, 'figure.pdf'), Buffer.from('%PDF-1.7\nfixture\n'));

    const repo = await historyRepo(root);
    assert.equal(repo.mode, 'shadow', repo.detail);
    execFileSync('git', ['config', 'diff.missing-pdf-helper.textconv', 'texchronicle-helper-that-does-not-exist'], {
      cwd: root,
      env: { ...process.env, ...repo.env },
      stdio: 'pipe',
    });

    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    const initial = await getCheckpointDiff(root, checkpoint.sha!);
    assert.match(initial, /Visible source text/,
      'one unavailable binary text converter blanked the whole source diff');

    writeFileSync(join(root, 'main.tex'), 'Revised visible source text.\n');
    assert.match(await getWorkingDiff(root), /Revised visible source text/,
      'the working-tree diff still invoked the unavailable converter');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoints exclude build products but retain source PDF figures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-source-only-'));
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, 'main.tex'), 'Editable LaTeX source.\n');
    writeFileSync(join(root, 'main.aux'), 'generated aux\n');
    writeFileSync(join(root, 'main.log'), 'generated log\n');
    writeFileSync(join(root, 'main.synctex.gz'), 'generated synctex\n');
    writeFileSync(join(root, 'main.pdf'), Buffer.from('%PDF-1.7\ncompiled document\n'));
    writeFileSync(join(root, 'figure.pdf'), Buffer.from('%PDF-1.7\nsource figure\n'));
    mkdirSync(join(root, '__pycache__'));
    writeFileSync(join(root, '__pycache__', 'visuals.cpython-313.pyc'), 'generated bytecode');

    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    const repo = await historyRepo(root);
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', checkpoint.sha!], {
      cwd: root,
      env: { ...process.env, ...repo.env },
      stdio: 'pipe',
    }).toString().replace(/\r\n/g, '\n').split('\n').filter(Boolean);

    assert.ok(listed.includes('main.tex'));
    assert.ok(listed.includes('figure.pdf'), 'a genuine PDF figure was mistaken for compiled output');
    for (const generated of ['main.aux', 'main.log', 'main.synctex.gz', 'main.pdf', '__pycache__/visuals.cpython-313.pyc']) {
      assert.ok(!listed.includes(generated), `generated file was recorded in history: ${generated}`);
    }
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a PDF checkpoint is refused when source changes during compilation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-render-race-'));
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

test('checkpoint matching fails closed and includes git-ignored compiler inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-ignored-input-'));
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, '.gitignore'), 'generated.tex\nfigure.pdf\n');
    writeFileSync(join(root, 'main.tex'), '\\input{generated}\n');
    writeFileSync(join(root, 'generated.tex'), 'ORIGINAL GENERATED PROSE\n');
    writeFileSync(join(root, 'figure.pdf'), '%PDF-1.7 original figure\n');

    assert.deepEqual(await matchingCheckpointSha(root), { dirty: true, historyAvailable: true },
      'no successful checkpoint must never be treated as verified');
    const first = await createCheckpoint(root);
    assert.ok(first.sha);
    assert.deepEqual(await matchingCheckpointSha(root), { sha: first.sha, dirty: false, historyAvailable: true });

    writeFileSync(join(root, 'generated.tex'), 'CHANGED GENERATED PROSE\n');
    assert.equal((await matchingCheckpointSha(root)).dirty, true,
      'an ignored input changed the render without dirtying the checkpoint identity');
    await restoreCheckpoint(root, first.sha!);
    assert.equal(readFileSync(join(root, 'generated.tex'), 'utf8').replace(/\r\n/g, '\n'), 'ORIGINAL GENERATED PROSE\n',
      'the ignored compiler input was hashed but not recoverable');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore safety snapshots never impersonate successful renders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'latex-history-provenance-'));
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Rendered A\\end{document}\n');
    const rendered = await createCheckpoint(root);
    assert.ok(rendered.sha);

    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Unrendered B\\end{document}\n');
    await restoreCheckpoint(root, rendered.sha!);
    const safety = (await listCheckpoints(root))[0];
    assert.notEqual(safety.sha, rendered.sha, 'the changed pre-restore tree was not saved for recovery');

    await restoreCheckpoint(root, safety.sha);
    const current = await matchingCheckpointSha(root);
    assert.deepEqual(current, { dirty: true, historyAvailable: true },
      'restoring an unrendered safety snapshot incorrectly made it a successful checkpoint');
  } finally {
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic history follows the rendered main document and ignores old standalone drafts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-main-document-'));
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

test('semantic history works when the TeX project is nested inside a larger Git repository', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'texchronicle-nested-repo-'));
  const root = join(repository, 'paper', 'draft');
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    mkdirSync(root, { recursive: true });
    forgetHistoryRepo();
    forgetSectionGraph();
    writeFileSync(join(root, 'dated-paper.tex'), String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
Original nested-project prose.
\end{document}`);
    const first = await createCheckpoint(root);
    assert.ok(first.sha);
    await saveRenderArtifact(root, first.sha!, new Uint8Array(Buffer.from('%PDF-1.7\n')), {
      mainFile: 'dated-paper.tex', engine: 'pdflatex', backend: 'system',
    });

    writeFileSync(join(root, 'dated-paper.tex'), String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
Revised nested-project prose.
\end{document}`);
    const second = await createCheckpoint(root);
    assert.ok(second.sha);

    const history = await listSectionHistory(root);
    assert.equal(history.checkpointCount, 2);
    assert.deepEqual(history.sections.map((section) => section.title), ['Introduction']);
    assert.equal(history.sections[0].versions.length, 2);
    assert.equal(history.sections[0].versions[0].path, 'dated-paper.tex',
      'section paths remain relative to the TeX project, not its parent Git repository');
  } finally {
    forgetSectionGraph();
    forgetHistoryRepo();
    rmSync(repository, { recursive: true, force: true });
  }
});
