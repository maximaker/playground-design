/** Document list and creation. No accounts in v1: documents are URL-addressed. */

import { useCallback, useEffect, useState } from 'react';

interface DocSummary { id: string; name: string; rev: number; updated_at: number; nodeCount: number }
interface TemplateSummary { id: string; name: string; description: string; tokenCount: number }

export function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/documents');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setDocs(((await res.json()) as { documents: DocSummary[] }).documents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    void fetch('/api/templates')
      .then((r) => r.json() as Promise<{ templates: TemplateSummary[] }>)
      .then((b) => setTemplates(b.templates))
      .catch(() => setTemplates([]));
  }, []);

  const create = async (template?: string) => {
    setCreating(true);
    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(template ? { template } : { name: 'Untitled' }),
      });
      const { document } = (await res.json()) as { document: { id: string } };
      onOpen(document.id);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    await refresh();
  };

  return (
    <div className="home">
      <header>
        <h1>◧ Canvas</h1>
        <p>A design tool whose documents are real HTML and CSS — and that agents can edit with you.</p>
        <button className="button primary" onClick={() => void create()} disabled={creating}>
          Blank document
        </button>
      </header>

      {templates.length > 0 && (
        <section className="starters">
          <h2>Start from a design system</h2>
          <p className="dim">
            Each kit sets up tokens and a foundations sheet, so you — and any agent you connect —
            have real variables to reference instead of inventing hex codes.
          </p>
          <div className="starter-grid">
            {templates.map((t) => (
              <button key={t.id} className={`starter starter-${t.id}`} onClick={() => void create(t.id)} disabled={creating}>
                <span className="starter-swatches" aria-hidden />
                <strong>{t.name}</strong>
                <span className="dim">{t.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {error && <p className="home-error">{error}. Is the server running on port 4000?</p>}
      {loading && <p className="dim">Loading…</p>}

      <div className="home-grid">
        {docs.map((d) => (
          <div key={d.id} className="home-card" onClick={() => onOpen(d.id)}>
            <h3>{d.name}</h3>
            <p className="dim">{d.nodeCount} layers · rev {d.rev}</p>
            <p className="dim">{new Date(d.updated_at).toLocaleString()}</p>
            <button
              className="button subtle"
              onClick={(e) => { e.stopPropagation(); void remove(d.id, d.name); }}
            >Delete</button>
          </div>
        ))}
      </div>

      {!loading && !docs.length && !error && (
        <p className="dim">No documents yet. Create one to get started.</p>
      )}
    </div>
  );
}
