import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

    await updateComment(d, c.id, {
      restoreReview: null,
      verifiedCheckpoint: 'c'.repeat(40),
      verifiedAt: '2026-08-24T12:00:00.000Z',
    });
    const verified = (await listComments(d))[0];
    assert.equal(verified.restoreReview, undefined);
    assert.equal(verified.verifiedCheckpoint, 'c'.repeat(40));

    await updateComment(d, c.id, { status: 'accepted' });
    const reopened = (await listComments(d))[0];
    assert.equal(reopened.resolvedCheckpoint, undefined);
    assert.equal(reopened.restoreReview, undefined);
    assert.equal(reopened.verifiedCheckpoint, undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('comments retain a source anchor for scoped restore warnings', async () => {
  const d = tmp();
  try {
    const c = await addComment(d, {
      page: 2, quote: 'anchored prose', rects: [], text: 'fix',
      sourceFile: 'sections\\introduction.tex', sourceLine: 17,
    });
    const stored = (await listComments(d))[0];
    assert.equal(c.sourceFile, 'sections/introduction.tex');
    assert.equal(stored.sourceLine, 17);
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

test('one junk entry does not take the whole comment feature down', async () => {
  // Every comment route reads through listComments, so throwing on a single
  // malformed item bricked all of them: the panel, the MCP tools, resolve — for
  // a `null` or a stray string that nobody could even see. What is skipped here
  // cannot be a comment at all, so there is nothing in it to lose; the entries
  // that ARE comments must all still arrive.
  const d = tmp();
  try {
    const good = await addComment(d, { page: 1, quote: 'q', rects: [], text: 'real comment' });
    const store = join(d, '.latex-preview', 'comments.json');
    const parsed = JSON.parse(readFileSync(store, 'utf8')) as unknown[];
    writeFileSync(store, JSON.stringify([null, ...parsed, 'not a comment', 42, []], null, 2), 'utf8');

    const all = await listComments(d);
    assert.equal(all.length, 1, `junk was returned as comments: ${JSON.stringify(all)}`);
    assert.equal(all[0].id, good.id);

    // And the routes that mutate keep working over it, rather than inheriting
    // the same failure one call later.
    const replied = await addReply(d, good.id, { by: 'human', text: 'still works' });
    assert.equal(replied?.replies?.length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a store that will not parse is still refused, not guessed at', async () => {
  // The line between the two: an item that cannot be a comment is worth
  // nothing, but a file that does not parse might be a whole store of them, and
  // returning [] for it is how they get overwritten and lost.
  const d = tmp();
  try {
    await addComment(d, { page: 1, quote: 'q', rects: [], text: 'first' });
    const store = join(d, '.latex-preview', 'comments.json');
    writeFileSync(store, readFileSync(store, 'utf8').replace(/\}\s*\]$/, '},]'), 'utf8');
    await assert.rejects(() => listComments(d), (e: Error) => e.name === 'CommentStoreUnreadableError');
    writeFileSync(store, '{"not":"an array"}', 'utf8');
    await assert.rejects(() => listComments(d), (e: Error) => e.name === 'CommentStoreUnreadableError');
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
