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
import {
  copyProperties, duplicateSelection, nudge, pasteProperties, selectChildren,
  selectParent, selectSibling, toggleLock, toggleVisibility, wrapInFrame,
  zoomToFit, zoomToSelection,
} from './commands.ts';
import type { Tool } from '../state/store.ts';

const TOOL_KEYS: Record<string, Tool> = {
  v: 'move', h: 'hand', f: 'frame', a: 'frame', t: 'text',
  r: 'rect', o: 'ellipse', i: 'image', n: 'note',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function useKeyboard(onExport?: () => void): void {
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
      const { selection, dispatch, select, setTool, setViewport, viewport } = state;
      const doc = getDoc();
      const ids = topLevelSelection(selection);

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

      // --- Zoom and pan ----------------------------------------------------
      if (mod && e.key === '0') { e.preventDefault(); setViewport({ zoom: 1 }); return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setViewport({ zoom: Math.min(8, viewport.zoom * 1.25) }); return; }
      if (mod && e.key === '-') { e.preventDefault(); setViewport({ zoom: Math.max(0.02, viewport.zoom / 1.25) }); return; }
      if (!mod && e.key === '1') { e.preventDefault(); zoomToFit(); return; }
      if (!mod && e.key === '2') { e.preventDefault(); zoomToSelection(); return; }
      if (!mod && e.key === '3') { e.preventDefault(); zoomToSelection(); return; }

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
      if (e.key === 'Tab') { e.preventDefault(); selectSibling(e.shiftKey ? -1 : 1); return; }
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
        e.preventDefault();
        nudge(e.key, e.shiftKey ? 10 : 1);
        return;
      }

      // --- Tools ------------------------------------------------------------
      if (!mod && TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]!); return; }
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

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onExport]);
}

async function copyAsCss(): Promise<void> {
  const doc = getDoc();
  const { selection, toast } = useCanvas.getState();
  if (!doc || !selection.length) return;
  const { emitHtml } = await import('@canvas/shared');
  const css = selection.map((id) => emitHtml(doc, id, { mode: 'stylesheet', includeTokens: false }).css).join('\n\n');
  await navigator.clipboard.writeText(css);
  toast('Copied CSS', 'success');
}
