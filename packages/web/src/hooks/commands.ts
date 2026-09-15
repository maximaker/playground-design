/**
 * Editor commands.
 *
 * Shared by the keyboard shortcuts, the context menu and the toolbar, so every
 * action has exactly one implementation regardless of how it is invoked.
 */

import {
  type NodeId, type Op, type StyleMap,
  artboardOf, cloneSubtree, makeNode, defaultStylesFor, detachedNodes,
  getArtboardPosition, getArtboardSize, newId,
} from '@playground/shared';
import { useCanvas, getDoc, currentPage, topLevelSelection } from '../state/store.ts';
import { nodeInnerRect, nodeRect } from '../canvas/registry.ts';
import { parsePx } from '../canvas/styles.ts';

export function duplicateSelection(): void {
  const doc = getDoc();
  const { selection, dispatch, select } = useCanvas.getState();
  if (!doc || !selection.length) return;

  const ops: Op[] = [];
  const newIds: NodeId[] = [];
  for (const id of topLevelSelection(selection)) {
    const src = doc.nodes[id];
    if (!src) continue;
    const { nodes } = cloneSubtree(doc, id);
    const root = nodes[0]!;
    newIds.push(root.id);

    if (src.parent === null) {
      const pos = getArtboardPosition(src);
      root.attrs = { ...root.attrs, 'data-x': String(pos.x + 80), 'data-y': String(pos.y + 80) };
      root.name = `${src.name} copy`;
      const page = doc.pages.find((p) => p.artboards.includes(id)) ?? doc.pages[0]!;
      ops.push({ t: 'insert', nodes, parent: null, index: page.artboards.length, page: page.id });
    } else {
      // Offset absolutely-positioned copies so they do not hide under the original.
      if (src.styles.position === 'absolute') {
        root.styles = {
          ...root.styles,
          left: `${parsePx(src.styles.left) + 16}px`,
          top: `${parsePx(src.styles.top) + 16}px`,
        };
      }
      const index = doc.nodes[src.parent]!.children.indexOf(id) + 1;
      ops.push({ t: 'insert', nodes, parent: src.parent, index });
    }
  }
  if (ops.length) { dispatch(ops); select(newIds); }
}

export function wrapInFrame(): void {
  const doc = getDoc();
  const { selection, dispatch, select } = useCanvas.getState();
  if (!doc || !selection.length) return;

  const ids = topLevelSelection(selection);
  const first = doc.nodes[ids[0]!];
  if (!first?.parent) return;
  // Wrapping artboards is meaningless — they are page roots.
  if (ids.some((id) => doc.nodes[id]?.parent !== first.parent)) return;

  const frame = makeNode({
    type: 'frame',
    name: 'Group',
    styles: {
      ...defaultStylesFor('frame'),
      width: 'fit-content', height: 'fit-content',
      'background-color': 'transparent',
    },
  });
  const index = doc.nodes[first.parent]!.children.indexOf(ids[0]!);

  dispatch([
    { t: 'insert', nodes: [frame], parent: first.parent, index },
    { t: 'move', moves: ids.map((id, i) => ({ id, parent: frame.id, index: i })) },
  ]);
  select([frame.id]);
}

