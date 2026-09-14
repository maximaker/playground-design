/**
 * A comment thread, pinned to the design.
 *
 * Deliberately not a sticky note. A prompt card is work you are handing to an
 * agent and it takes up space on the canvas; a comment is something someone
 * said, and it should stay out of the way until you look at it. So the resting
 * state is a small marker and the thread opens on click.
 *
 * The pin does not scale with the canvas. A remark at 10% zoom is still a
 * remark you need to be able to find and click, and scaling it would make it a
 * few pixels wide — the same reason the note card collapses to a marker.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { type Comment, type CommentReply, newId } from '@playground/shared';
import { useCanvas } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

export const CommentPin = memo(function CommentPin({ comment }: { comment: Comment }) {
  const zoom = useCanvas((s) => s.viewport.zoom);
  const dispatch = useCanvas((s) => s.dispatch);
  const openComment = useCanvas((s) => s.openComment);
  const setOpenComment = useCanvas((s) => s.setOpenComment);
  const showResolved = useCanvas((s) => s.showResolvedComments);

  const open = openComment === comment.id;
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  if (comment.resolved && !showResolved && !open) return null;

  const reply = () => {
    const text = draft.trim();
    if (!text) return;
    const entry: CommentReply = {
      id: newId('r'), author: authorName(), text, kind: 'human', createdAt: Date.now(),
    };
    dispatch([{ t: 'comment', action: 'reply', comment: { id: comment.id }, reply: entry }]);
    setDraft('');
  };

  const setResolved = (resolved: boolean) => {
    dispatch([{ t: 'comment', action: 'update', comment: { id: comment.id, resolved } }]);
    if (resolved) setOpenComment(null);
  };

  return (
    <div
      className={`comment-pin${open ? ' is-open' : ''}${comment.resolved ? ' is-resolved' : ''}`}
      style={{ left: comment.x * zoom, top: comment.y * zoom }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className="comment-marker"
        title={comment.resolved ? 'Resolved' : `${comment.author}: ${comment.text}`}
        aria-expanded={open}
        onClick={() => setOpenComment(open ? null : comment.id)}
      >
        {comment.resolved ? <Icon name="check" size={12} /> : initials(comment.author)}
        {comment.replies.length > 0 && !comment.resolved && (
          <span className="comment-count">{comment.replies.length}</span>
        )}
      </button>

      {open && (
        <div className="comment-thread">
          <Entry author={comment.author} text={comment.text} at={comment.createdAt} />
          {comment.replies.map((r) => (
            <Entry key={r.id} author={r.author} text={r.text} at={r.createdAt} agent={r.kind === 'agent'} />
          ))}

          <textarea
            ref={inputRef}
            className="comment-input"
            placeholder="Reply…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift-Enter is a newline. A reply is usually one
              // line, and reaching for a button for every one of them is worse.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); reply(); }
              if (e.key === 'Escape') setOpenComment(null);
              e.stopPropagation();
            }}
          />

          <footer className="comment-actions">
            <button className="button subtle" onClick={() => setResolved(!comment.resolved)}>
              {comment.resolved ? 'Reopen' : 'Resolve'}
            </button>
            <button className="button" onClick={reply} disabled={!draft.trim()}>Reply</button>
          </footer>
        </div>
      )}
    </div>
  );
});

function Entry({ author, text, at, agent }: { author: string; text: string; at: number; agent?: boolean }) {
  return (
    <div className={`comment-entry${agent ? ' is-agent' : ''}`}>
      <div className="comment-entry-head">
        <strong>{author}</strong>
        {agent && <span className="comment-agent-tag">agent</span>}
        <span className="dim">{relative(at)}</span>
      </div>
      <p>{text}</p>
    </div>
  );
}

/** The name this browser comments under. No accounts, so it is just a label. */
export function authorName(): string {
  return localStorage.getItem('canvas.name')?.trim() || 'Guest';
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/**
 * The composer for a comment that has not been posted yet.
 *
 * It lives on the canvas at the pin's position rather than in a dialog, because
 * where you clicked *is* the context — pulling the writing away from the thing
 * being talked about is how comments end up vague.
 */
export const CommentComposer = memo(function CommentComposer() {
  const draft = useCanvas((s) => s.draftComment);
  const setDraft = useCanvas((s) => s.setDraftComment);
  const dispatch = useCanvas((s) => s.dispatch);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const setOpenComment = useCanvas((s) => s.setOpenComment);

  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { setText(''); ref.current?.focus(); }, [draft?.id]);

  if (!draft) return null;

  const post = () => {
    const body = text.trim();
    // An empty comment is a misclick, not a remark. Dropping it silently is
    // kinder than posting a blank pin and asking someone to clean it up.
    if (!body) { setDraft(null); return; }
    dispatch([{ t: 'comment', action: 'add', comment: { ...draft, text: body } }]);
    setDraft(null);
    setOpenComment(draft.id);
  };

  return (
    <div
      className="comment-pin is-open is-draft"
      style={{ left: draft.x * zoom, top: draft.y * zoom }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="comment-marker is-draft">{initials(draft.author)}</span>
      <div className="comment-thread">
        <textarea
          ref={ref}
          className="comment-input"
          placeholder={draft.nodeId ? 'Comment on this layer…' : 'Comment…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); }
            if (e.key === 'Escape') setDraft(null);
            e.stopPropagation();
          }}
        />
        <footer className="comment-actions">
          <button className="button subtle" onClick={() => setDraft(null)}>Cancel</button>
          <button className="button primary" onClick={post} disabled={!text.trim()}>Comment</button>
        </footer>
      </div>
    </div>
  );
});
