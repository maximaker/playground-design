/**
 * Every thread in the document, in one list.
 *
 * Pins are how you read a comment in context; this is how you find the ones you
 * have not answered. A canvas full of open threads is easy to miss when they
 * are scattered across three artboards and half of them are off screen.
 */

import { useEffect, useMemo, useState } from 'react';
import { NOTE_KIND_LABELS, commentsOf, decisionsOf, describeDecision, decisionsMarkdown } from '@playground/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';
import { isAgentThread } from '../canvas/CommentPin.tsx';
import { Unfurls } from '../connect.tsx';

export function Comments() {
  const version = useCanvas((s) => s.version);
  const pageId = useCanvas((s) => s.pageId);
  const showResolved = useCanvas((s) => s.showResolvedComments);
  const setShowResolved = useCanvas((s) => s.setShowResolvedComments);
  const setOpenComment = useCanvas((s) => s.setOpenComment);
  const setViewport = useCanvas((s) => s.setViewport);
  const select = useCanvas((s) => s.select);
  const setCommentLens = useCanvas((s) => s.setCommentLens);
  const doc = getDoc();
  const page = currentPage();

  const comments = useMemo(
    () => (doc ? commentsOf(doc, page?.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version, pageId],
  );

  // The pins come on while this panel is open and go back to the preference
  // when it closes.
  useEffect(() => {
    setCommentLens(true);
    return () => setCommentLens(false);
  }, [setCommentLens]);

  // The same lens as Review: while the list is open the canvas points at the
  // layers the threads are about.
  const setHighlight = useCanvas((s) => s.setHighlight);
  useEffect(() => {
    setHighlight({
      kind: 'comments',
      ids: [...new Set(comments.filter((c) => !c.resolved && c.nodeId).map((c) => c.nodeId!))],
    });
    return () => setHighlight(null);
  }, [comments, setHighlight]);

  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);
  const shown = showResolved ? comments : open;
  const [view, setView] = useState<'threads' | 'decisions'>('threads');
  const setPage = useCanvas((s) => s.setPage);

  /** Centre the canvas on a pin and open it, so the list is a way to navigate. */
  const focus = (id: string, x: number, y: number, nodeId?: string) => {
    const zoom = useCanvas.getState().viewport.zoom;
    setViewport({ x: window.innerWidth / 2 - x * zoom, y: window.innerHeight / 2 - y * zoom });
    setOpenComment(id);
    if (nodeId && doc?.nodes[nodeId]) select([nodeId]);
  };

  return (
    <div className="comments-panel">
      <div className="review-scope">
        <button className={view === 'threads' ? 'is-active' : ''} onClick={() => setView('threads')}>Threads</button>
        <button className={view === 'decisions' ? 'is-active' : ''} onClick={() => setView('decisions')}>
          Decisions{doc?.decisions?.length ? ` · ${doc.decisions.length}` : ''}
        </button>
      </div>
      {view === 'decisions' && doc ? <Decisions doc={doc} onGo={(pageId, commentId, nodeId) => {
        if (pageId && pageId !== page?.id) setPage(pageId);
        const c = commentId ? (doc.comments ?? []).find((x) => x.id === commentId) : undefined;
        requestAnimationFrame(() => {
          if (c) focus(c.id, c.x, c.y, c.nodeId);
          else if (nodeId && doc.nodes[nodeId]) { select([nodeId]); void import('../hooks/commands.ts').then((m) => m.zoomToSelection()); }
        });
      }} /> : <>
      <div className="comments-head">
        <span className="dim">
          {open.length} open{resolved.length ? ` · ${resolved.length} resolved` : ''}
        </span>
        {resolved.length > 0 && (
          <button className="button subtle" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
        )}
      </div>

      {shown.length === 0 && (
        <p className="panel-empty">
          No comments on this page.<br />
          <span className="dim">
            Press <kbd>C</kbd> and click to leave one. Agents connected to this document can read
            them, reply, and mark them settled — so feedback goes straight to whoever is doing the
            work, human or not.
          </span>
        </p>
      )}

      {shown.map((c) => {
        const node = c.nodeId ? doc?.nodes[c.nodeId] : undefined;
        return (
          <div key={c.id} className="comment-row-wrap">
          <button
            className={`comment-row${c.resolved ? ' is-resolved' : ''}`}
            onClick={() => focus(c.id, c.x, c.y, c.nodeId)}
          >
            <div className="comment-row-head">
              {/* A typed note is handover, not conversation. Saying so here as
                  well as in the Spec panel stops the two reading as one pile. */}
              {c.kind && c.kind !== 'comment' && (
                <span className={`note-kind note-${c.kind}`}>
                  {NOTE_KIND_LABELS[c.kind] ?? c.kind}
                </span>
              )}
              <strong>{c.author}</strong>
              {isAgentThread(c) && <span className="comment-agent-tag">agent</span>}
              {c.resolved && <Icon name="check" size={11} />}
              {c.replies.length > 0 && <span className="dim">{c.replies.length} repl{c.replies.length === 1 ? 'y' : 'ies'}</span>}
            </div>
            <p className="comment-row-text">{c.text}</p>
            <span className="dim comment-row-target">
              {/* A comment outlives the layer it was about, so say when that
                  happened rather than showing a dangling name. */}
              {c.nodeId ? (node ? node.name : 'layer deleted') : 'on the canvas'}
            </span>
          </button>
          {/* heymax links in a comment unfurl as cards; a card is a link, so it sits outside the row button. */}
          <Unfurls text={[c.text, ...c.replies.map((r) => r.text)].join(' ')} />
          </div>
        );
      })}
      </>}
    </div>
  );
}

/** The document's decisions log: newest first here, since this is where you look for what just changed. */
function Decisions({ doc, onGo }: {
  doc: NonNullable<ReturnType<typeof getDoc>>;
  onGo: (pageId?: string, commentId?: string, nodeId?: string) => void;
}) {
  const rows = decisionsOf(doc).reverse();
  const download = () => {
    const blob = new Blob([decisionsMarkdown(doc)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.name.replace(/[^\w -]+/g, '').trim() || 'document'} — decisions.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  if (!rows.length) {
    return (
      <p className="panel-empty">
        No decisions yet.<br />
        <span className="dim">
          Resolve a comment thread with an outcome and it is logged here — what was decided, by whom,
          and when, linked back to the thread. Agents read it with <code>list_decisions</code>.
        </span>
      </p>
    );
  }
  return (
    <div className="decisions">
      {rows.map((d) => {
        const info = describeDecision(doc, d);
        const where = info.node && !('deleted' in info.node) ? info.node.name : info.page?.name;
        return (
          <button key={d.id} className="decision-row" onClick={() => onGo(d.pageId, d.commentId, d.nodeId)} title="Go to the thread">
            <p className="decision-text">{d.text}</p>
            <span className="dim">{info.by} · {info.date}{where ? ` · ${where}` : ''}{d.commentId ? ' · from a thread' : ''}</span>
          </button>
        );
      })}
      <button className="button subtle full" onClick={download}>Download as Markdown</button>
    </div>
  );
}
