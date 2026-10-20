/** Puts a 3-minute countdown in the middle of the selected (or first) slide. */

import { artboardOf, makeTimerNode } from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';

export function insertTimer(): void {
  const state = useCanvas.getState();
  const doc = getDoc();
  if (!doc || state.readOnly) return;
  const fromSelection = state.selection[0] ? artboardOf(doc, state.selection[0].split('::')[0]!) : null;
  const page = doc.pages.find((p) => p.id === state.pageId) ?? doc.pages[0];
  const artboardId = fromSelection ?? page?.artboards[0];
  const artboard = artboardId ? doc.nodes[artboardId] : undefined;
  if (!artboard) { state.toast('Add a frame first: a timer goes on a slide.', 'error'); return; }
  const node = makeTimerNode({ seconds: 180 }, { artboard });
  state.dispatch([{ t: 'insert', nodes: [node], parent: artboard.id, index: artboard.children.length }]);
  state.select([node.id]);
}