export function nudge(key: string, amount: number): void {
  const doc = getDoc();
  const { selection, dispatch } = useCanvas.getState();
  if (!doc) return;

  const dx = key === 'ArrowLeft' ? -amount : key === 'ArrowRight' ? amount : 0;
  const dy = key === 'ArrowUp' ? -amount : key === 'ArrowDown' ? amount : 0;

  const artboardMoves: { id: NodeId; attrs: Record<string, string> }[] = [];
  const styleMoves: { id: NodeId; styles: Record<string, string> }[] = [];

  for (const id of topLevelSelection(selection)) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.parent === null) {
      const pos = getArtboardPosition(node);
      artboardMoves.push({ id, attrs: { 'data-x': String(pos.x + dx), 'data-y': String(pos.y + dy) } });
    } else if (node.styles.position === 'absolute' || node.styles.position === 'fixed') {
      styleMoves.push({
        id,
        styles: { left: `${parsePx(node.styles.left) + dx}px`, top: `${parsePx(node.styles.top) + dy}px` },
      });
    } else {
      // In flex flow there is nothing to nudge; adjust margin instead, which is
      // what the user is actually reaching for.
      styleMoves.push({
        id,
        styles: {
          'margin-left': `${parsePx(node.styles['margin-left']) + dx}px`,
          'margin-top': `${parsePx(node.styles['margin-top']) + dy}px`,
        },
      });
    }
  }

  const ops: Op[] = [];
  if (artboardMoves.length) ops.push({ t: 'attrs', updates: artboardMoves });
  if (styleMoves.length) ops.push({ t: 'styles', updates: styleMoves });
  if (ops.length) dispatch(ops);
}

/**
 * Zoom about a point, keeping what is under it where it is.
 *
 * Setting the zoom alone scales about the canvas origin, so the thing you were
 * looking at slides off while you press the key — which is why every zoom that
 * is not a wheel gesture now goes through here. With no point given it holds
 * the centre of the stage, because that is where your attention is when you
 * are not pointing at anything.
 */
export function zoomBy(factor: number, at?: { x: number; y: number }): void {
  const { viewport, setViewport } = useCanvas.getState();
  const stage = document.querySelector('.stage')?.getBoundingClientRect();
  const point = at ?? (stage
    ? { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 });

  const zoom = Math.min(8, Math.max(0.02, viewport.zoom * factor));
  const k = zoom / viewport.zoom;
  setViewport({
    zoom,
    x: point.x - (point.x - viewport.x) * k,
    y: point.y - (point.y - viewport.y) * k,
  });
}

/** Back to 1:1, holding the centre of the stage. */
export function zoomTo(zoom: number): void {
  const { viewport } = useCanvas.getState();
  zoomBy(zoom / viewport.zoom);
}

export function zoomToFit(): void {
  const page = currentPage();
  const doc = getDoc();
  if (!page || !doc || !page.artboards.length) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of page.artboards) {
    const node = doc.nodes[id];
    if (!node) continue;
    const pos = getArtboardPosition(node);
    const w = parsePx(node.styles.width, 1440);
    const h = parsePx(node.styles.height, 900);
    minX = Math.min(minX, pos.x); minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + w); maxY = Math.max(maxY, pos.y + h);
  }
  if (!Number.isFinite(minX)) return;
  fitBox(minX, minY, maxX - minX, maxY - minY);
}

/**
 * From an instance to the component it came from.
 *
 * Selects the definition's root, which puts it in the inspector and makes the
 * Components panel show its layers and variants — the only place a definition
 * can be seen, since it belongs to no page. The panel is switched to for the
 * same reason: selecting something invisible and saying nothing would look like
 * nothing happened.
 */
export function openComponentOf(key: string | undefined): void {
  const doc = getDoc();
  if (!doc || !key) return;

  // The key may address a layer inside the instance; walk out to the instance
  // itself, then to whatever component it refers to.
  let node = doc.nodes[key.split('::')[0]!];
  while (node && node.type !== 'instance') node = node.parent ? doc.nodes[node.parent] : undefined;
  const def = node?.componentRef ? doc.components?.[node.componentRef] : undefined;
  if (!def) {
    useCanvas.getState().toast('That is not part of a component', 'error');
    return;
  }
  useCanvas.getState().select([def.root]);
  useCanvas.getState().requestPanel('components');
  useCanvas.getState().toast(`Editing ${def.name} — every instance follows this`, 'info');
}

