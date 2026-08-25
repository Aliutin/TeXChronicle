import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint } from '../src/git/checkpoints.js';
import { forgetHistoryRepo } from '../src/git/historyRepo.js';
import { addComment, listComments, markCommentsForRestoreReview, updateComment } from '../src/preview/commentsStore.js';
import { finishRestore, startPreviewServer } from '../src/preview/previewServer.js';
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
  assert.equal(compiled, 1);
  assert.equal(result.compiled, true);
  assert.match(result.warning ?? '', /comments\.json is malformed/);
});
