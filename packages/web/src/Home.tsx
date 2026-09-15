/**
 * The library: projects down one side, documents in the middle.
 *
 * A flat list stops being a library somewhere around thirty files, and this is
 * a tool designed to make files quickly — an agent can create one in a single
 * call. Projects are the smallest thing that fixes that: a name, and a
 * membership field on each document.
 *
 * Documents move by dragging onto a project, and by a menu on the card as well.
 * Drag is the faster gesture and the one people reach for; it is also invisible
 * until you try it, and impossible with a keyboard.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Logo } from './ui/Logo.tsx';
import { Icon } from './ui/Icon.tsx';
import { Settings } from './ui/Settings.tsx';
import type { Appearance } from './state/appearance.ts';

interface DocSummary {
  id: string; name: string; rev: number; updatedAt: number; nodeCount: number; projectId?: string;
}
interface Project { id: string; name: string; createdAt: number; documentCount: number }
interface TemplateSummary { id: string; name: string; description: string; tokenCount: number }

/** `null` is everything; `'unfiled'` is everything with no project. */
type Filter = string | null | 'unfiled';

export function Home({ onOpen, appearance, onAppearance }: {
  onOpen: (id: string) => void;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [filter, setFilter] = useState<Filter>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<Filter | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        fetch('/api/documents').then((r) => {
          if (!r.ok) throw new Error(`Server returned ${r.status}`);
          return r.json() as Promise<{ documents: DocSummary[] }>;
        }),
        fetch('/api/projects').then((r) => r.json() as Promise<{ projects: Project[] }>).catch(() => ({ projects: [] })),
      ]);
      setDocs(d.documents);
      setProjects(p.projects);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // A menu that only closes by pressing the same button again is a menu people
  // leave open by accident and then click through.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement)?.closest('.home-card-menu-anchor')) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuFor(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  useEffect(() => {
    void fetch('/api/templates')
      .then((r) => r.json() as Promise<{ templates: TemplateSummary[] }>)
      .then((b) => setTemplates(b.templates))
      .catch(() => setTemplates([]));
  }, []);

  const shown = useMemo(() => {
    if (filter === null) return docs;
    if (filter === 'unfiled') return docs.filter((d) => !d.projectId);
    return docs.filter((d) => d.projectId === filter);
  }, [docs, filter]);

  const unfiled = docs.filter((d) => !d.projectId).length;

  const create = async (template?: string) => {
    setCreating(true);
    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(template ? { template } : { name: 'Untitled' }),
          // A document made while a project is open belongs in it.
          ...(typeof filter === 'string' && filter !== 'unfiled' ? { projectId: filter } : {}),
        }),
      });
      const { document } = (await res.json()) as { document: { id: string } };
      onOpen(document.id);
    } finally {
      setCreating(false);
    }
  };

  /** Recreates a document from a bundle file, on this instance. */
  const importBundle = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const query = typeof filter === 'string' && filter !== 'unfiled' ? `?projectId=${filter}` : '';
      const res = await fetch(`/api/documents/import${query}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: text,
      });
      const body = (await res.json()) as { document?: { id: string }; error?: string; problems?: string[]; notes?: string[] };
      if (!res.ok) {
        // The validator says which reference is dangling; passing that on is
        // the difference between a fixable file and a mysterious one.
        setNote([body.error, ...(body.problems ?? [])].filter(Boolean).join(' — '));
        return;
      }
      for (const n of body.notes ?? []) setNote(n.replace(/^NOTE /, ''));
      if (body.document) onOpen(body.document.id);
    } catch (err) {
      setNote(err instanceof Error ? `Could not read that file: ${err.message}` : 'Could not read that file');
    } finally {
      setImporting(false);
    }
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    await refresh();
  };

  const file = async (docId: string, projectId: string | null) => {
    setMenuFor(null);
    // Optimistic: the list is already on screen and a round trip before the
    // card moves makes dragging feel broken.
    setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, projectId: projectId ?? undefined } : d)));
    await fetch(`/api/documents/${docId}/project`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    await refresh();
  };

  const addProject = async () => {
    const name = window.prompt('Name this project');
    if (!name?.trim()) return;
    const res = await fetch('/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const { project } = (await res.json()) as { project: Project };
      await refresh();
      setFilter(project.id);
    }
  };

  const renameProject = async (p: Project) => {
    const name = window.prompt('Rename project', p.name);
    if (!name?.trim() || name === p.name) return;
    await fetch(`/api/projects/${p.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await refresh();
  };

  const removeProject = async (p: Project) => {
    const warning = p.documentCount
      ? `Delete the project "${p.name}"? Its ${p.documentCount} document${p.documentCount === 1 ? '' : 's'} will be kept and become unfiled.`
      : `Delete the project "${p.name}"?`;
    if (!window.confirm(warning)) return;
    const res = await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
    const body = (await res.json().catch(() => ({}))) as { unfiled?: number };
    if (filter === p.id) setFilter(null);
    await refresh();
    // Say where the documents went; silence here reads like they were deleted.
    if (body.unfiled) setNote(`${body.unfiled} document${body.unfiled === 1 ? '' : 's'} moved to Unfiled.`);
  };

  /** A project row doubles as a drop target for filing a document. */
  const dropProps = (target: Filter) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('text/x-playground-doc')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOver(target);
    },
    onDragLeave: () => setDragOver((d) => (d === target ? undefined : d)),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData('text/x-playground-doc');
      setDragOver(undefined);
      if (!id) return;
      e.preventDefault();
      void file(id, target === 'unfiled' || target === null ? null : target);
    },
    className: dragOver === target ? 'is-drop-target' : undefined,
  });

  const title = filter === null ? 'All documents'
    : filter === 'unfiled' ? 'Unfiled'
    : projects.find((p) => p.id === filter)?.name ?? 'Project';

  return (
    <div className="home">
      <header>
        <h1><Logo size={38} /></h1>
        <p>A design tool whose documents are real HTML and CSS — and that agents can edit with you.</p>
        <div className="home-actions">
          <button className="button primary" onClick={() => void create()} disabled={creating}>
            <Icon name="plus" size={14} /> Blank document
          </button>

          {/*
            * A label rather than a button: a file input cannot be opened from
            * script without a user gesture on it, and hiding the input behind a
            * label is the only way to have both a real picker and a styled
            * control.
            */}
          <label className={`button${importing ? ' is-busy' : ''}`}>
            <Icon name="upload" size={14} />
            {importing ? 'Importing…' : 'Import a bundle'}
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset first: picking the same file twice must fire again.
                e.target.value = '';
                if (file) void importBundle(file);
              }}
            />
          </label>
          <button
            className="icon-button"
            title="Appearance"
            aria-label="Appearance"
            onClick={() => setShowSettings((v) => !v)}
          ><Icon name="settings" size={15} /></button>
          {showSettings && (
            <Settings appearance={appearance} onChange={onAppearance} onClose={() => setShowSettings(false)} />
          )}
        </div>
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

      {!loading && !error && (
        <div className="library">
          <nav className="library-nav" aria-label="Projects">
            <button
              className={`library-row${filter === null ? ' is-active' : ''}`}
              onClick={() => setFilter(null)}
            >
              <Icon name="layers" size={13} />
              <span>All documents</span>
              <span className="dim">{docs.length}</span>
            </button>

            <button
              {...dropProps('unfiled')}
              className={`library-row${filter === 'unfiled' ? ' is-active' : ''}${dragOver === 'unfiled' ? ' is-drop-target' : ''}`}
              onClick={() => setFilter('unfiled')}
            >
              <Icon name="page" size={13} />
              <span>Unfiled</span>
              <span className="dim">{unfiled}</span>
            </button>

            <div className="library-heading">
              <span>Projects</span>
              <button className="icon-button" title="New project" aria-label="New project" onClick={addProject}>
                <Icon name="plus" size={13} />
              </button>
            </div>

            {projects.length === 0 && (
              <p className="library-empty dim">
                No projects yet. Make one, then drag a document onto it.
              </p>
            )}

            {projects.map((p) => (
              <div
                key={p.id}
                {...dropProps(p.id)}
                className={`library-row is-project${filter === p.id ? ' is-active' : ''}${dragOver === p.id ? ' is-drop-target' : ''}`}
              >
                <button className="library-row-main" onClick={() => setFilter(p.id)}>
                  <Icon name="folder" size={13} />
                  <span>{p.name}</span>
                  <span className="dim">{p.documentCount}</span>
                </button>
                <button className="icon-button" title="Rename" aria-label={`Rename ${p.name}`} onClick={() => void renameProject(p)}>
                  <Icon name="edit" size={11} />
                </button>
                <button className="icon-button" title="Delete project" aria-label={`Delete ${p.name}`} onClick={() => void removeProject(p)}>
                  <Icon name="trash" size={11} />
                </button>
              </div>
            ))}
          </nav>

          <section className="library-docs">
            <div className="library-docs-head">
              <h2 className="home-section-title">{title}</h2>
              <span className="dim">{shown.length} document{shown.length === 1 ? '' : 's'}</span>
            </div>

            {note && (
              <p className="library-note">
                {note}
                <button className="button subtle" onClick={() => setNote(null)}>Dismiss</button>
              </p>
            )}

            <div className="home-grid">
              {shown.map((d) => (
                <div
                  key={d.id}
                  className="home-card"
                  draggable
                  onDragStart={(e) => {
                    // A private type, so the canvas's file-drop handler and any
                    // other drop target ignore this drag entirely.
                    e.dataTransfer.setData('text/x-playground-doc', d.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => onOpen(d.id)}
                >
                  <h3>{d.name}</h3>
                  <p className="dim">{d.nodeCount} layers · rev {d.rev}</p>
                  <p className="dim">{relativeTime(d.updatedAt)}</p>

                  <div className="home-card-actions" onClick={(e) => e.stopPropagation()}>
                    <span className="home-card-menu-anchor">
                      <button
                        className="button subtle"
                        aria-expanded={menuFor === d.id}
                        onClick={() => setMenuFor(menuFor === d.id ? null : d.id)}
                      >Move…</button>
                      {menuFor === d.id && (
                        <div className="home-card-menu">
                          {/* The same action as dragging, for the keyboard and
                              for anyone who never discovers that dragging works. */}
                          {projects.map((p) => (
                            <button
                              key={p.id}
                              disabled={d.projectId === p.id}
                              onClick={() => void file(d.id, p.id)}
                            >{p.name}</button>
                          ))}
                          {projects.length === 0 && <span className="dim">No projects yet</span>}
                          {d.projectId && (
                            <button onClick={() => void file(d.id, null)}>Remove from project</button>
                          )}
                        </div>
                      )}
                    </span>
                    <button className="button subtle" onClick={() => void remove(d.id, d.name)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>

            {!shown.length && (
              <p className="dim">
                {filter === null
                  ? 'No documents yet. Create one to get started.'
                  : 'Nothing here yet — drag a document onto this project, or create one while it is open.'}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** Short relative time — an absolute timestamp is noise on a document list. */
function relativeTime(ts: number): string {
  if (!Number.isFinite(ts)) return 'just now';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(ts).toLocaleDateString();
}
