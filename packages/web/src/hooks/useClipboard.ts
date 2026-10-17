/**
 * Copy and paste.
 *
 * Pasting HTML is a headline capability, not a convenience: the document model
 * *is* HTML, so markup copied from anywhere — a real site, an agent's output, a
 * code editor — becomes editable layers with its styles intact.
 */

import { useEffect } from 'react';
import { type CanvasNode, type NodeId, emitHtml, parseHtml, makeNode, defaultStylesFor, isFigmaClipboard, decodeFigmaClipboard, figmaToHtml, DEFAULT_ARTBOARD_STYLES } from '@playground/shared';
import { useCanvas, getDoc, currentPage, topLevelSelection } from '../state/store.ts';

export function useClipboard(): void {
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };

    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const doc = getDoc();
      const { selection } = useCanvas.getState();
      if (!doc || !selection.length) return;

      const ids = topLevelSelection(selection);
      const html = ids.map((id) => emitHtml(doc, id, { mode: 'inline', includeTokens: false }).html).join('\n');
      const withVariants = ids
        .map((id) => emitHtml(doc, id, { mode: 'inline', includeTokens: false }))
        .filter((r) => r.css)
        .map((r) => r.css)
        .join('\n');

      e.clipboardData?.setData('text/html', withVariants ? `${html}\n<style>${withVariants}</style>` : html);
      e.clipboardData?.setData('text/plain', html);
      e.preventDefault();
      useCanvas.getState().toast(`Copied ${ids.length} layer${ids.length === 1 ? '' : 's'} as HTML`, 'success');
    };

    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const { selection, dispatch, select } = useCanvas.getState();
      if (!selection.length) return;
      onCopy(e);
      dispatch([{ t: 'remove', ids: topLevelSelection(selection) }]);
      select([]);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const doc = getDoc();
      const page = currentPage();
      if (!doc || !page) return;

      const files = [...(e.clipboardData?.items ?? [])]
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);

      if (files.length) { e.preventDefault(); void insertImages(files); return; }

      const plain = e.clipboardData?.getData('text/plain');
      // Figma's "Copy as SVG" (and most icon sites) put the markup in plain text.
      const svgText = plain && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(plain) ? plain : '';
      const html = svgText || e.clipboardData?.getData('text/html');
      if (!html && !plain) return;
      e.preventDefault();

      const target = resolvePasteTarget();
      if (!target) {
        useCanvas.getState().toast('Nowhere to paste — create an artboard first (press F).', 'error');
        return;
      }

      if (html) {
        // A normal Figma copy is Figma's own binary scene; decode it into
        // HTML first. If the format ever changes under us, fall back to the
        // hint to use Copy as SVG instead of failing the paste.
        let source = html;
        const notes: string[] = [];
        let fromFigma = false;
        if (!svgText && isFigmaClipboard(html)) {
          try {
            const figma = figmaToHtml(decodeFigmaClipboard(html).message);
            if (figma.html) { source = figma.html; notes.push(...figma.warnings); fromFigma = true; }
          } catch (err) {
            console.warn('Figma paste could not be read', err);
            notes.push("Couldn't read this Figma copy; try Copy as SVG (Ctrl Shift C).");
          }
        }
        const parsed = parseHtml(source);
        parsed.warnings.unshift(...notes);
        if (!parsed.nodes.length) {
          useCanvas.getState().toast(parsed.warnings[0] ?? 'Nothing to paste from that clipboard.', 'info');
          return;
        }

        // Figma frames pasted with nothing selected become artboards of their
        // own size, beside the others, as they would in Figma. Dropped into an
        // existing artboard a 1920 slide was cropped out of sight.
        const rootNodes = parsed.roots.map((id) => parsed.nodes.find((n) => n.id === id)!);
        if (fromFigma && useCanvas.getState().selection.length === 0 && rootNodes.every((n) => n.type === 'frame')) {
          let x = 0, y = 0;
          for (const id of page.artboards) {
            const a = doc.nodes[id];
            if (!a) continue;
            const right = Number(a.attrs['data-x'] ?? 0) + (parseFloat(a.styles.width ?? '') || 0);
            if (right + 120 > x) { x = right + 120; y = Number(a.attrs['data-y'] ?? 0); }
          }
          for (const root of rootNodes) {
            const { 'flex-shrink': _s, position: _p, left: _l, top: _t, ...own } = root.styles;
            root.type = 'artboard';
            root.styles = { ...DEFAULT_ARTBOARD_STYLES, ...own };
            root.attrs = { ...root.attrs, 'data-x': String(Math.round(x)), 'data-y': String(Math.round(y)) };
            x += (parseFloat(own.width ?? '') || 400) + 120;
          }
          useCanvas.getState().dispatch([{ t: 'insert', nodes: parsed.nodes, parent: null, index: page.artboards.length }]);
          useCanvas.getState().select(parsed.roots);
          const n = rootNodes.length;
          useCanvas.getState().toast(`Pasted ${n} frame${n === 1 ? '' : 's'} from Figma${parsed.warnings.length ? ` — ${parsed.warnings[0]}` : ''}`, parsed.warnings.length ? 'info' : 'success');
          return;
        }
        useCanvas.getState().dispatch([{
          t: 'insert',
          nodes: parsed.nodes,
          parent: target,
          index: doc.nodes[target]!.children.length,
        }]);
        useCanvas.getState().select(parsed.roots);
        const message = parsed.warnings.length
          ? `Pasted ${parsed.roots.length} layer${parsed.roots.length === 1 ? '' : 's'} — ${parsed.warnings[0]}`
          : `Pasted ${parsed.nodes.length} layers`;
        useCanvas.getState().toast(message, parsed.warnings.length ? 'info' : 'success');
        return;
      }

      const text = makeNode({
        type: 'text', tag: 'p', name: plain!.slice(0, 24),
        text: plain!, styles: { ...defaultStylesFor('text') },
      });
      useCanvas.getState().dispatch([{
        t: 'insert', nodes: [text], parent: target, index: doc.nodes[target]!.children.length,
      }]);
      useCanvas.getState().select([text.id]);
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}

