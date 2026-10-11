/**
 * Sections on the canvas: a soft titled region behind a run of screens.
 *
 * The region has no geometry of its own — it wraps its member artboards
 * (shared/sections.ts), so it follows them as they move. Dragging the header
 * strip moves the members, which is handled in Canvas.tsx via
 * `data-section-header`.
 */

import { useState } from 'react';
import {
  type Section, type SectionStatus, SECTION_LAYOUT, SECTION_STATUSES, SECTION_STATUS_META,
  sectionRect, sectionMembers, sectionsOf, sectionTint, newId, sectionFlows,
} from '@playground/shared';
import { useCanvas, currentPage, getDoc } from '../state/store.ts';
import { fitBox, jumpToBoardItem } from '../hooks/commands.ts';

const MIN_SECTION_WIDTH = 900;

export function SectionLayer() {
  useCanvas((s) => s.version);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const page = currentPage();
  const doc = getDoc();
  if (!page || !doc || !page.sections?.length) return null;
  return (
    <>
      {sectionsOf(page).map((s) => <SectionRegion key={s.id} section={s} zoom={zoom} />)}
    </>
  );
}

// Not memoised: the region is derived from its members' positions, which
// change without the section object changing.
function SectionRegion({ section, zoom }: { section: Section; zoom: number }) {
  const doc = getDoc();
  const page = currentPage();
  if (!doc || !page) return null;
  const rect = sectionRect(doc, page, section);
  if (!rect) return null;
  const count = sectionMembers(doc, page, section).length;
  const flows = sectionFlows(doc, section);
  const tint = sectionTint(section.color);
  const status = SECTION_STATUS_META[section.status];
  // Text is sized in canvas units so it stays proportional to the screens, but
  // never smaller than readable nor larger than a heading.
  const font = Math.min(30, Math.max(11, 26 * zoom));
  const tiny = zoom < 0.04;
  const top = Math.max(4, 28 * zoom);
  // Artboard name labels and presence avatars sit a fixed height above each
  // screen. Zoomed out, the header grows upward in screen pixels so its text
  // never reaches them.
  const needed = top + font * 1.4 + SECTION_LAYOUT.labelReserve;
  // Capped at half the gap between sections, so neighbours never touch.
  const extra = Math.min(SECTION_LAYOUT.sectionGap * zoom * 0.5,
    Math.max(0, needed - (SECTION_LAYOUT.header + SECTION_LAYOUT.padding) * zoom));
  // Far out, only the title and status are worth the space.
  const brief = zoom < 0.2;
  const header = SECTION_LAYOUT.header * zoom + extra;

  return (
    <div
      className="section-region"
      style={{
        left: rect.x * zoom, top: rect.y * zoom - extra,
        // A one-screen section is narrower than its own title, status and
        // count; the region keeps a minimum width so the header never clips.
        width: Math.max(rect.width, MIN_SECTION_WIDTH) * zoom, height: rect.height * zoom + extra,
        // Mixed per theme (--section-mix) so the canvas's own labels stay legible
        // on the region in light and dark alike.
        background: `color-mix(in srgb, ${tint.bg} var(--section-mix), transparent)`,
        borderColor: `color-mix(in srgb, ${tint.border} var(--section-line), transparent)`, borderRadius: Math.max(6, 28 * zoom),
      }}
    >
      <div
        className="section-header"
        data-section-header={section.id}
        title="Drag to move the section with its screens"
        style={{ height: header, padding: `${top}px ${Math.max(6, SECTION_LAYOUT.padding * zoom)}px 0`, fontSize: font }}
      >
        {!tiny && (
          <>
            <span className="section-title">{section.title}</span>
            <span className="section-pill" style={{ background: status.bg, color: status.fg, fontSize: Math.max(10, font * 0.6) }}>
              {status.label}
            </span>
            {!brief && flows.map((f) => (
              <button
                key={f.id}
                className="section-flow"
                style={{ fontSize: Math.max(10, font * 0.55) }}
                title={`Flow: ${f.title}${f.pageId === page.id ? '' : ` on ${f.pageName}`} — click to open the diagram`}
                // The header drags the section; a chip is a link, not a handle.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => jumpToBoardItem(f.pageId, f.id)}
              >
                <span className="section-flow-label">Flow</span>{f.title}
              </button>
            ))}
            {!brief && <span className="section-count" style={{ fontSize: Math.max(10, font * 0.6) }}>
              {count} screen{count === 1 ? '' : 's'}
            </span>}
            {!brief && section.description && (
              <span className="section-desc" style={{ fontSize: Math.max(10, font * 0.6) }}>{section.description}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The Sections list under the page in the Pages tab. */
export function SectionList() {
  useCanvas((s) => s.version);
  const dispatch = useCanvas((s) => s.dispatch);
  const selection = useCanvas((s) => s.selection);
  const setPresent = useCanvas((s) => s.setPresent);
  const [editing, setEditing] = useState<string | null>(null);
  const page = currentPage();
  const doc = getDoc();
  if (!page || !doc) return null;
  const sections = sectionsOf(page);
  const selectedBoards = selection.filter((id) => page.artboards.includes(id));

  const jump = (s: Section) => {
    const r = sectionRect(doc, page, s);
    if (r) fitBox(r.x, r.y, r.width, r.height);
  };
  const present = (s: Section) => {
    const first = sectionMembers(doc, page, s)[0];
    const index = first ? page.artboards.filter((id) => doc.nodes[id]).indexOf(first) : 0;
    setPresent({ pageId: page.id, index: Math.max(0, index) });
  };
  const update = (s: Section, patch: Partial<Section>) =>
    dispatch([{ t: 'section', action: 'update', pageId: page.id, section: { id: s.id, ...patch } }]);
  const create = () => {
    const taken = new Set(sections.flatMap((s) => s.artboards));
    const members = selectedBoards.filter((id) => !taken.has(id));
    const title = window.prompt('Section title', `Section ${sections.length + 1}`);
    if (!title) return;
    dispatch([{ t: 'section', action: 'add', pageId: page.id, section: { id: newId('sec'), title, artboards: members, order: sections.length } }]);
  };

  return (
    <div className="section-list">
      <div className="section-list-head">
        <span>Sections</span>
        <button
          className="button subtle"
          onClick={create}
          title={selectedBoards.length ? 'New section from the selected screens' : 'Select screens first, or drop them in afterwards'}
        >
          + New
        </button>
      </div>
      {!sections.length && <p className="section-list-empty">Group screens into titled sections with a status.</p>}
      {sections.map((s) => {
        const count = sectionMembers(doc, page, s).length;
        const meta = SECTION_STATUS_META[s.status];
        return (
          <div key={s.id} className="section-row">
            {editing === s.id ? (
              <input
                className="input"
                autoFocus
                defaultValue={s.title}
                onBlur={(e) => { if (e.target.value && e.target.value !== s.title) update(s, { title: e.target.value }); setEditing(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }}
              />
            ) : (
              <button className="section-row-title" onClick={() => jump(s)} onDoubleClick={() => setEditing(s.id)} title="Jump to section · double-click to rename">
                {s.title}
                <span className="section-row-count">{count}</span>
              </button>
            )}
            <select
              className="section-row-status"
              value={s.status}
              style={{ background: meta.bg, color: meta.fg }}
              onChange={(e) => update(s, { status: e.target.value as SectionStatus })}
              aria-label="Status"
            >
              {SECTION_STATUSES.map((st) => <option key={st} value={st}>{SECTION_STATUS_META[st].label}</option>)}
            </select>
            <button className="icon-button" title="Present from this section" onClick={() => present(s)} disabled={!count}>▶</button>
            <button
              className="icon-button"
              title="Delete section (screens stay)"
              onClick={() => dispatch([{ t: 'section', action: 'remove', pageId: page.id, section: { id: s.id } }])}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
