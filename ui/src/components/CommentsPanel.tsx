// Right panel: the comments workspace and the review gate.
//   suggested — a reviewer agent proposed it; the human Accepts (→ accepted) or
//               Rejects it, unless "auto-accept" (copilot) is on.
//   accepted  — actionable; the author loop picks these up via check_comments.
//   resolved  — done, with the author's note.
// Clicking a card jumps to its highlight in the PDF.
import { useEffect, useState } from 'react';
import { patchComment, removeComment, replyComment, type Comment, type Status } from '../api';

function ReplyBox({ id, onFailed }: { id: string; onFailed: (message: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form className="reply-box" onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            // The reply is cleared optimistically, so a refused one has to say
            // so — otherwise the box empties and the words are simply gone.
            const sent = text.trim();
            void replyComment(id, sent).catch((error) => {
              onFailed(`Your reply was not posted: ${String((error as Error).message ?? error)}`);
              setText(sent);
            });
            setText('');
          }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" />
      <button className="ghost tiny" disabled={!text.trim()}>send</button>
    </form>
  );
}

export function CommentsPanel({
  comments, selectedId, onJump, liveStatus, pdfCheckpoint, noHistory = false,
}: {
  comments: Comment[];
  selectedId: string | null;
  onJump: (c: Comment) => void;
  liveStatus: Status;
  pdfCheckpoint?: string;
  /** This workspace records no history at all (no git, or an unwritable store).
   *  The version gate below cannot be met here and never will be, so gating on
   *  it would disable the review buttons permanently. */
  noHistory?: boolean;
}) {
  const [auto, setAuto] = useState(() => localStorage.getItem('ws-auto-accept') === '1');
  const [actionError, setActionError] = useState('');
  // What the server managed to record and what it could not — per card, because
  // it is a fact about that comment, not a failure of the workspace.
  const [notes, setNotes] = useState<Record<string, string>>({});
  useEffect(() => { localStorage.setItem('ws-auto-accept', auto ? '1' : '0'); }, [auto]);

  const suggested = comments.filter((c) => c.status === 'suggested');
  const accepted = comments.filter((c) => c.status === 'accepted');
  const resolved = comments.filter((c) => c.status === 'resolved');

  // Copilot mode: as reviewer suggestions arrive, accept them automatically.
  useEffect(() => {
    if (!auto) return;
    for (const c of suggested) void patchComment(c.id, { status: 'accepted' }).catch((error) => {
      setActionError(String((error as Error).message ?? error));
    });
  }, [auto, comments]);

  /** Run one comment operation, and never let it fail in silence. `id` is the
   *  card any note in the answer belongs to. */
  const run = (id: string, operation: Promise<{ note?: string } | void>) => void operation.then((result) => {
    setActionError('');
    const note = result && 'note' in result ? result.note : undefined;
    setNotes((current) => {
      if (!note) {
        if (!(id in current)) return current;
        const next = { ...current }; delete next[id]; return next;
      }
      return { ...current, [id]: note };
    });
  }).catch((error) => {
    setActionError(String((error as Error).message ?? error));
  });
  const accept = (c: Comment) => run(c.id, patchComment(c.id, { status: 'accepted' }));
  const reject = (c: Comment) => run(c.id, removeComment(c.id));
  const short = (sha?: string) => sha?.slice(0, 8);

  // Resolving and verifying both stamp the comment with the checkpoint that
  // produced the PDF in front of you, so both need one. "verified" was disabled
  // without it while "resolve" was offered and then failed into a red banner —
  // the same requirement, told two different ways. Where nothing is recorded at
  // all the stamp is unobtainable, so the buttons stay live and the server says
  // in its answer what it could not write down.
  const needsRender = !noHistory && (liveStatus !== 'ok' || !pdfCheckpoint);
  const renderGateTitle = 'Wait for a successful recompile: this records the version the review was made against.';

  const card = (c: Comment) => (
    <div key={c.id} className={`comment ${c.id === selectedId ? 'sel' : ''} ${c.status}`} onClick={() => onJump(c)}>
      <div className="comment-quote">
        {c.role && c.role !== 'human' && <span className={`role-badge role-${c.role}`}>{c.role}</span>}
        p.{c.page} · “{c.quote.slice(0, 90)}{c.quote.length > 90 ? '…' : ''}”
      </div>
      <div className="comment-text">{c.text}</div>
      {c.replies?.map((r, i) => (
        <div key={i} className="reply"><span className={`role-badge role-${r.by}`}>{r.by}</span>{r.text}</div>
      ))}
      {c.status === 'resolved' && c.resolvedNote && <div className="comment-note">✓ {c.resolvedNote}</div>}
      {notes[c.id] && <div className="comment-server-note">ⓘ {notes[c.id]}</div>}
      {(c.createdCheckpoint || c.resolvedCheckpoint || c.verifiedCheckpoint) && (
        <div className="comment-version">
          {c.createdCheckpoint && <>created at {short(c.createdCheckpoint)}</>}
          {c.createdCheckpoint && c.resolvedCheckpoint && <> · </>}
          {c.resolvedCheckpoint && <>resolved at {short(c.resolvedCheckpoint)}</>}
          {c.verifiedCheckpoint && <>{(c.createdCheckpoint || c.resolvedCheckpoint) && <> · </>}verified at {short(c.verifiedCheckpoint)}</>}
        </div>
      )}
      {c.restoreReview && (
        <div className="comment-restore-warning">
          ⚠ An earlier {c.restoreReview.scope}{c.restoreReview.label ? ` (“${c.restoreReview.label}”)` : ''} was restored after this resolution. Verify that the fix is still present, or reopen it.
        </div>
      )}
      {c.status !== 'resolved' && <ReplyBox id={c.id} onFailed={setActionError} />}
      <div className="comment-actions" onClick={(e) => e.stopPropagation()}>
        {c.status === 'suggested' && <>
          <button className="on" onClick={() => accept(c)}>Accept</button>
          <button className="ghost" onClick={() => reject(c)}>Reject</button>
        </>}
        {c.status === 'accepted' && <>
          <button
            className="ghost"
            disabled={needsRender}
            title={needsRender ? renderGateTitle : 'Mark this addressed, on the checkpoint that produced the PDF you are looking at'}
            onClick={() => run(c.id, patchComment(c.id, { status: 'resolved' }))}
          >resolve</button>
          <button className="ghost" onClick={() => run(c.id, removeComment(c.id))}>delete</button>
        </>}
        {c.status === 'resolved' && <>
          {c.restoreReview && <button
            className="ghost"
            disabled={needsRender}
            title={needsRender ? renderGateTitle : 'Record verification on this rendered checkpoint'}
            onClick={() => run(c.id, patchComment(c.id, { restoreReview: null }))}
          >verified</button>}
          <button className="ghost" onClick={() => run(c.id, patchComment(c.id, { status: 'accepted' }))}>reopen</button>
          <button className="ghost" onClick={() => run(c.id, removeComment(c.id))}>close</button>
        </>}
      </div>
    </div>
  );

  return (
    <div className="comments">
      {/* Dismissible: once it has been read it is in the way of the comments,
          and nothing else clears it until the next successful action. */}
      {actionError && (
        <div className="comment-action-error" role="alert">
          <span>{actionError}</span>
          <button className="ghost" onClick={() => setActionError('')} title="Dismiss">×</button>
        </div>
      )}
      <label className="auto-accept" title="Copilot: automatically accept reviewer suggestions so the loop resolves them without a manual gate">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Auto-accept reviewer suggestions (copilot)
      </label>

      {comments.length === 0 && (
        <div className="panel-hint">
          Select text on the PDF and add a comment — or have a reviewer agent post them.
          Accepted comments become instructions the author loop picks up (“address my comments”).
        </div>
      )}

      {suggested.length > 0 && (
        <div className="comments-head suggested-head">
          Suggested · {suggested.length}
          <button className="ghost tiny" onClick={() => suggested.forEach(accept)}>accept all</button>
          <button className="ghost tiny" onClick={() => suggested.forEach(reject)}>reject all</button>
        </div>
      )}
      {suggested.map(card)}

      {accepted.length > 0 && <div className="comments-head">Accepted · {accepted.length}</div>}
      {accepted.map(card)}

      {resolved.length > 0 && (
        <div className="comments-head suggested-head">
          Resolved · {resolved.length}
          <button className="ghost tiny" onClick={() => resolved.forEach((c) => run(c.id, removeComment(c.id)))}>clear all</button>
        </div>
      )}
      {resolved.map(card)}
    </div>
  );
}
