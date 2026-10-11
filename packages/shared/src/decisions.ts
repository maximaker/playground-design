/**
 * The decisions log.
 *
 * Client work runs on decisions — "we keep the lime CTA", "drop the second
 * step" — and they used to vanish into resolved threads nobody reopens. Closing
 * a thread can now record its outcome in one line, and those lines collect into
 * a document-level log with who, when, and the thread or layer it came from.
 */

import { type CanvasDocument, type Comment, type Decision, artboardOf, newId } from './model.ts';
import type { Op } from './ops.ts';

/** Oldest first: a log reads in the order things were decided. */
export function decisionsOf(doc: CanvasDocument): Decision[] {
  return [...(doc.decisions ?? [])].sort((a, b) => a.at - b.at);
}

export function decisionForComment(doc: CanvasDocument, commentId: string): Decision | undefined {
  return (doc.decisions ?? []).find((d) => d.commentId === commentId);
}

export function addDecisionOps(
  input: { text: string; by: string; nodeId?: string; pageId?: string; commentId?: string; at?: number },
): Op[] {
  const text = input.text.trim();
  if (!text) throw new Error('A decision needs some text.');
  const decision: Decision = {
    id: newId('dec'),
    text,
    by: input.by,
    at: input.at ?? Date.now(),
    ...(input.commentId ? { commentId: input.commentId } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.pageId ? { pageId: input.pageId } : {}),
  };
  return [{ t: 'decision', action: 'add', decision }];
}

/**
 * Resolve a thread, recording its outcome as a decision when one is given. A
 * thread that already has a decision has it replaced, so re-resolving with a
 * corrected outcome does not leave two answers in the log.
 */
export function resolveWithOutcomeOps(doc: CanvasDocument, comment: Comment, outcome: string | undefined, by: string): Op[] {
  const ops: Op[] = [{ t: 'comment', action: 'update', comment: { id: comment.id, resolved: true } }];
  if (!outcome?.trim()) return ops;
  const existing = decisionForComment(doc, comment.id);
  if (existing) ops.push({ t: 'decision', action: 'remove', decision: existing });
  ops.push(...addDecisionOps({ text: outcome, by, commentId: comment.id, nodeId: comment.nodeId, pageId: comment.pageId }));
  return ops;
}

/** A decision as agents and exports read it. */
export function describeDecision(doc: CanvasDocument, d: Decision) {
  const comment = d.commentId ? (doc.comments ?? []).find((c) => c.id === d.commentId) : undefined;
  const node = d.nodeId ? doc.nodes[d.nodeId] : undefined;
  const page = doc.pages.find((p) => p.id === d.pageId);
  const board = d.nodeId && node ? artboardOf(doc, d.nodeId) : null;
  return {
    id: d.id,
    decision: d.text,
    by: d.by,
    date: new Date(d.at).toISOString().slice(0, 10),
    ...(d.commentId ? { thread: comment ? { id: d.commentId, text: comment.text, author: comment.author } : { id: d.commentId, deleted: true } } : {}),
    ...(d.nodeId ? { node: node ? { id: d.nodeId, name: node.name, artboard: board ? doc.nodes[board]?.name ?? null : null } : { id: d.nodeId, deleted: true } } : {}),
    ...(page ? { page: { id: page.id, name: page.name } } : {}),
  };
}

/** The log as Markdown, for handoff and the export panel. */
export function decisionsMarkdown(doc: CanvasDocument): string {
  const rows = decisionsOf(doc).map((d) => describeDecision(doc, d));
  const lines = [`# Decisions — ${doc.name}`, ''];
  if (!rows.length) lines.push('_No decisions recorded yet._');
  for (const r of rows) {
    const where = [
      r.page && `page "${r.page.name}"`,
      r.node && !('deleted' in r.node) && `layer "${r.node.name}"`,
      r.thread && !('deleted' in r.thread) && `thread: “${r.thread.text.slice(0, 80)}”`,
    ].filter(Boolean).join(' · ');
    lines.push(`- **${r.date}** — ${r.decision} _(${r.by})_${where ? `  \n  ${where}` : ''}`);
  }
  return lines.join('\n') + '\n';
}
