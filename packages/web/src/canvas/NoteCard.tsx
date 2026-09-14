/**
 * A prompt card on the canvas.
 *
 * The point of these is that a request lives next to the thing it is about,
 * rather than in a chat log where the spatial context is lost. A card can be
 * just a note, or handed to an agent — the "Ask an agent" button queues it, an
 * agent claims it, and the answer comes back on the card itself.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { type Note, NOTE_COLORS } from '@playground/shared';
import { useCanvas, currentPage } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

interface Props { note: Note }

export const NoteCard = memo(function NoteCard({ note }: Props) {
  const zoom = useCanvas((s) => s.viewport.zoom);
  const dispatch = useCanvas((s) => s.dispatch);
  const selection = useCanvas((s) => s.selection);
  const selectedNote = useCanvas((s) => s.selectedNote);
  const selectNote = useCanvas((s) => s.selectNote);
  const toast = useCanvas((s) => s.toast);

  const [editing, setEditing] = useState(note.text === '');
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const page = currentPage();
  const colors = NOTE_COLORS[note.color];
  const isSelected = selectedNote === note.id;

  // Below this zoom the card is a few pixels wide: laying out text inside it
  // produces one character per line and a card hundreds of times taller than
  // it should be. Draw a marker instead.
  const collapsed = zoom < 0.35;

  useEffect(() => { if (editing) textRef.current?.focus(); }, [editing]);

  const update = (patch: Partial<Note>) => {
    if (!page) return;
    dispatch([{ t: 'note', action: 'update', pageId: page.id, note: { id: note.id, ...patch } }]);
  };

  const remove = () => {
    if (!page) return;
    dispatch([{ t: 'note', action: 'remove', pageId: page.id, note: { id: note.id } }]);
  };

  const queue = () => {
    if (!note.text.trim()) { toast('Write what you want done first', 'error'); return; }
    // Attaching the current selection is what makes the request actionable: the
    // agent gets node ids, not just a sentence pointing vaguely at the screen.
    update({ status: 'queued', targets: selection.length ? selection : note.targets, response: undefined });
    toast(
      selection.length
        ? `Queued for an agent, with ${selection.length} layer${selection.length === 1 ? '' : 's'} attached`
        : 'Queued for an agent',
      'success',
    );
  };

  return (
    <div
      className={`note${isSelected ? ' is-selected' : ''} note-${note.status}`}
      data-note-id={note.id}
      style={{
        left: note.x * zoom,
        top: note.y * zoom,
        width: note.width * zoom,
        // The card's type scales with the canvas so it stays in proportion.
        // Height is clamped when collapsed so a marker cannot grow unbounded.
        height: collapsed ? note.height * zoom : 'auto',
        minHeight: collapsed ? undefined : note.height * zoom,
        background: colors.bg,
        borderColor: isSelected ? 'var(--accent)' : colors.border,
        color: colors.fg,
        fontSize: 12 * zoom,
        padding: collapsed ? 0 : 10 * zoom,
        borderRadius: Math.max(2, 8 * zoom),
      }}
      onPointerDown={(e) => { e.stopPropagation(); selectNote(note.id); }}
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
    >
      {collapsed ? (
        <span className="note-collapsed" title={note.text}>
          <Icon name={note.status === 'done' ? 'check' : note.status === 'idle' ? 'note' : 'agent'} size={Math.max(6, 14 * zoom)} />
        </span>
      ) : (
        <>
      <header className="note-header" style={{ gap: 4 * zoom }}>
        <span className="note-status" data-status={note.status}>
          {note.status === 'queued' && '◷ waiting for an agent'}
          {note.status === 'running' && `◐ ${note.claimedBy ?? 'Agent'} working`}
          {note.status === 'done' && `✓ ${note.claimedBy ?? 'Agent'}`}
          {note.status === 'idle' && (note.author ?? 'Note')}
        </span>
        {isSelected && (
          <button className="note-close" onClick={(e) => { e.stopPropagation(); remove(); }} title="Delete note">✕</button>
        )}
      </header>

      {editing ? (
        <textarea
          ref={textRef}
          className="note-text"
          defaultValue={note.text}
          style={{ fontSize: Math.max(7, 12 * zoom) }}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => { setEditing(false); if (e.target.value !== note.text) update({ text: e.target.value }); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setEditing(false); e.currentTarget.blur(); }
            e.stopPropagation();
          }}
          placeholder="Ask an agent to change something, or just leave a note…"
        />
      ) : (
        <p className="note-body">{note.text || <span className="dim">Double-click to write…</span>}</p>
      )}

      {note.response && (
        <p className="note-response" style={{ fontSize: Math.max(6, 11 * zoom) }}>{note.response}</p>
      )}

      {isSelected && zoom > 0.25 && (
        <footer className="note-actions">
          {note.status === 'idle' || note.status === 'done' ? (
            <button onClick={(e) => { e.stopPropagation(); queue(); }}>Ask an agent</button>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); update({ status: 'idle', claimedBy: undefined }); }}>
              Cancel request
            </button>
          )}
          <div className="note-colors">
            {(Object.keys(NOTE_COLORS) as (keyof typeof NOTE_COLORS)[]).map((c) => (
              <button
                key={c}
                className={`note-swatch${note.color === c ? ' is-active' : ''}`}
                style={{ background: NOTE_COLORS[c].bg, borderColor: NOTE_COLORS[c].border }}
                onClick={(e) => { e.stopPropagation(); update({ color: c }); }}
                title={c}
              />
            ))}
          </div>
        </footer>
      )}

      {note.targets.length > 0 && (
        <span className="note-targets">{note.targets.length} layer{note.targets.length === 1 ? '' : 's'} attached</span>
      )}
        </>
      )}
    </div>
  );
});
