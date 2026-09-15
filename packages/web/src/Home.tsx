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
import type { useSession } from './state/session.ts';
import { AccountMenu } from './ui/AccountMenu.tsx';

interface DocSummary {
  id: string; name: string; rev: number; updatedAt: number; nodeCount: number;
  projectId?: string;
  /** The caller's own role, so a document shared with you says so. */
  role?: 'owner' | 'editor' | 'viewer';
}

type Sort = 'recent' | 'name' | 'size';
type View = 'grid' | 'list';

const SORTS: { id: Sort; label: string }[] = [
  { id: 'recent', label: 'Last edited' },
  { id: 'name', label: 'Name' },
  { id: 'size', label: 'Size' },
];
interface Project { id: string; name: string; createdAt: number; documentCount: number }
interface TemplateSummary { id: string; name: string; description: string; tokenCount: number }

/** `null` is everything; `'unfiled'` is everything with no project. */
type Filter = string | null | 'unfiled';

export function Home({ onOpen, appearance, onAppearance, session }: {
  onOpen: (id: string) => void;
  session: ReturnType<typeof useSession>;
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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  // Remembered per person: whichever way you read a library, you read it that
  // way every day. Not worth a round trip to the server.
  const [view, setView] = useState<View>(() =>
    (localStorage.getItem('playground.library.view') as View) ?? 'grid');
  useEffect(() => {
    try { localStorage.setItem('playground.library.view', view); } catch { /* not critical */ }
  }, [view]);

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
    const inScope = filter === null ? docs
      : filter === 'unfiled' ? docs.filter((d) => !d.projectId)
        : docs.filter((d) => d.projectId === filter);
    const needle = query.trim().toLowerCase();
    const matched = needle ? inScope.filter((d) => d.name.toLowerCase().includes(needle)) : inScope;
    const ordered = [...matched];
    if (sort === 'name') ordered.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'size') ordered.sort((a, b) => b.nodeCount - a.nodeCount);
    else ordered.sort((a, b) => b.updatedAt - a.updatedAt);
    return ordered;
  }, [docs, filter, query, sort]);

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
      <header className="home-head">
        <div className="home-identity">
          <h1><Logo size={30} /></h1>
          <p>Documents that are real HTML and CSS — and that agents can edit with you.</p>
        </div>
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
          {session.user && (
            <AccountMenu user={session.user} onSignedOut={() => { void session.refresh(); }} />
          )}
        </div>
      </header>

      {templates.length > 0 && (
        <section className="starters">
          <div className="starters-head">
            <h2>Start from a design system</h2>
            <p className="dim">
              Each kit sets up tokens and a foundations sheet, so you — and any agent you
              connect — have real variables to reference instead of inventing hex codes.
            </p>
          </div>
          <div className="starter-row">
            {templates.map((t) => (
              <button
                key={t.id}
                className={`starter starter-${t.id}`}
                onClick={() => void create(t.id)}
                disabled={creating}
                title={t.description}
              >
                <span className="starter-swatches" aria-hidden />
                <span className="starter-text">
                  <strong>{t.name}</strong>
                  <span className="dim">{t.description}</span>
                </span>
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
              <div className="library-title">
                <h2 className="home-section-title">{title}</h2>
                <span className="dim">
                  {shown.length} document{shown.length === 1 ? '' : 's'}
                  {query && docs.length !== shown.length ? ` of ${docs.length}` : ''}
                </span>
              </div>

              <div className="library-tools">
                <label className="library-search">
                  <Icon name="search" size={13} />
                  <input
                    type="search"
                    value={query}
                    placeholder="Search documents"
                    aria-label="Search documents"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>

                <label className="library-sort">
                  <span className="sr-only">Sort by</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                    {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </label>

                <div className="segmented library-view">
                  <button
                    className={view === 'grid' ? 'is-active' : ''}
                    onClick={() => setView('grid')}
                    title="Grid" aria-label="Grid view" aria-pressed={view === 'grid'}
                  ><Icon name="grid" size={13} /></button>
                  <button
                    className={view === 'list' ? 'is-active' : ''}
                    onClick={() => setView('list')}
                    title="List" aria-label="List view" aria-pressed={view === 'list'}
                  ><Icon name="list" size={13} /></button>
                </div>
              </div>
            </div>

            {note && (
              <p className="library-note">
                {note}
                <button className="button subtle" onClick={() => setNote(null)}>Dismiss</button>
              </p>
            )}

            <div className={view === 'grid' ? 'home-grid' : 'home-list'}>
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
                  {/*
                    * A tinted slab keyed to the document's own id. Not
                    * decoration: it is the same colour every time, so a
                    * document becomes findable by shape in a grid of twenty
                    * before you have read a single title.
                    */}
                  {/*
                    * The tint sits underneath and the picture loads over it, so
                    * a card is never empty: a cold thumbnail takes a second to
                    * render, an instance without a renderer never gets one, and
                    * neither case should leave a hole in the grid.
                    */}
                  <span className="home-card-face" style={faceStyle(d.id)} aria-hidden>
                    <span className="home-card-initial">{(d.name.trim()[0] ?? '?').toUpperCase()}</span>
                    <img
                      className="home-card-shot"
                      src={`/api/documents/${d.id}/thumbnail?rev=${d.rev}`}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onLoad={(e) => e.currentTarget.classList.add('is-loaded')}
                      onError={(e) => e.currentTarget.remove()}
                    />
                  </span>

                  <div className="home-card-body">
                    <h3>{d.name}</h3>
                    <p className="dim" title={`Revision ${d.rev}`}>
                      {d.nodeCount.toLocaleString()} layer{d.nodeCount === 1 ? '' : 's'}
                      <span className="home-card-sep">·</span>
                      {relativeTime(d.updatedAt)}
                      {d.projectId && projects.find((p) => p.id === d.projectId) && (
                        <>
                          <span className="home-card-sep">·</span>
                          {projects.find((p) => p.id === d.projectId)!.name}
                        </>
                      )}
                    </p>
                  </div>

                  {/* Only worth saying when it is not the ordinary case. */}
                  {d.role && d.role !== 'owner' && (
                    <span className={`role-badge role-${d.role}`}>{d.role}</span>
                  )}

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
/**
 * A stable tint for a document, derived from its id.
 *
 * Only the hue varies, and only as a custom property — the CSS mixes it into
 * the surface colour so the tint is a wash rather than a block of paint. Eight
 * saturated slabs in a grid look like a toy; the same eight at 12% look like a
 * filing system.
 *
 * The hue is a hash rather than a random pick, so a document is the same colour
 * tomorrow and becomes findable by shape before you have read a title. Colour is
 * never the only signal — the name is right there — so nothing is lost if two
 * hues look alike to you.
 */
function faceStyle(id: string): React.CSSProperties {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return { '--tint': String(hash) } as React.CSSProperties;
}

function relativeTime(ts: number): string {
  if (!Number.isFinite(ts)) return 'just now';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(ts).toLocaleDateString();
}
