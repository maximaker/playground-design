/**
 * Registry of live artboard iframes.
 *
 * The overlay, hit-testing, measurement and the agent RPC handlers all need to
 * get from a node id to the real DOM element rendering it, which lives inside
 * one of the artboard iframes rather than in the editor's own document.
 */

import type { NodeId } from '@playground/shared';

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


/**
 * The element rendering a node, inside one document.
 *
 * An instance renders its component's definition, so the element carries the
 * *expanded* key — `instance::definitionNode` — and never the instance's own
 * id. Clicking the canvas reads that key straight off the DOM, so canvas
 * selections matched; every other way of naming a layer (the layer tree, the
 * spec, an agent, reveal) says the instance id and found nothing. The result
 * was that selecting an instance in the sidebar drew no selection on the
 * canvas at all, which read as a broken click.
 *
 * So: exact match first, then the root of that instance's expansion — the one
 * matching element that none of the others contain.
 */
function queryNode(doc: Document, nodeId: NodeId): HTMLElement | null {
  const exact = doc.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
  if (exact) return exact;
  // Only bare ids can be instance roots; a key is already fully qualified.
  if (nodeId.includes('::')) return null;
  const parts = [...doc.querySelectorAll<HTMLElement>(`[data-node-id^="${CSS.escape(nodeId)}::"]`)];
  if (!parts.length) return null;
  return parts.find((el) => !parts.some((other) => other !== el && other.contains(el))) ?? null;
}

/** Finds the DOM element rendering a node, searching every mounted artboard. */
export function findElement(nodeId: NodeId): HTMLElement | null {
  for (const [, frame] of frames) {
    const doc = frame.contentDocument;
    const el = doc ? queryNode(doc, nodeId) : null;
    if (el) return el;
  }
  return null;
}

export function findElementIn(artboardId: NodeId, nodeId: NodeId): HTMLElement | null {
  const doc = frames.get(artboardId)?.contentDocument;
  return doc ? queryNode(doc, nodeId) : null;
}

/**
 * Rect of a node in editor viewport coordinates, accounting for the iframe's
 * own position and the canvas zoom transform applied to its wrapper.
 */
export function nodeRect(nodeId: NodeId): DOMRect | null {
  for (const [, frame] of frames) {
    const el = frame.contentDocument ? queryNode(frame.contentDocument, nodeId) : null;
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
    const el = frame.contentDocument ? queryNode(frame.contentDocument, nodeId) : null;
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
