/**
 * Live questions, found from the editor.
 *
 * The presenter's control page (/d/<id>/live) had no way in: it was reached
 * from a board on a slide or by knowing the URL. This button shows up once the
 * document holds a live question, says how many and how much has been
 * answered, and goes to the controls. Clearing everything is here too, behind
 * a confirmation; clearing one question stays on the control page.
 *
 * Clearing starts a new round on the server: what was answered is archived
 * (downloadable and deletable from the control page) and no longer counted,
 * so the counts here drop to zero straight away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type CanvasDocument, livePlacements } from '@playground/shared';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';

export interface LiveSummary { code: string; kind: string; answers: number; totalVotes?: number }

/** How many live questions sit on this document's slides. */
export function liveCount(doc: CanvasDocument | null): number {
  return doc ? livePlacements(doc).size : 0;
}

export function liveControlsUrl(docId: string): string {
  return `/d/${encodeURIComponent(docId)}/live`;
}

export function openLiveControls(docId: string): void {
  window.open(liveControlsUrl(docId), '_blank', 'noopener');
}

/** Votes for a poll, responses for a form, answers for a question. */
function answered(q: LiveSummary): number {
  return q.kind === 'poll' ? (q.totalVotes ?? q.answers) : q.answers;
}

export async function fetchLive(docId: string): Promise<LiveSummary[]> {
  const r = await fetch(`/api/documents/${encodeURIComponent(docId)}/live`, { cache: 'no-store' });
  if (!r.ok) throw new Error('Could not load the live questions.');
  return ((await r.json()) as { questions: LiveSummary[] }).questions;
}

/** Clears every question by starting a new round; what was answered moves to each question's archive. */
export async function clearAllLive(questions: LiveSummary[]): Promise<void> {
  for (const q of questions) {
    const r = await fetch(`/api/live/${encodeURIComponent(q.code)}/clear`, { method: 'POST' });
    if (!r.ok) throw new Error('Some answers could not be cleared.');
  }
}

export function ClearAllLiveDialog({ questions, onClose, onDone }: {
  questions: LiveSummary[]; onClose: () => void; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = questions.reduce((n, q) => n + answered(q), 0);
  return (
    <Modal title="Clear all answers?" onClose={onClose}>
      <p className="live-confirm-text">
        This clears {total} {total === 1 ? 'answer' : 'answers'} across {questions.length} live{' '}
        {questions.length === 1 ? 'question' : 'questions'} and starts a new round: answers, votes and responses leave
        the slides and every count, and the same phones can answer again. They stay in each question’s archive on the
        control page, where you can download or delete them for good.
      </p>
      {error && <p className="live-confirm-error" role="alert">{error}</p>}
      <div className="live-confirm-actions">
        <button className="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="button danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await clearAllLive(questions); onDone(); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
          }}
        >{busy ? 'Clearing…' : 'Clear all answers'}</button>
      </div>
    </Modal>
  );
}

/** The top-bar button and its menu. Renders nothing when the document has no live question. */
export function LiveMenu({ docId, count, compact }: { docId: string; count: number; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [questions, setQuestions] = useState<LiveSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** Set right after Clear all, so the menu says so until the next answer comes in. */
  const [cleared, setCleared] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const firstItem = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchLive(docId).then(setQuestions, (e: Error) => setError(e.message));
  }, [docId]);

  useEffect(() => {
    if (!open) return;
    load();
    firstItem.current?.focus();
    const onPointer = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const id = setTimeout(() => window.addEventListener('pointerdown', onPointer), 0);
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(id); window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey); };
  }, [open, load]);

  if (count === 0) return null;
  const total = questions?.reduce((n, q) => n + answered(q), 0) ?? null;
  const showCleared = cleared && total === 0;

  return (
    <span className="overflow-anchor" ref={ref}>
      <button
        className={`button live-button${open ? ' is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Live questions — answers and controls"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="live" size={14} />
        {!compact && <span className="button-label">Live</span>}
        <span className="live-badge tabular" aria-label={`${count} live ${count === 1 ? 'question' : 'questions'}`}>{count}</span>
      </button>
      {open && (
        <>
          <div className="overflow-scrim" aria-hidden />
          <div className="overflow-menu live-menu" role="menu" aria-label="Live questions">
            <div className="live-menu-head">
              <strong>Live questions</strong>
              <span className="live-menu-stats tabular">
                {count} {count === 1 ? 'question' : 'questions'}
                {' · '}
                {error ? '—' : total === null ? '…' : `${showCleared ? 'Cleared · ' : ''}${total} ${total === 1 ? 'answer' : 'answers'}`}
              </span>
            </div>
            <button ref={firstItem} role="menuitem" className="context-item" onClick={() => { openLiveControls(docId); setOpen(false); }}>
              <span><Icon name="sliders" size={14} /> Open live controls</span>
              <kbd className="overflow-hint">↗</kbd>
            </button>
            <button
              role="menuitem"
              className="context-item live-danger"
              disabled={!questions || questions.length === 0 || total === 0}
              onClick={() => { setOpen(false); setConfirming(true); }}
            >
              <span><Icon name="trash" size={14} /> Clear all answers…</span>
            </button>
          </div>
        </>
      )}
      {confirming && questions && (
        <ClearAllLiveDialog
          questions={questions}
          onClose={() => setConfirming(false)}
          onDone={() => {
            // Zero the counts at once, then confirm them with the server, and show the menu with the result.
            setQuestions((qs) => qs?.map((q) => ({ ...q, answers: 0, totalVotes: q.kind === 'poll' ? 0 : q.totalVotes })) ?? qs);
            setCleared(true);
            setOpen(true); // opening reloads them from the server

          }}
        />
      )}
    </span>
  );
}
