/** Document list and creation. No accounts in v1: documents are URL-addressed. */

import { useCallback, useEffect, useState } from 'react';

interface DocSummary { id: string; name: string; rev: number; updated_at: number; nodeCount: number }

export function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
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

  const create = async () => {
    const res = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Untitled' }),
    });
    const { document } = (await res.json()) as { document: { id: string } };
    onOpen(document.id);
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
        <button className="button primary" onClick={create}>New document</button>
      </header>

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