export function zoomToSelection(): void {
  const { selection, selectedNote } = useCanvas.getState();

  // Prompt cards are selected separately from design nodes, but "zoom to what
  // I have selected" should mean the same thing either way.
  if (selectedNote) {
    const note = currentPage()?.notes?.find((n) => n.id === selectedNote);
    if (note) return fitBox(note.x, note.y, note.width, note.height);
  }

  if (!selection.length) return zoomToFit();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const vp = useCanvas.getState().viewport;
  for (const id of selection) {
    const r = nodeRect(id);
    if (!r) continue;
    // Screen rect back to canvas space.
    const x = (r.left - vp.x) / vp.zoom;
    const y = (r.top - vp.y) / vp.zoom;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + r.width / vp.zoom); maxY = Math.max(maxY, y + r.height / vp.zoom);
  }
  if (!Number.isFinite(minX)) return;
  fitBox(minX, minY, maxX - minX, maxY - minY);
}

/**
 * Bring the selection into view without changing the zoom.
 *
 * Different from zooming to it: after inserting a component you want to see
 * where the thing landed, at the size you were working at. Zooming would answer
 * a question nobody asked and lose your place on the canvas.
 *
 * Measured through the artboard rather than from the screen, because the thing
 * being revealed is usually *not* on screen — and an artboard that is off the
 * viewport is not rendered at all, so there is no element to measure. That is
 * exactly the case this exists for.
 */
export function revealSelection(): void {
  const { selection } = useCanvas.getState();
  const id = selection[0]?.split('::')[0];
  const doc = getDoc();
  if (!id || !doc) return;

  const artboardId = artboardOf(doc, id);
  const artboard = artboardId ? doc.nodes[artboardId] : null;
  if (!artboard) return;

  const place = () => {
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    if (!stage) return;
    const { viewport, setViewport } = useCanvas.getState();

    // The node's own box when its artboard is rendered; the artboard's
    // otherwise, which is the best that can be known and always enough to put
    // the work on screen.
    const pos = getArtboardPosition(artboard);
    const size = getArtboardSize(artboard);
    const inner = nodeInnerRect(id);
    const box = inner
      ? { x: pos.x + inner.left, y: pos.y + inner.top, width: inner.width, height: inner.height }
      : { x: pos.x, y: pos.y, width: size.width, height: size.height };

    const screenLeft = stage.left + viewport.x + box.x * viewport.zoom;
    const screenTop = stage.top + viewport.y + box.y * viewport.zoom;
    const screenRight = screenLeft + box.width * viewport.zoom;
    const screenBottom = screenTop + box.height * viewport.zoom;

    const margin = 60;
    const inside = screenLeft >= stage.left + margin && screenRight <= stage.right - margin
      && screenTop >= stage.top + margin && screenBottom <= stage.bottom - margin;
    if (inside) return false;

    setViewport({
      x: viewport.x + (stage.left + stage.width / 2 - (screenLeft + screenRight) / 2),
      y: viewport.y + (stage.top + stage.height / 2 - (screenTop + screenBottom) / 2),
    });
    return true;
  };

  // Once on the artboard, then again once it has rendered and the node itself
  // can be measured — which centres the layer rather than the screen it is on.
  const moved = place();
  if (moved) setTimeout(place, 220);
}

function fitBox(x: number, y: number, width: number, height: number): void {
  // Measure the stage rather than assuming panel widths: the rails are
  // responsive, so hardcoded offsets push content off-screen on narrow windows.
  const stage = document.querySelector('.stage')?.getBoundingClientRect();
  if (!stage) return;

  const padding = 64;
  const availableW = stage.width - padding * 2;
  const availableH = stage.height - padding * 2 - 60; // leave room for the toolbar
  const zoom = Math.min(4, Math.max(0.02, Math.min(
    availableW / Math.max(width, 1),
    availableH / Math.max(height, 1),
  )));

  useCanvas.getState().setViewport({
    zoom,
    x: stage.left + padding + (availableW - width * zoom) / 2 - x * zoom,
    y: stage.top + padding + (availableH - height * zoom) / 2 - y * zoom,
  });
}


// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Turns the selection into a component and replaces it with an instance.
 *
 * The definition's nodes are moved out of the page rather than copied, so the
 * thing on screen is the thing that was just made reusable — no silent divergence
 * between "the component" and "what I selected".
 */
export function createComponentFromSelection(): void {
  const doc = getDoc();
  const { selection, dispatch, select, toast } = useCanvas.getState();
  if (!doc || !selection.length) return;

  const ids = topLevelSelection(selection);
  if (ids.length !== 1) { toast('Select a single layer to turn into a component', 'error'); return; }

  const source = doc.nodes[ids[0]!];
  if (!source) return;
  if (source.type === 'artboard') { toast('Artboards cannot be components — select something inside one', 'error'); return; }
  if (source.type === 'instance') { toast('That is already a component instance', 'error'); return; }
  if (!source.parent) { toast('Select a layer inside an artboard', 'error'); return; }

  const name = window.prompt('Component name', source.name)?.trim();
  if (!name) return;

  const parent = source.parent;
  const index = doc.nodes[parent]!.children.indexOf(source.id);

  // The definition is a copy; the original is replaced by an instance so the
  // canvas keeps rendering the same pixels.
  const { nodes: definition } = cloneSubtree(doc, source.id);
  const root = definition[0]!;
  root.parent = null;
  root.name = name;

  const componentId = newId('cmp');
  const instance = makeNode({ type: 'instance', name, componentRef: componentId });

  dispatch([
    // Definition nodes live in the document but on no page, so they are not
    // drawn on the canvas and are not exported unless an instance uses them.
    { t: 'insert', nodes: definition, parent: null, index: 0, page: '__definitions__' },
    { t: 'component', action: 'add', component: { id: componentId, name, root: root.id } },
    { t: 'remove', ids: [source.id] },
    { t: 'insert', nodes: [instance], parent, index },
  ]);
  select([instance.id]);
  toast(`Created component "${name}"`, 'success');
}

/**
 * Move the selection one place along inside its parent.
 *
 * Nudging is the wrong tool for a layer in flex flow — there is no x to change,
 * so it writes a margin, which moves the thing without moving it in the layout.
 * What people mean by "move this up" inside a group is almost always its
 * position in the flow, and until now the only way to do that was to drag it in
 * the layer tree and hit a 4px drop zone.
 *
 * All four arrows map to earlier/later rather than only the parent's own axis:
 * a row and a column read differently to different people, and being forgiving
 * costs nothing when the wrong guess is one keystroke to undo.
 */
export function moveInParent(key: string): void {
  const doc = getDoc();
  const { selection, dispatch, toast } = useCanvas.getState();
  if (!doc) return;

  const delta = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  const ids = topLevelSelection(selection);
  const indexOfIn = (id: NodeId): number => {
    const parent = doc.nodes[id]?.parent;
    return parent ? doc.nodes[parent]!.children.indexOf(id) : -1;
  };

  // Moving later, the last one goes first — otherwise each move shifts the one
  // behind it and a multiple selection scrambles its own order.
  const ordered = [...ids].sort((a, b) => (indexOfIn(a) - indexOfIn(b)) * -delta);

  const moves: { id: NodeId; parent: NodeId; index: number }[] = [];
  let atEdge = 0;
  let unparented = 0;

  for (const id of ordered) {
    const node = doc.nodes[id];
    if (!node) continue;
    // An artboard's place in the page list is not where it sits on the canvas,
    // so reordering one would look like nothing happening.
    if (!node.parent) { unparented++; continue; }
    const siblings = doc.nodes[node.parent]!.children;
    const from = siblings.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= siblings.length) { atEdge++; continue; }
    moves.push({ id, parent: node.parent, index: to });
  }

  if (!moves.length) {
    if (unparented) toast('Artboards are placed on the canvas, not ordered in a parent', 'info');
    else if (atEdge) toast(delta < 0 ? 'Already first in its group' : 'Already last in its group', 'info');
    return;
  }
  dispatch([{ t: 'move', moves }]);
}

