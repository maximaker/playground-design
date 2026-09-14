/**
 * Import a webpage onto the canvas.
 *
 * Cheap to build and unusually useful here, because a live page and a Canvas
 * document are the same kind of thing — this is fetch, inline and parse rather
 * than a conversion, so what arrives is editable layers, not a screenshot.
 */

import { useState } from 'react';
import { useCanvas } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

export function Import({ onClose }: { onClose: () => void }) {
  const docId = useCanvas((s) => s.docId);
  const toast = useCanvas((s) => s.toast);
  const select = useCanvas((s) => s.select);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const run = async () => {
    if (!docId || !url.trim()) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetch(`/api/documents/${docId}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = (await res.json()) as {
        artboardId?: string; nodeCount?: number; title?: string; warnings?: string[]; error?: string;
      };
      if (!res.ok) { setError(body.error ?? `Import failed (HTTP ${res.status})`); return; }

      setWarnings(body.warnings ?? []);
      if (body.artboardId) select([body.artboardId]);
      toast(`Imported ${body.nodeCount} layers from ${body.title}`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Import a webpage</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </header>

        <div className="modal-body">
          <p className="modal-lede">
            Fetches the page and its stylesheets and turns them into editable layers on a new
            artboard — real text, real flexbox, real styles. Good for a reference, a competitor, or
            a page you are redesigning.
          </p>

          <div className="connect-create">
            <label className="field is-wide">
              <span className="field-label">URL</span>
              <input
                className="input"
                value={url}
                placeholder="https://example.com"
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void run(); e.stopPropagation(); }}
              />
            </label>
            <button className="button primary" disabled={busy || !url.trim()} onClick={() => void run()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>

          {error && <p className="import-error">{error}</p>}

          {warnings.length > 0 && (
            <ul className="import-warnings">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          <p className="panel-hint">
            It is a static snapshot of the served markup: scripts, hover states and anything rendered
            client-side will not come across. Private and loopback addresses are refused.
          </p>
        </div>
      </div>
    </div>
  );
}
