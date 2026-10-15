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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FamilyTopBar } from './ui/FamilyTopBar.tsx';
import { ConnectSearch, LinkedWork } from './connect.tsx';
import { useLayoutMode } from './hooks/useLayout.ts';
import { Icon } from './ui/Icon.tsx';
import { Settings } from './ui/Settings.tsx';
import type { Appearance } from './state/appearance.ts';
import type { useSession } from './state/session.ts';
import { AccountMenu } from './ui/AccountMenu.tsx';
import { dialItems, dialPanel, firstName, navigate, openRow, useDial } from './ui/Dial.ts';

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
interface StarterSummary { id: string; name: string; description: string; preview: string }

/** `null` is everything; `'unfiled'` is everything with no project. */
type Filter = string | null | 'unfiled';

export function Home({ onOpen, appearance, onAppearance, session }: {
  onOpen: (id: string) => void;
  session: ReturnType<typeof useSession>;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
}) {
  const layout = useLayoutMode();
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => { document.title = 'Playground'; }, []);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [starters, setStarters] = useState<StarterSummary[]>([]);
  const [style, setStyle] = useState('clean');
  // ?project=<id> opens on that project: it is the address heymax connect hands out for a project.
  const [filter, setFilter] = useState<Filter>(() => new URLSearchParams(location.search).get('project'));
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  // The dial and Back change ?project= under us; follow it.
  useEffect(() => {
    const onPop = () => setFilter(new URLSearchParams(location.search).get('project'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const makersRef = useRef<HTMLElement>(null);
  // Documents lead; the starting picker opens from New, the dial, or #start ("Starting points" in the editor).
  const [startOpen, setStartOpen] = useState(() => location.hash === '#start');
  const openStart = () => {
    setStartOpen(true);
    requestAnimationFrame(() => makersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

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

  // Previews follow the chosen style, so what you click is what opens.
  useEffect(() => {
    void fetch(`/api/starters?style=${encodeURIComponent(style)}`)
      .then((r) => r.json() as Promise<{ starters: StarterSummary[] }>)
      .then((b) => setStarters(b.starters))
      .catch(() => setStarters([]));
  }, [style]);

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

  const create = async (template?: string, starter?: string) => {
    setCreating(true);
    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(template ? { template } : { name: 'Untitled' }),
          ...(starter ? { starter } : {}),
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
      setScope(project.id);
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
    if (filter === p.id) setScope(null);
    await refresh();
    // Say where the documents went; silence here reads like they were deleted.
    if (body.unfiled) setNote(`${body.unfiled} document${body.unfiled === 1 ? '' : 's'} moved to Unfiled.`);
  };


  useDial(session.user ? {
    label: firstName(session.user.name),
    items: dialItems(loading ? null : docs.length, false),
    activeId: filter === null ? 'home' : 'docs',
    panel: dialPanel(docs, projects, null, typeof filter === 'string' && filter !== 'unfiled' ? filter : null),
    corner: false,
    onSelect: (id) => {
      if (id === 'search') searchRef.current?.focus();
      else if (id === 'new') void create();
      else if (id === 'templates') openStart();
      else if (id === 'import') importRef.current?.click();
      else if (id === 'home') { navigate('/'); window.scrollTo({ top: 0 }); }
    },
    onRow: openRow,
  } : null);

  const setScope = (next: Filter) => {
    navigate(typeof next === 'string' && next !== 'unfiled' ? `/?project=${encodeURIComponent(next)}` : '/');
    setFilter(next);
  };
  const activeProject = typeof filter === 'string' && filter !== 'unfiled' ? projects.find((p) => p.id === filter) : undefined;

  const title = filter === null ? 'All documents'
    : filter === 'unfiled' ? 'Unfiled'
    : projects.find((p) => p.id === filter)?.name ?? 'Project';

  return (
    <div className="home-shell">
    <FamilyTopBar
      middle={
        <label className="library-search family-search">
          <Icon name="search" size={13} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search documents"
            aria-label="Search documents"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      }
      end={
        <div className="home-account">
          {/* The library has no palette of its own, so ⌘K here searches across heymax. */}
          <ConnectSearch />
          {showSettings && (
            <Settings appearance={appearance} onChange={onAppearance} onClose={() => setShowSettings(false)} />
          )}
          {session.user && (
            <AccountMenu user={session.user} onAppearance={() => setShowSettings(true)} onSignedOut={() => { void session.refresh(); }} />
          )}
        </div>
      }
    />
    <div className="hm-dial-offset">
    <div className="home">
      <div className="home-head">
        <div className="library-title">
          <h1 className="home-page-title">{title === 'All documents' ? 'Documents' : title}</h1>
          {!loading && !error && (
            <span className="dim">
              {shown.length} document{shown.length === 1 ? '' : 's'}
              {query && docs.length !== shown.length ? ` of ${docs.length}` : ''}
            </span>
          )}
        </div>
        <button className="button primary home-new" onClick={() => (startOpen ? void create() : openStart())} disabled={creating}>
          <Icon name="plus" size={14} /> <span className="home-action-label">{startOpen ? 'Blank page' : 'New'}</span>
        </button>
        <input
          ref={importRef}
          id="import-bundle"
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="Import a bundle"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset first: picking the same file twice must fire again.
            e.target.value = '';
            if (file) void importBundle(file);
          }}
        />
      </div>

      {(startOpen || (!loading && !error && docs.length === 0)) && (
      <section className="makers" id="start" ref={makersRef} aria-labelledby="makers-title">
          <div className="makers-head">
            <div>
              <h2 id="makers-title">What are you making?</h2>
              <p className="dim">Design a page and put it online, on your own or with an agent helping. Every word, picture and colour can be changed.</p>
            </div>
            <div className="home-actions">
              <label className={`button subtle${importing ? ' is-busy' : ''}`} htmlFor="import-bundle">
                <Icon name="upload" size={14} />
                <span className="home-action-label">{importing ? 'Importing…' : 'Import a bundle'}</span>
              </label>
              <button className="button" onClick={() => void create()} disabled={creating}>
                <Icon name="plus" size={14} /> <span className="home-action-label">Blank page</span>
              </button>
              {docs.length > 0 && (
                <button className="icon-button" aria-label="Close" title="Close" onClick={() => setStartOpen(false)}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          </div>
          <div className="makers-style">
            {templates.length > 0 && (
              <div className="style-picker" role="radiogroup" aria-label="Style">
                <span className="dim">Style</span>
                {templates.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={style === t.id}
                    className={`style-chip starter-${t.id}${style === t.id ? ' is-active' : ''}`}
                    onClick={() => setStyle(t.id)}
                    title={t.description}
                  >
                    <span className="starter-swatches" aria-hidden />
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="maker-grid">
            {starters.map((s) => (
              <button
                key={s.id}
                className="maker"
                onClick={() => void create(style, s.id)}
                disabled={creating}
              >
                <MakerPreview html={s.preview} />
                <span className="maker-text">
                  <strong>{s.name}</strong>
                  <span className="dim">{s.description}</span>
                </span>
              </button>
            ))}
          </div>
          {templates.length > 0 && (
            <details className="makers-more">
              <summary>For designers: start from a design system instead</summary>
              <p className="dim">
                Each kit sets up tokens and a foundations sheet, so you — and any agent you
                connect — have real variables to reference instead of inventing hex codes.
              </p>
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
            </details>
          )}
        </section>
      )}

      {error && (
        <p className="home-error">
          Could not load your documents. <button className="button" onClick={() => void refresh()}>Try again</button>
        </p>
      )}
      {loading && <p className="dim">Loading…</p>}

      {!loading && !error && (
        <div className="library">

          <section className="library-docs">
            <div className="library-docs-head">

              <div className="library-tools">
                {/* What the sidebar used to choose: everything, unfiled, or one project. */}
                <label className="library-sort">
                  <span className="sr-only">Show</span>
                  <select
                    aria-label="Show"
                    value={filter ?? ''}
                    onChange={(e) => setScope(e.target.value === '' ? null : e.target.value)}
                  >
                    <option value="">All documents ({docs.length})</option>
                    <option value="unfiled">Unfiled ({unfiled})</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.documentCount})</option>)}
                  </select>
                </label>
                <button className="icon-button" title="New project" aria-label="New project" onClick={addProject}>
                  <Icon name="plus" size={13} />
                </button>
                {activeProject && (
                  <>
                    <button className="icon-button" title="Rename project" aria-label={`Rename ${activeProject.name}`} onClick={() => void renameProject(activeProject)}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button className="icon-button" title="Delete project" aria-label={`Delete ${activeProject.name}`} onClick={() => void removeProject(activeProject)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </>
                )}

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

            {typeof filter === 'string' && filter !== 'unfiled' && projects.some((p) => p.id === filter) && (
              <LinkedWork
                key={filter}
                type="project"
                id={filter}
                title={title}
                url={`${location.origin}/?project=${encodeURIComponent(filter)}`}
              />
            )}

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
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(d.id); } }}
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
                    <p className="dim" title={`${d.nodeCount.toLocaleString()} layer${d.nodeCount === 1 ? '' : 's'} · revision ${d.rev}`}>
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
                        className="icon-button home-card-more"
                        aria-label={`More for ${d.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === d.id}
                        onClick={() => setMenuFor(menuFor === d.id ? null : d.id)}
                      ><Icon name="more" size={15} /></button>
                      {menuFor === d.id && (
                        <div className="home-card-menu" role="menu">
                          {/* The same action as dragging, for the keyboard and
                              for anyone who never discovers that dragging works. */}
                          {projects.length > 0 && <span className="dim">Move to</span>}
                          {projects.map((p) => (
                            <button
                              key={p.id}
                              role="menuitem"
                              disabled={d.projectId === p.id}
                              onClick={() => void file(d.id, p.id)}
                            >{p.name}</button>
                          ))}
                          {d.projectId && (
                            <button role="menuitem" onClick={() => void file(d.id, null)}>Remove from project</button>
                          )}
                          <button role="menuitem" className="danger" onClick={() => { setMenuFor(null); void remove(d.id, d.name); }}>Delete</button>
                        </div>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {!shown.length && (
              <p className="dim">
                {query.trim()
                  ? <>Nothing matches “{query.trim()}”.</>
                  : filter === null
                    ? 'No documents yet. Create one to get started.'
                    : filter === 'unfiled'
                      ? 'Every document is in a project.'
                      : 'Nothing here yet — drag a document onto this project, or create one while it is open.'}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
    </div>
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

/**
 * A starter, drawn at the 1440px it was written for and scaled to the card —
 * a real render of the page rather than an illustration of one.
 */
function MakerPreview({ html }: { html: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0.2);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1440));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <span className="maker-preview" ref={box} aria-hidden>
      <iframe title="" srcDoc={html} tabIndex={-1} sandbox="" style={{ transform: `scale(${scale})` }} />
    </span>
  );
}