/**
 * Replace layers with an instance of a component.
 *
 * The gap this fills: a library grows *after* the screens do, so the common
 * case is a hand-built button sitting in a layout that should now be the
 * component. Rebuilding it meant deleting, inserting, and then dragging the new
 * instance back to where the old one was in the flow — three chances to get it
 * wrong for something that is one idea.
 *
 * On an instance this is a swap, which is the same operation seen from the
 * other side: the props that both components declare come across, and
 * overrides do not, because they are keyed to layers of the definition being
 * left behind and would land on whatever happened to share an id.
 */
export function replaceWithComponent(componentId: string, targetIds?: NodeId[]): void {
  const doc = getDoc();
  const { selection, dispatch, select, toast } = useCanvas.getState();
  if (!doc) return;

  const def = doc.components?.[componentId];
  if (!def) { toast('That component no longer exists', 'error'); return; }

  const inside = (id: NodeId, rootId: NodeId): boolean => {
    let current: NodeId | null | undefined = id;
    while (current) {
      if (current === rootId) return true;
      current = doc.nodes[current]?.parent ?? null;
    }
    return false;
  };

  const ops: Op[] = [];
  const made: NodeId[] = [];
  let skipped = 0;
  let swapped = 0;

  for (const id of targetIds ?? topLevelSelection(selection)) {
    const node = doc.nodes[id];
    if (!node || !node.parent) { skipped++; continue; }
    // A component cannot contain itself: replacing one of its own layers with
    // an instance of it is a loop the renderer would have to cut anyway.
    if (inside(id, def.root)) { skipped++; continue; }

    const index = doc.nodes[node.parent]!.children.indexOf(id);
    const carried = node.type === 'instance'
      ? Object.fromEntries(Object.entries(node.props ?? {})
        .filter(([k]) => def.props?.some((p) => p.name === k)))
      : {};
    if (node.type === 'instance') swapped++;

    const instance = makeNode({
      type: 'instance',
      name: def.name,
      componentRef: componentId,
      // How it sat among its siblings belongs to the layout, not to the thing
      // that was there: a card that filled its column should still fill it.
      // Its own size and looks are the component's business now.
      styles: Object.fromEntries(
        Object.entries(node.styles).filter(([k]) => PLACEMENT.has(k)),
      ),
      ...(Object.keys(carried).length ? { props: carried } : {}),
    });

    ops.push({ t: 'remove', ids: [id] });
    ops.push({ t: 'insert', nodes: [instance], parent: node.parent, index });
    made.push(instance.id);
  }

  if (!made.length) {
    toast(skipped ? 'Nothing there can be replaced by that component' : 'Select a layer to replace', 'error');
    return;
  }
  dispatch(ops);
  select(made);
  revealSelection();
  toast(
    `${swapped === made.length ? 'Swapped' : 'Replaced'} ${made.length === 1 ? 'a layer' : `${made.length} layers`} with "${def.name}"`
    + (skipped ? ` · ${skipped} skipped` : ''),
    'success',
  );
}

/** Where a layer sits among its siblings, as opposed to what it looks like. */
const PLACEMENT = new Set([
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'align-self', 'justify-self', 'order', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis',
  'grid-area', 'grid-column', 'grid-row',
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
]);

