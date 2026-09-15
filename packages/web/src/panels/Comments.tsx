/**
 * Every thread in the document, in one list.
 *
 * Pins are how you read a comment in context; this is how you find the ones you
 * have not answered. A canvas full of open threads is easy to miss when they
 * are scattered across three artboards and half of them are off screen.
 */

import { useEffect, useMemo } from 'react';
import { NOTE_KIND_LABELS, commentsOf } from '@playground/shared';
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

export function Comments() {
  const version = useCanvas((s) => s.version);
  const pageId = useCanvas((s) => s.pageId);
  const showResolved = useCanvas((s) => s.showResolvedComments);
  const setShowResolved = useCanvas((s) => s.setShowResolvedComments);
  const setOpenComment = useCanvas((s) => s.setOpenComment);
  const setViewport = useCanvas((s) => s.setViewport);
  const select = useCanvas((s) => s.select);
  const prefs = useCanvas((s) => s.canvasPrefs);
  const setPrefs = useCanvas((s) => s.setCanvasPrefs);
  const doc = getDoc();
  const page = currentPage();

  const comments = useMemo(
    () => (doc ? commentsOf(doc, page?.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version, pageId],
  );

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

  /** Centre the canvas on a pin and open it, so the list is a way to navigate. */
  const focus = (id: string, x: number, y: number, nodeId?: string) => {
    const zoom = useCanvas.getState().viewport.zoom;
    setViewport({ x: window.innerWidth / 2 - x * zoom, y: window.innerHeight / 2 - y * zoom });
    setOpenComment(id);
    if (nodeId && doc?.nodes[nodeId]) select([nodeId]);
  };

  return (
    <div className="comments-panel">
      <div className="comments-head">
        <span className="dim">
          {open.length} open{resolved.length ? ` · ${resolved.length} resolved` : ''}
        </span>
        <button
          className="button subtle"
          title={prefs.comments ? 'Hide the pins on the canvas' : 'Show the pins on the canvas'}
          onClick={() => setPrefs({ comments: !prefs.comments })}
        >{prefs.comments ? 'Hide pins' : 'Show pins'}</button>
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
          <button
            key={c.id}
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
        );
      })}
    </div>
  );
}
