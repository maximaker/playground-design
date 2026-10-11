/**
 * Versions: which page or section is current, and which were superseded.
 *
 * A page and a section carry the same small record (model.ts `VersionState`).
 * This module finds either by id, builds the op that changes it, and describes
 * it for agents, so the Pages panel and the MCP say the same thing.
 */

import type { CanvasDocument, Page, Section, VersionKind, VersionState } from './model.ts';
import type { Op } from './ops.ts';

export type VersionTarget =
  | { kind: 'page'; page: Page }
  | { kind: 'section'; page: Page; section: Section };

export function findVersionTarget(doc: CanvasDocument, id: string): VersionTarget | null {
  for (const page of doc.pages) {
    if (page.id === id) return { kind: 'page', page };
    const section = page.sections?.find((s) => s.id === id);
    if (section) return { kind: 'section', page, section };
  }
  return null;
}

export function versionOf(target: VersionTarget): VersionState | null {
  return (target.kind === 'page' ? target.page.version : target.section.version) ?? null;
}

export function targetTitle(target: VersionTarget): string {
  return target.kind === 'page' ? target.page.name : target.section.title;
}

/**
 * The current item a superseded one most likely gave way to: the current page,
 * or the current section on the same page. Null when there is none, or several.
 */
export function likelyReplacement(doc: CanvasDocument, target: VersionTarget): string | null {
  const candidates = target.kind === 'page'
    ? doc.pages.filter((p) => p.id !== target.page.id && p.version?.state === 'current').map((p) => p.id)
    : (target.page.sections ?? []).filter((s) => s.id !== target.section.id && s.version?.state === 'current').map((s) => s.id);
  return candidates.length === 1 ? candidates[0]! : null;
}

export interface VersionInput {
  /** null clears the state. */
  state: VersionKind | null;
  reason?: string;
  replacedBy?: string;
}

/** The op that sets a page's or section's version. Throws on a bad `replacedBy`. */
export function versionOps(doc: CanvasDocument, target: VersionTarget, input: VersionInput, now = new Date()): Op[] {
  let version: VersionState | null = null;
  if (input.state) {
    const replacedBy = input.state === 'superseded'
      ? input.replacedBy ?? likelyReplacement(doc, target) ?? undefined
      : undefined;
    if (replacedBy) {
      const to = findVersionTarget(doc, replacedBy);
      if (!to) throw new Error(`replacedBy: no page or section "${replacedBy}"`);
      if (to.kind === 'page' ? to.page.id === idOf(target) : to.section.id === idOf(target)) {
        throw new Error('replacedBy: an item cannot replace itself');
      }
    }
    version = {
      state: input.state,
      ...(input.state === 'superseded' && input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      ...(replacedBy ? { replacedBy } : {}),
      at: now.toISOString().slice(0, 10),
    };
  }
  if (target.kind === 'page') return [{ t: 'page', action: 'version', page: { ...target.page, version } }];
  return [{ t: 'section', action: 'update', pageId: target.page.id, section: { id: target.section.id, version } }];
}

export function idOf(target: VersionTarget): string {
  return target.kind === 'page' ? target.page.id : target.section.id;
}

/** A version as agents read it: state, why, and the title of what replaced it. */
export function describeVersion(doc: CanvasDocument, version: VersionState | null | undefined) {
  if (!version) return undefined;
  const to = version.replacedBy ? findVersionTarget(doc, version.replacedBy) : null;
  return {
    state: version.state,
    ...(version.reason ? { reason: version.reason } : {}),
    ...(version.replacedBy ? { replacedBy: { id: version.replacedBy, title: to ? targetTitle(to) : null, kind: to?.kind ?? null } } : {}),
    ...(version.at ? { at: version.at } : {}),
  };
}
