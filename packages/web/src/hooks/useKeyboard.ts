/**
 * Global keyboard shortcuts.
 *
 * Bindings follow Figma wherever Figma has one, because that is the muscle
 * memory this tool's users arrive with. Every command lives in commands.ts so
 * the context menu invokes exactly the same code path.
 */

import { useEffect } from 'react';
import { useCanvas, getDoc, currentPage, topLevelSelection } from '../state/store.ts';
import { reorder } from '../canvas/arrange.ts';
import { artboardOf } from '@playground/shared';
import {
  copyProperties, duplicateSelection, moveInParent, nudge, pasteProperties, selectChildren,
  selectParent, selectSibling, toggleLock, toggleVisibility, wrapInFrame,
  zoomBy, zoomTo, zoomToFit, zoomToSelection,
} from './commands.ts';
import type { Tool } from '../state/store.ts';

const TOOL_KEYS: Record<string, Tool> = {
  v: 'move', h: 'hand', f: 'frame', a: 'frame', t: 'text',
  r: 'rect', o: 'ellipse', i: 'image', n: 'note', c: 'comment',
};

/** True when the keystroke belongs to the canvas rather than to the chrome. */
function onCanvas(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  return !!el.closest?.('.stage');
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export interface KeyboardActions {
  onExport?: () => void;
  onShortcuts?: () => void;
  onPalette?: () => void;
}

export function useKeyboard(actions: KeyboardActions = {}): void {
  const { onExport, onShortcuts, onPalette } = actions;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useCanvas.getState();

      if (e.key === ' ' && !isTyping(e.target) && !state.spacePanning) {
        state.setSpacePanning(true);
        e.preventDefault();
        return;
      }
      if (isTyping(e.target)) return;

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const { selection, dispatch, select, setTool } = state;
      const doc = getDoc();
      const ids = topLevelSelection(selection);

      // --- Palette ---------------------------------------------------------
      if (mod && key === 'k') { e.preventDefault(); onPalette?.(); return; }

      // --- History ---------------------------------------------------------
      if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? state.redo() : state.undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); state.redo(); return; }

      // --- Structure -------------------------------------------------------
      if (mod && key === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (mod && key === 'g') { e.preventDefault(); wrapInFrame(); return; }
      if (mod && e.shiftKey && key === 'g') {
        // Ungroup: lift children into the grandparent, then drop the wrapper.
        e.preventDefault();
        if (!doc) return;
        const ops = ids.flatMap((id) => {
          const node = doc.nodes[id];
          if (!node?.parent || !node.children.length) return [];
          const index = doc.nodes[node.parent]!.children.indexOf(id);
          return [
            { t: 'move' as const, moves: node.children.map((c, i) => ({ id: c, parent: node.parent, index: index + i })) },
            { t: 'remove' as const, ids: [id] },
          ];
        });
        if (ops.length) dispatch(ops);
        return;
      }

      if (mod && key === 'a') {
        e.preventDefault();
        const page = currentPage();
        if (page && doc) {
          // Select artboard contents rather than the artboards themselves: on a
          // canvas, "everything" means the work, not the frames around it.
          const contents = page.artboards.flatMap((a) => doc.nodes[a]?.children ?? []);
          select(contents.length ? contents : page.artboards);
        }
        return;
      }

      // --- Style clipboard -------------------------------------------------
      if (mod && e.altKey && key === 'c') { e.preventDefault(); copyProperties(); return; }
      if (mod && e.altKey && key === 'v') { e.preventDefault(); pasteProperties(); return; }
      if (mod && e.shiftKey && key === 'c') {
        e.preventDefault();
        void copyAsCss();
        return;
      }

      // --- Z-order ---------------------------------------------------------
      if (!mod && (e.key === ']' || e.key === '[') && doc && ids.length) {
        e.preventDefault();
        dispatch(reorder(doc, ids, e.key === ']' ? 'front' : 'back'));
        return;
      }
      if (mod && (e.key === ']' || e.key === '[') && doc && ids.length) {
        e.preventDefault();
        dispatch(reorder(doc, ids, e.key === ']' ? 'forward' : 'backward'));
        return;
      }

      // --- Visibility and locking ------------------------------------------
      if (mod && e.shiftKey && key === 'h') { e.preventDefault(); toggleVisibility(); return; }
      if (mod && e.shiftKey && key === 'l') { e.preventDefault(); toggleLock(); return; }

      // --- Export ----------------------------------------------------------
      if (mod && e.shiftKey && key === 'e') { e.preventDefault(); onExport?.(); return; }

      // --- Present ---------------------------------------------------------
      if (!mod && key === 'p') {
        e.preventDefault();
        const doc = getDoc();
        const page = currentPage();
        if (page?.artboards.length && doc) {
          const selected = selection[0]?.split('::')[0];
          const board = selected ? artboardOf(doc, selected) : null;
          state.setPresent({
            pageId: page.id,
            index: board ? Math.max(0, page.artboards.indexOf(board)) : 0,
          });
        } else state.toast('This page has no frames to present', 'error');
        return;
      }

      // --- Rename ----------------------------------------------------------
      if (e.key === 'F2' && selection.length === 1) {
        e.preventDefault();
        state.requestPanel('layers');
        state.setRenaming(selection[0]!.split('::')[0]!);
        return;
      }

      /*
       * --- Zoom and pan ----------------------------------------------------
       *
       * Unmodified `+` and `-`, which is what Figma binds and for the same
       * reason: a browser does not let a page have ⌘+ and ⌘−. Chrome zooms the
       * whole window before the page ever sees the key, so the handler below
       * that tries to claim them is best-effort on the browsers where it works
       * — these are the ones that always reach the canvas.
       */
      if (!mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(1.25); return; }
      if (!mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomBy(1 / 1.25); return; }
      if (!mod && e.shiftKey && e.code === 'Digit0') { e.preventDefault(); zoomTo(1); return; }

      // Both spellings: the bare digits this tool started with, and Figma's
      // shifted ones, which is what a hand arriving from Figma will press.
      if (!mod && (e.key === '1' || e.key === '!')) { e.preventDefault(); zoomToFit(); return; }
      if (!mod && (e.key === '2' || e.key === '@')) { e.preventDefault(); zoomToSelection(); return; }
      if (!mod && (e.key === '3' || e.key === '#')) { e.preventDefault(); zoomToSelection(); return; }

      // --- Selection navigation --------------------------------------------
      if (e.key === 'Enter' && !mod) {
        e.preventDefault();
        const node = selection.length === 1 ? doc?.nodes[selection[0]!] : undefined;
        if (node?.type === 'text') state.setEditingText(node.id);
        else selectChildren();
        return;
      }
      if (e.key === 'Escape') {
        if (state.editingText) state.setEditingText(null);
        else if (state.tool !== 'move') setTool('move');
        else if (selection.length) selectParent();
        return;
      }
      /*
       * Tab selects the next sibling *on the canvas*, and is left alone
       * everywhere else.
       *
       * It used to be taken globally, which meant the interface could not be
       * traversed by keyboard at all: every press was swallowed before it
       * reached a panel, so nothing in the rails could be focused, and the
       * focus ring drawn for everything was unreachable in practice.
       *
       * A selection is the second condition, and it is what makes the two
       * meanings coexist: with something selected on the canvas, Tab walks the
       * siblings the way a design tool should; with nothing selected, or with
       * focus already in a panel, it traverses the interface the way the
       * platform should.
       */
      if (e.key === 'Tab' && selection.length && onCanvas(e.target)) {
        e.preventDefault();
        selectSibling(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === '\\' && !mod) { e.preventDefault(); selectParent(); return; }

      // --- Delete and nudge -------------------------------------------------
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!ids.length) return;
        e.preventDefault();
        dispatch([{ t: 'remove', ids }]);
        select([]);
        return;
      }
      if (e.key.startsWith('Arrow') && selection.length) {
        // With the modifier, move the layer along inside its parent instead of
        // nudging it: in flex flow there is no position to nudge, and its place
        // in the flow is what "move it up" means there. That one works wherever
        // you are, because it is about the document rather than the canvas.
        if (mod) { e.preventDefault(); moveInParent(e.key); return; }
        // Plain arrows nudge only on the canvas. In the layer tree they walk
        // the tree, and a panel that has the focus should get its own keys.
        if (onCanvas(e.target)) { e.preventDefault(); nudge(e.key, e.shiftKey ? 10 : 1); }
        return;
      }

      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); onShortcuts?.(); return; }

      // --- Tools ------------------------------------------------------------
      if (!mod && TOOL_KEYS[key]) {
        // Prevented, because a tool can open something that takes focus: `c`
        // opens a comment composer on the selection, and without this the `c`
        // itself was the first character of the comment.
        e.preventDefault();
        setTool(TOOL_KEYS[key]!);
        return;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') useCanvas.getState().setSpacePanning(false);
      if (e.key === 'Alt') useCanvas.getState().setMeasureTo(null);
    };

    // A dropped focus (alt-tab mid-pan) would otherwise leave space stuck down.
    const onBlur = () => {
      useCanvas.getState().setSpacePanning(false);
      useCanvas.getState().setMeasureTo(null);
    };

    /**
     * Zoom is caught in the capture phase, before anything can swallow it.
     *
     * Text inputs stop propagation on keydown so that editor shortcuts do not
     * fire mid-word — correct, but it also meant Cmd-plus never reached the
     * window and the *browser* zoomed instead. Browser zoom shrinks the CSS
     * viewport, which trips the responsive layout and takes the side panels
     * with it; since the document name is an input and so is every property
     * field, that was most of the interface. Capture runs before any of them,
     * so this cannot be intercepted by a component again.
     */
    const onZoom = (e: KeyboardEvent) => {
      // No isTyping guard on purpose: this runs in the capture phase precisely
      // so a focused field cannot swallow it and leave the browser to zoom.
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === '0') { e.preventDefault(); zoomTo(1); }
      else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1.25); }
      else if (e.key === '-') { e.preventDefault(); zoomBy(1 / 1.25); }
      else return;
      // Handled here; the bubble listener must not act on it a second time.
      e.stopPropagation();
    };
    window.addEventListener('keydown', onZoom, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onZoom, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onExport, onShortcuts, onPalette]);
}

async function copyAsCss(): Promise<void> {
  const doc = getDoc();
  const { selection, toast } = useCanvas.getState();
  if (!doc || !selection.length) return;
  const { emitHtml } = await import('@playground/shared');
  const css = selection.map((id) => emitHtml(doc, id, { mode: 'stylesheet', includeTokens: false }).css).join('\n\n');
  await navigator.clipboard.writeText(css);
  toast('Copied CSS', 'success');
}
