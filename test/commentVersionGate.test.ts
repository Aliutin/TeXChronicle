import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint } from '../src/git/checkpoints.js';
import { forgetHistoryRepo } from '../src/git/historyRepo.js';
import { addComment, listComments, markCommentsForRestoreReview, updateComment } from '../src/preview/commentsStore.js';
import { finishRestore, pendingRestoreCompile, startPreviewServer } from '../src/preview/previewServer.js';
import { setProjectRoot } from '../src/session.js';

test('restore comment verification requires the exact clean PDF checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-comment-version-'));
  let preview: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
  try {
    forgetHistoryRepo();
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Text\\end{document}\n');
    const checkpoint = await createCheckpoint(root);
    assert.ok(checkpoint.sha);
    const comment = await addComment(root, { page: 1, quote: 'Text', rects: [], text: 'check it' });
    await updateComment(root, comment.id, { status: 'resolved', resolvedCheckpoint: checkpoint.sha });
    await markCommentsForRestoreReview(root, [comment.id], {
      checkpoint: checkpoint.sha!, scope: 'project', at: new Date().toISOString(),
    });

    setProjectRoot(root);
    preview = await startPreviewServer();
    const patch = () => fetch(`${preview!.url}/api/comments?id=${comment.id}`, {
      method: 'PATCH', headers: {
        'Content-Type': 'application/json', Origin: preview!.url, 'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ restoreReview: null }),
    });

    const refused = await patch();
    assert.equal(refused.status, 409,
      'an idle/stale PDF was allowed to clear the restore warning');
    // The old message said "wait for a successful recompile". After a plain
    // editor autosave nothing is coming: /api/file suppresses the watcher for
    // its own write, so no compile is pending and this state never resolves on
    // its own. People sat watching for a spinner that did not exist. The
    // message has to name the action that clears it.
    const reason = await refused.text();
    assert.doesNotMatch(reason, /\bWait\b/i, 'the refusal still tells the reader to wait for something');
    assert.match(reason, /has not been rendered since it was last saved/);
    assert.match(reason, /Recompile/);
    assert.match(reason, /render_preview/, 'an agent needs to be told its own way out too');
    await preview.setLatestPdf(new Uint8Array(Buffer.from('%PDF-1.7\n')), 'main.tex', undefined, checkpoint.sha);
    assert.equal((await patch()).status, 200);
    const verified = (await listComments(root))[0];
    assert.equal(verified.restoreReview, undefined);
    assert.equal(verified.verifiedCheckpoint, checkpoint.sha);
  } finally {
    await preview?.close();
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});

test('comment bookkeeping failure never prevents the post-restore compile attempt', async () => {
  let compiled = 0;
  const result = await finishRestore('unused', 'a'.repeat(40), 'project', undefined, undefined, {
    flag: async () => { throw new Error('comments.json is malformed'); },
    compile: async () => { compiled++; return { success: true, verdict: { errors: [] } }; },
  });
  assert.equal(result.compiling, true);
  assert.match(result.warning ?? '', /comments\.json is malformed/);
  // Started, not awaited — see the detached-compile test below.
  await pendingRestoreCompile;
  assert.equal(compiled, 1);
});

// A restore used to await the entire recompile inside the HTTP handler. On a
// real paper with the system TeX backend that is minutes, so the browser's
// fetch gave up first and reported a restore that had in fact succeeded as
// failed — while the compile it was waiting for carried on in the background.
test('a restore answers before its recompile finishes', async () => {
  let release = () => {};
  const finished = new Promise<void>((resolve) => { release = resolve; });
  let started = false;

  const began = Date.now();
  const result = await finishRestore('unused', 'a'.repeat(40), 'project', undefined, undefined, {
    flag: async () => 0,
    compile: async () => {
      started = true;
      await finished;
      return { success: true, verdict: { errors: [] } };
    },
  });
  const took = Date.now() - began;

  assert.ok(took < 500, `finishRestore waited ${took}ms for a compile that had not finished`);
  assert.equal(result.compiling, true);
  assert.equal(started, true, 'the recompile was never started');
  // `compiled` must be absent rather than false: the workspace reads a false
  // there as "the restored source did not compile", which would now be shown
  // after every single restore.
  assert.equal((result as { compiled?: boolean }).compiled, undefined);
  release();
  await pendingRestoreCompile;
});

// The coordinator broadcasts its own compile-error when a compile RUNS and
// fails. A compile that never got that far — the engine failing to start — used
// to be reported by finishRestore's own return value, which nothing waits for
// any more. Without this the workspace would sit on 'compiling' forever.
test('a recompile that cannot run at all is still broadcast', async () => {
  const seen: Array<{ type: string; log: string }> = [];
  await finishRestore('unused', 'a'.repeat(40), 'project', undefined, undefined, {
    flag: async () => 0,
    compile: async () => { throw new Error('headless browser did not start'); },
    notify: (message) => seen.push(message),
  });
  await pendingRestoreCompile;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'compile-error');
  assert.match(seen[0].log, /headless browser did not start/);
});

// With no history store there is no checkpoint to stamp and no version claim to
// check — and every clause of the gate is unsatisfiable, so a project without
// git could never resolve a comment at all. The refusal even told the author to
// recompile, which would not have helped.
test('resolving is allowed, unstamped, when the project has no history store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-no-history-'));
  const path = process.env.PATH;
  let preview: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
  try {
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Text\\end{document}\n');
    const comment = await addComment(root, { page: 1, quote: 'Text', rects: [], text: 'check it' });

    setProjectRoot(root);
    preview = await startPreviewServer();
    // No git binary on PATH is the honest way to reach historyAvailable:false;
    // forgetHistoryRepo() also clears the memo that says one was found.
    process.env.PATH = '';
    forgetHistoryRepo();

    const response = await fetch(`${preview.url}/api/comments?id=${comment.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: preview.url, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    assert.equal(response.status, 200, 'a project without git could not resolve a comment at all');
    const updated = await response.json() as { status: string; resolvedCheckpoint?: string; note?: string };
    assert.equal(updated.status, 'resolved');
    assert.equal(updated.resolvedCheckpoint, undefined, 'a version was claimed that nothing could prove');
    assert.match(updated.note ?? '', /without a version stamp/);
  } finally {
    process.env.PATH = path;
    await preview?.close();
    forgetHistoryRepo();
    rmSync(root, { recursive: true, force: true });
  }
});
