/**
 * Registry of live artboard iframes.
 *
 * The overlay, hit-testing, measurement and the agent RPC handlers all need to
 * get from a node id to the real DOM element rendering it, which lives inside
 * one of the artboard iframes rather than in the editor's own document.
 */

import type { NodeId } from '@canvas/shared';

const frames = new Map<NodeId, HTMLIFrameElement>();

export function registerFrame(artboardId: NodeId, el: HTMLIFrameElement | null): void {
  if (el) frames.set(artboardId, el);
  else frames.delete(artboardId);
}

export function getFrame(artboardId: NodeId): HTMLIFrameElement | undefined {
  return frames.get(artboardId);
}

export function allFrames(): [NodeId, HTMLIFrameElement][] {
  return [...frames.entries()];
}

/** Finds the DOM element rendering a node, searching every mounted artboard. */
export function findElement(nodeId: NodeId): HTMLElement | null {
  for (const [, frame] of frames) {
    const el = frame.contentDocument?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (el) return el;
  }
  return null;
}

export function findElementIn(artboardId: NodeId, nodeId: NodeId): HTMLElement | null {
  const doc = frames.get(artboardId)?.contentDocument;
  return doc?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`) ?? null;
}

/**
 * Rect of a node in editor viewport coordinates, accounting for the iframe's
 * own position and the canvas zoom transform applied to its wrapper.
 */
export function nodeRect(nodeId: NodeId): DOMRect | null {
  for (const [, frame] of frames) {
    const el = frame.contentDocument?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!el) continue;
    const inner = el.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    // The wrapper is scaled, so the iframe's own CSS pixels are scaled too.
    const scale = frameRect.width / (frame.offsetWidth || frameRect.width || 1);
    return new DOMRect(
      frameRect.left + inner.left * scale,
      frameRect.top + inner.top * scale,
      inner.width * scale,
      inner.height * scale,
    );
  }
  return null;
}

/**
 * Rect of a node in its own CSS pixels — the iframe's coordinate system, which
 * the canvas zoom transform does not affect. This is what style values are in,
 * so it is what resizing and measurement must work from; `nodeRect` returns
 * editor screen coordinates instead and is for drawing chrome.
 */
export function nodeInnerRect(nodeId: NodeId): DOMRect | null {
  for (const [, frame] of frames) {
    const el = frame.contentDocument?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (el) return el.getBoundingClientRect();
  }
  return null;
}

/** The node under a viewport point, deepest first. */
export function hitTest(clientX: number, clientY: number): { artboardId: NodeId; nodeId: NodeId } | null {
  for (const [artboardId, frame] of frames) {
    const rect = frame.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const doc = frame.contentDocument;
    if (!doc) continue;

    const scale = rect.width / (frame.offsetWidth || rect.width || 1);
    const x = (clientX - rect.left) / scale;
    const y = (clientY - rect.top) / scale;

    const el = doc.elementFromPoint(x, y) as HTMLElement | null;
    const target = el?.closest<HTMLElement>('[data-node-id]');
    if (target?.dataset.nodeId) return { artboardId, nodeId: target.dataset.nodeId };
    return { artboardId, nodeId: artboardId };
  }
  return null;
}
