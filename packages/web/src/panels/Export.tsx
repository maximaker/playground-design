/**
 * Export panel: the design already is code, so this is mostly a copy button.
 */

import { useMemo, useState } from 'react';
import { emitJsx, emitHtml, emitStandalone } from '@playground/shared';
import { useCanvas, getDoc } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

type Format = 'jsx-tailwind' | 'jsx-inline' | 'html' | 'css' | 'standalone';

const FORMATS: { value: Format; label: string }[] = [
  { value: 'jsx-tailwind', label: 'JSX + Tailwind' },
  { value: 'jsx-inline', label: 'JSX + inline styles' },
  { value: 'html', label: 'HTML + CSS' },
  { value: 'css', label: 'CSS only' },
  { value: 'standalone', label: 'Standalone page' },
];

export function Export({ onClose }: { onClose: () => void }) {
  const selection = useCanvas((s) => s.selection);
  const version = useCanvas((s) => s.version);
  const docId = useCanvas((s) => s.docId);
  const toast = useCanvas((s) => s.toast);
  const [format, setFormat] = useState<Format>('jsx-tailwind');
  const [imageFormat, setImageFormat] = useState('png');
  const [scale, setScale] = useState(2);

  /**
   * Batch export. Downloads are triggered one at a time with a small gap —
   * browsers silently drop a burst of simultaneous download navigations.
   */
  const downloadAll = async () => {
    for (const id of selection) {
      const a = document.createElement('a');
      a.href = `/api/documents/${docId}/export/${id}?format=${imageFormat}&scale=${scale}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 350));
    }
    toast(`Exported ${selection.length} layers`, 'success');
  };

  const doc = getDoc();
  const targetId = selection[0] ?? doc?.pages[0]?.artboards[0];

  const code = useMemo(() => {
    if (!doc || !targetId || !doc.nodes[targetId]) return '';
    switch (format) {
      case 'jsx-tailwind':
        return emitJsx(doc, targetId, { format: 'tailwind', componentName: componentName(doc.nodes[targetId]!.name) });
      case 'jsx-inline':
        return emitJsx(doc, targetId, { format: 'inline', componentName: componentName(doc.nodes[targetId]!.name) });
      case 'html': {
        const { html, css } = emitHtml(doc, targetId, { mode: 'stylesheet' });
        return `${html}\n\n<style>\n${css}\n</style>`;
      }
      case 'css':
        return emitHtml(doc, targetId, { mode: 'stylesheet' }).css;
      case 'standalone':
        return emitStandalone(doc, targetId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, targetId, format, version]);

  const node = targetId ? doc?.nodes[targetId] : undefined;

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal is-wide" onPointerDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Export {node ? <span className="dim">· {node.name}</span> : null}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </header>

        <div className="modal-body">
          {!node ? (
            <p className="panel-empty">Select a layer or artboard to export.</p>
          ) : (
            <>
              <div className="client-tabs">
                {FORMATS.map((f) => (
                  <button key={f.value} className={format === f.value ? 'is-active' : ''} onClick={() => setFormat(f.value)}>
                    {f.label}
                  </button>
                ))}
              </div>

              <pre className="export-code">{code}</pre>

              <div className="export-actions">
                <button
                  className="button primary"
                  onClick={async () => { await navigator.clipboard.writeText(code); toast('Copied to clipboard', 'success'); }}
                >Copy</button>

                <span className="export-group">
                  <select className="input select" value={imageFormat} onChange={(e) => setImageFormat(e.target.value)}>
                    <option value="png">PNG</option>
                    <option value="jpg">JPG</option>
                    <option value="webp">WebP</option>
                    <option value="svg">SVG</option>
                    <option value="html">HTML</option>
                  </select>
                  {imageFormat !== 'svg' && imageFormat !== 'html' && (
                    <select className="input select" value={scale} onChange={(e) => setScale(Number(e.target.value))}>
                      <option value={1}>1×</option>
                      <option value={2}>2×</option>
                      <option value={3}>3×</option>
                    </select>
                  )}
                  <a
                    className="button"
                    href={`/api/documents/${docId}/export/${targetId}?format=${imageFormat}&scale=${scale}`}
                    download
                  >Download</a>
                </span>

                {selection.length > 1 && (
                  <button className="button" onClick={() => void downloadAll()}>
                    Download {selection.length} selected
                  </button>
                )}
              </div>

              <p className="panel-hint">
                Tailwind output uses arbitrary-value classes where no utility matches, and puts
                anything with no class equivalent in a <code>style</code> prop — nothing is dropped.
              </p>
            </>
          )}

          {/*
            * Everything above is a projection into code, which is what you want
            * for building the thing. Moving the document itself is a different
            * job: code drops the tokens, the components and the assets, because
            * there is nowhere in HTML to put them.
            */}
          <div className="export-whole">
            <h3>Move the whole document</h3>
            <p className="panel-hint">
              One file with the nodes, tokens, components, breakpoints, comments and every asset —
              enough to recreate this document on another Playground, or to keep as a backup.
              Connection codes and share links are never included.
            </p>
            <div className="export-actions">
              <a className="button" href={`/api/documents/${docId}/bundle`} download>
                <Icon name="download" size={14} /> Download bundle
              </a>
              <span className="dim">Import it from the home screen.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function componentName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `Component${cleaned}`;
}
