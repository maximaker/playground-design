/**
 * Export panel: the design already is code, so this is mostly a copy button.
 */

import { useMemo, useState } from 'react';
import { emitJsx, emitHtml, emitStandalone } from '@canvas/shared';
import { useCanvas, getDoc } from '../state/store.ts';

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
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
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
                <a className="button" href={`/api/documents/${docId}/export/${targetId}?format=png&scale=2`} download>
                  Download PNG @2x
                </a>
                <a className="button" href={`/api/documents/${docId}/export/${targetId}?format=html`} download>
                  Download HTML
                </a>
              </div>

              <p className="panel-hint">
                Tailwind output uses arbitrary-value classes where no utility matches, and puts
                anything with no class equivalent in a <code>style</code> prop — nothing is dropped.
              </p>
            </>
          )}
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
