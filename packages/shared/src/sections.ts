/**
 * Sections: titled runs of screens on a page.
 *
 * A section owns artboards by id and has no rectangle of its own — its region
 * is the box around its members plus padding and a header strip, so it grows
 * and shrinks as screens move. That is what an agent documenting a 28-screen
 * app needs: "these six are Onboarding, and they are Ready", without faking a
 * header as an artboard.
 */

import {
  type CanvasDocument, type NodeId, type Page, type Section, type SectionStatus,
  getArtboardPosition, getArtboardSize, NOTE_COLORS, type NoteColor,
} from './model.ts';
import type { Op } from './ops.ts';

export const SECTION_LAYOUT = {
  /** Space between the members' box and the region edge. */
  padding: 48,
  /** Height of the header strip above the members. */
  header: 96,
  /** Gap between screens when a section is arranged in a row. */
  gap: 80,
};

export const SECTION_STATUS_META: Record<SectionStatus, { label: string; bg: string; fg: string }> = {
  draft: { label: 'Draft', bg: '#e8edf3', fg: '#475569' },
  'in-review': { label: 'In review', bg: '#fef3c7', fg: '#92400e' },
  ready: { label: 'Ready', bg: '#dcfce7', fg: '#166534' },
  changed: { label: 'Changed', bg: '#fce7f3', fg: '#9d174d' },
};

export function sectionsOf(page: Page | undefined): Section[] {
  return [...(page?.sections ?? [])].sort((a, b) => a.order - b.order);
}

/** Members that still exist on the page, in the section's order. */
export function sectionMembers(doc: CanvasDocument, page: Page, section: Section): NodeId[] {
  const onPage = new Set(page.artboards);
  return section.artboards.filter((id) => onPage.has(id) && doc.nodes[id]);
}

export function sectionOfArtboard(page: Page | undefined, artboardId: NodeId): Section | undefined {
  return page?.sections?.find((s) => s.artboards.includes(artboardId));
}

export interface SectionRect { x: number; y: number; width: number; height: number }

/** The members' box, without padding; null for an empty section. */
export function membersBox(doc: CanvasDocument, ids: NodeId[]): SectionRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    const p = getArtboardPosition(node);
    const s = getArtboardSize(node);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + s.width); y1 = Math.max(y1, p.y + s.height);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The region drawn on the canvas: members' box + padding + header strip. */
export function sectionRect(doc: CanvasDocument, page: Page, section: Section): SectionRect | null {
  const box = membersBox(doc, sectionMembers(doc, page, section));
  if (!box) return null;
  const { padding, header } = SECTION_LAYOUT;
  return { x: box.x - padding, y: box.y - padding - header, width: box.width + padding * 2, height: box.height + padding * 2 + header };
}

export function sectionTint(color: string | undefined): { bg: string; border: string } {
  const named = color && NOTE_COLORS[color as NoteColor];
  if (named) return { bg: named.bg, border: named.border };
  if (color) return { bg: color, border: color };
  return { bg: 'rgba(255,255,255,0.55)', border: '#d5dde8' };
}

/**
 * Attr ops that lay the members out left to right, top-aligned, starting where
 * the section's first member is (or at `origin`).
 */
export function arrangeSectionOps(
  doc: CanvasDocument, page: Page, section: Section, opts: { gap?: number; origin?: { x: number; y: number } } = {},
): Op[] {
  const ids = sectionMembers(doc, page, section);
  if (!ids.length) return [];
  const box = membersBox(doc, ids)!;
  let x = opts.origin?.x ?? box.x;
  const y = opts.origin?.y ?? box.y;
  const gap = opts.gap ?? SECTION_LAYOUT.gap;
  const updates = ids.map((id) => {
    const update = { id, attrs: { 'data-x': String(Math.round(x)), 'data-y': String(Math.round(y)) } };
    x += getArtboardSize(doc.nodes[id]!).width + gap;
    return update;
  });
  return [{ t: 'attrs', updates }];
}

/** Attr ops that shift every member by (dx, dy) — dragging the header. */
export function moveSectionOps(doc: CanvasDocument, page: Page, section: Section, dx: number, dy: number): Op[] {
  const updates = sectionMembers(doc, page, section).map((id) => {
    const p = getArtboardPosition(doc.nodes[id]!);
    return { id, attrs: { 'data-x': String(Math.round(p.x + dx)), 'data-y': String(Math.round(p.y + dy)) } };
  });
  return updates.length ? [{ t: 'attrs', updates }] : [];
}

/** The section whose region contains the point, ignoring `except`. */
export function sectionAt(doc: CanvasDocument, page: Page, x: number, y: number, except?: NodeId): Section | undefined {
  return sectionsOf(page).reverse().find((s) => {
    const r = sectionRect(doc, page, { ...s, artboards: s.artboards.filter((a) => a !== except) });
    return r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  });
}
