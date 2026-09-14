/**
 * Copy and paste.
 *
 * Pasting HTML is a headline capability, not a convenience: the document model
 * *is* HTML, so markup copied from anywhere — a real site, an agent's output, a
 * code editor — becomes editable layers with its styles intact.
 */

import { useEffect } from 'react';
import { type CanvasNode, type NodeId, emitHtml, parseHtml, makeNode, defaultStylesFor } from '@playground/shared';
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

      const html = e.clipboardData?.getData('text/html');
      const plain = e.clipboardData?.getData('text/plain');
      if (!html && !plain) return;
      e.preventDefault();

      const target = resolvePasteTarget();
      if (!target) {
        useCanvas.getState().toast('Nowhere to paste — create an artboard first (press F).', 'error');
        return;
      }

      if (html) {
        const parsed = parseHtml(html);
        if (!parsed.nodes.length) return;
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
      // Cap the placed size so a 4000px screenshot does not dwarf the artboard.
      const scale = Math.min(1, 600 / Math.max(img.width, img.height));
      resolve({ width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { resolve({ width: 200, height: 200 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}
