import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addComment, listComments, updateComment, addReply, deleteComment, markCommentsForRestoreReview } from '../src/preview/commentsStore.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cs-'));

test('addComment defaults to human + accepted', async () => {
  const d = tmp();
  try {
    const c = await addComment(d, { page: 1, quote: 'x', rects: [], text: 'do it' });
    assert.equal(c.status, 'accepted');
    assert.equal(c.role, 'human');
    assert.equal((await listComments(d)).length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('reviewer suggestion → accept → resolve', async () => {
  const d = tmp();
  try {
    const c = await addComment(d, { page: 1, quote: 'q', rects: [], text: 'fix', role: 'reviewer', status: 'suggested' });
    assert.equal(c.status, 'suggested');
    await updateComment(d, c.id, { status: 'accepted' });
    assert.equal((await listComments(d))[0].status, 'accepted');
    await updateComment(d, c.id, { status: 'resolved', resolvedNote: 'done' });
    const done = (await listComments(d))[0];
    assert.equal(done.status, 'resolved');
    assert.equal(done.resolvedNote, 'done');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('comment creation and resolution retain their successful checkpoints', async () => {
  const d = tmp();
  try {
    const c = await addComment(d, {
      page: 1, quote: 'q', rects: [], text: 'fix', createdCheckpoint: 'a'.repeat(40),
    });
    await updateComment(d, c.id, {
      status: 'resolved', resolvedNote: 'done', resolvedCheckpoint: 'b'.repeat(40),
    });
    const done = (await listComments(d))[0];
    assert.equal(done.createdCheckpoint, 'a'.repeat(40));
    assert.equal(done.resolvedCheckpoint, 'b'.repeat(40));

    await markCommentsForRestoreReview(d, [c.id], {
      checkpoint: 'a'.repeat(40), scope: 'project', at: new Date().toISOString(),
    });
    assert.equal((await listComments(d))[0].restoreReview?.scope, 'project');

    await updateComment(d, c.id, { status: 'accepted' });
    const reopened = (await listComments(d))[0];
    assert.equal(reopened.resolvedCheckpoint, undefined);
    assert.equal(reopened.restoreReview, undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('reply threads append in order', async () => {
  const d = tmp();
  try {
    const c = await addComment(d, { page: 1, quote: 'q', rects: [], text: 'fix', role: 'defender' });
    await addReply(d, c.id, { by: 'author', text: 'averaged over 5 runs' });
    await addReply(d, c.id, { by: 'human', text: 'ok add the table' });
    const replies = (await listComments(d))[0].replies ?? [];
    assert.equal(replies.length, 2);
    assert.equal(replies[0].by, 'author');
    assert.equal(replies[1].by, 'human');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('updateComment / addReply on unknown id return null; delete works', async () => {
  const d = tmp();
  try {
    assert.equal(await updateComment(d, 'nope', { status: 'resolved' }), null);
    assert.equal(await addReply(d, 'nope', { by: 'human', text: 'x' }), null);
    const c = await addComment(d, { page: 1, quote: 'q', rects: [], text: 't' });
    assert.equal(await deleteComment(d, c.id), true);
    assert.equal(await deleteComment(d, c.id), false);
    assert.equal((await listComments(d)).length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