/** Converts instances back into ordinary layers, baking in their overrides. */
export function detachSelection(): void {
  const doc = getDoc();
  const { selection, dispatch, select, toast } = useCanvas.getState();
  if (!doc) return;

  const ops: Op[] = [];
  const newRoots: NodeId[] = [];

  for (const id of topLevelSelection(selection)) {
    const instance = doc.nodes[id];
    if (instance?.type !== 'instance' || !instance.parent) continue;

    const nodes = detachedNodes(doc, instance, () => newId());
    if (!nodes.length) continue;
    const root = nodes.find((n) => n.parent === instance.parent)!;
    const index = doc.nodes[instance.parent]!.children.indexOf(id);

    ops.push({ t: 'remove', ids: [id] });
    ops.push({ t: 'insert', nodes, parent: instance.parent, index });
    newRoots.push(root.id);
  }

  if (!ops.length) { toast('Select a component instance to detach', 'error'); return; }
  dispatch(ops);
  select(newRoots);
  toast('Detached from component', 'success');
}

// ---------------------------------------------------------------------------
// Style clipboard
// ---------------------------------------------------------------------------

/**
 * Copy/paste properties, the fastest way to make one thing look like another.
 * Layout-affecting properties are deliberately excluded: pasting a width and a
 * position along with a colour is almost never what is wanted.
 */
let styleClipboard: StyleMap | null = null;

const NON_TRANSFERABLE = new Set([
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'left', 'top', 'right', 'bottom', 'position', 'flex', 'flex-grow', 'flex-basis',
]);

export function copyProperties(): void {
  const doc = getDoc();
  const { selection, toast } = useCanvas.getState();
  const node = selection.length === 1 ? doc?.nodes[selection[0]!] : undefined;
  if (!node) { toast('Select a single layer to copy its properties', 'error'); return; }

  styleClipboard = Object.fromEntries(
    Object.entries(node.styles).filter(([k]) => !NON_TRANSFERABLE.has(k)),
  );
  toast(`Copied ${Object.keys(styleClipboard).length} properties`, 'success');
}

export function pasteProperties(): void {
  const { selection, dispatch, toast } = useCanvas.getState();
  if (!styleClipboard) { toast('No properties copied yet', 'error'); return; }
  if (!selection.length) return;
  dispatch([{ t: 'styles', updates: selection.map((id) => ({ id, styles: styleClipboard! })) }]);
  toast(`Applied properties to ${selection.length} layer${selection.length === 1 ? '' : 's'}`, 'success');
}

// ---------------------------------------------------------------------------
// Selection navigation
// ---------------------------------------------------------------------------

export function selectParent(): void {
  const doc = getDoc();
  const { selection, select } = useCanvas.getState();
  const parents = selection.map((id) => doc?.nodes[id]?.parent).filter((p): p is NodeId => !!p);
  if (parents.length) select([...new Set(parents)]);
}

export function selectChildren(): void {
  const doc = getDoc();
  const { selection, select } = useCanvas.getState();
  const children = selection.flatMap((id) => doc?.nodes[id]?.children ?? []);
  if (children.length) select(children);
}

/** Cycles to the next or previous sibling, matching Tab / Shift-Tab in Figma. */
export function selectSibling(direction: 1 | -1): void {
  const doc = getDoc();
  const page = currentPage();
  const { selection, select } = useCanvas.getState();
  const id = selection[0];
  if (!doc || !id) return;

  const node = doc.nodes[id];
  if (!node) return;
  const siblings = node.parent ? doc.nodes[node.parent]?.children : page?.artboards;
  if (!siblings?.length) return;

  const index = siblings.indexOf(id);
  const next = siblings[(index + direction + siblings.length) % siblings.length];
  if (next) select([next]);
}

export function toggleVisibility(): void {
  const doc = getDoc();
  const { selection, dispatch } = useCanvas.getState();
  if (!selection.length) return;
  dispatch([{ t: 'meta', updates: selection.map((id) => ({ id, visible: !(doc?.nodes[id]?.visible ?? true) })) }]);
}

export function toggleLock(): void {
  const doc = getDoc();
  const { selection, dispatch } = useCanvas.getState();
  if (!selection.length) return;
  dispatch([{ t: 'meta', updates: selection.map((id) => ({ id, locked: !(doc?.nodes[id]?.locked ?? false) })) }]);
}