/** Paste into the selected container, else its parent, else the first artboard. */
function resolvePasteTarget(): NodeId | null {
  const doc = getDoc();
  const page = currentPage();
  if (!doc || !page) return null;

  const { selection } = useCanvas.getState();
  for (const id of selection) {
    let node: CanvasNode | undefined = doc.nodes[id];
    while (node && (node.type === 'text' || node.type === 'image' || node.type === 'vector')) {
      node = node.parent ? doc.nodes[node.parent] : undefined;
    }
    if (node) return node.id;
  }
  return page.artboards[0] ?? null;
}

/**
 * Uploads images and puts them in the document.
 *
 * Shared by paste and by drag-and-drop, which differ only in where the result
 * lands: paste follows the selection, a drop follows the pointer.
 */
export async function insertImages(files: File[], target?: NodeId | null): Promise<void> {
  const { docId, dispatch, select, toast } = useCanvas.getState();
  const doc = getDoc();
  if (!docId || !doc) return;
  target = target ?? resolvePasteTarget();
  if (!target) return;

  const ids: NodeId[] = [];
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/documents/${docId}/assets`, { method: 'POST', body: form });
    if (!res.ok) {
      toast(`Could not upload ${file.name}: ${(await res.json().catch(() => ({ error: res.statusText }))).error}`, 'error');
      continue;
    }
    const { url } = (await res.json()) as { url: string };
    const size = await imageSize(file);
    const node = makeNode({
      type: 'image', tag: 'img', name: file.name,
      attrs: { src: url, alt: '' },
      styles: {
        ...defaultStylesFor('image'),
        width: `${size.width}px`,
        height: `${size.height}px`,
      },
    });
    dispatch([{ t: 'insert', nodes: [node], parent: target, index: getDoc()!.nodes[target]!.children.length }]);
    ids.push(node.id);
  }
  if (ids.length) { select(ids); toast(`Added ${ids.length} image${ids.length === 1 ? '' : 's'}`, 'success'); }
}

/** The natural size of an image file, so the node starts at the right shape. */
export { imageSize };

function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve(placedSize(img.width, img.height));
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { resolve({ width: 200, height: 200 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/**
 * The size an image lands at. Pasted and dropped images are almost always
 * high-density (Figma's Copy as PNG, retina screenshots), so they are placed at
 * half their pixel size and stay sharp; the file keeps every pixel. Tiny images
 * (icons under 32px) stay 1:1, and nothing lands wider or taller than 600.
 */
export function placedSize(w: number, h: number): { width: number; height: number } {
  const density = Math.min(w, h) >= 32 ? 2 : 1;
  const scale = Math.min(1 / density, 600 / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
