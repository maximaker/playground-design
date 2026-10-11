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
import { boardOf, isShape } from './board.ts';

export const SECTION_LAYOUT = {
  /** Space between the members' box and the region edge. */
  padding: 80,
  /** Height of the header strip above the members. */
  header: 120,
  /** Gap between screens when a section is arranged in a row. */
  gap: 120,
  /** Clear space between one section's region and the next when arranging. */
  sectionGap: 240,
  /**
   * Screen pixels kept free between the header text and the frames, for the
   * artboard name labels and presence avatars that sit above every frame at a
   * fixed on-screen size. The header grows upward when zoom alone cannot give it.
   */
  labelReserve: 52,
};

export const SECTION_STATUS_META: Record<SectionStatus, { label: string; bg: string; fg: string }> = {
  draft: { label: 'Draft', bg: '#e8edf3', fg: '#475569' },
  'in-review': { label: 'In review', bg: '#fef3c7', fg: '#92400e' },
  ready: { label: 'Ready', bg: '#dcfce7', fg: '#166534' },
  changed: { label: 'Changed', bg: '#fce7f3', fg: '#9d174d' },
};

/** A section's flow, resolved: the board item it names, on whatever page. */
export interface SectionFlow {
  id: string;
  title: string;
  pageId: string;
  pageName: string;
  kind: 'section' | 'shape' | 'connector';
}

/** The board item `id` on any page, as a flow chip names it. */
export function findFlow(doc: CanvasDocument, id: string): SectionFlow | null {
  for (const page of doc.pages) {
    const item = boardOf(page).find((i) => i.id === id);
    if (!item) continue;
    if (isShape(item)) {
      const title = item.text.trim().split('\n')[0] || (item.kind === 'section' ? 'Untitled diagram' : 'Untitled shape');
      return { id, title, pageId: page.id, pageName: page.name, kind: item.kind === 'section' ? 'section' : 'shape' };
    }
    return { id, title: item.label?.trim() || 'Connector', pageId: page.id, pageName: page.name, kind: 'connector' };
  }
  return null;
}

/**
 * A section's flows that still exist, resolved, in order. They may be on any
 * page: the screens live on one, the user-flow diagram usually on another.
 */
export function sectionFlows(doc: CanvasDocument, section: Section): SectionFlow[] {
  return (section.flows ?? []).map((id) => findFlow(doc, id)).filter((f): f is SectionFlow => !!f);
}

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
  return { bg: '#ffffff', border: '#c3cedb' };
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
  let y = opts.origin?.y ?? box.y;
  const gap = opts.gap ?? SECTION_LAYOUT.gap;
  // The row's region must keep sectionGap clear of every other section; if it
  // would not, it moves down below the ones it would hit.
  const width = ids.reduce((w, id) => w + getArtboardSize(doc.nodes[id]!).width, 0) + gap * (ids.length - 1);
  const height = Math.max(...ids.map((id) => getArtboardSize(doc.nodes[id]!).height));
  const { padding, header, sectionGap } = SECTION_LAYOUT;
  const others = sectionsOf(page).filter((s) => s.id !== section.id)
    .map((s) => sectionRect(doc, page, { ...s, artboards: s.artboards.filter((a) => !ids.includes(a)) }))
    .filter((r): r is SectionRect => !!r);
  for (let guard = 0; guard < others.length + 1; guard++) {
    const region = { x: x - padding - sectionGap, y: y - padding - header - sectionGap, width: width + 2 * (padding + sectionGap), height: height + 2 * padding + header + 2 * sectionGap };
    const hit = others.filter((r) => r.x < region.x + region.width && r.x + r.width > region.x && r.y < region.y + region.height && r.y + r.height > region.y);
    if (!hit.length) break;
    y = Math.max(...hit.map((r) => r.y + r.height)) + sectionGap + padding + header;
  }
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
