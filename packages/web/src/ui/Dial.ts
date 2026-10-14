/**
 * The heymax dial: Playground's navigation, in place of the library sidebar.
 *
 * One dial per screen (Home and the editor each mount it), fed from the same
 * REST endpoints the library used. In the editor it sits in the corner as a
 * knob so the layers and design panels keep their space.
 */

import { useEffect, useRef, useState } from 'react';
import '../kit-dial.css';
import { createDial, type Dial, type DialItem, type DialPanel, type DialRow } from '../kit-dial.js';

export interface LibDoc { id: string; name: string; updatedAt: number; projectId?: string }
export interface LibProject { id: string; name: string; documentCount: number }

/** Changes the address and lets App (and Home) follow it, as Back would. */
export function navigate(path: string): void {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function relativeTime(ts: number): string {
  if (!Number.isFinite(ts)) return 'just now';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Ring items, in the approved order. Only what exists here: there is no
 * trash (deleting is permanent) and no "shared with me" view, so neither is on
 * the ring. Components is a panel of an open document, so it shows in the editor.
 */
export function dialItems(docCount: number | null, inEditor: boolean): DialItem[] {
  return [
    { id: 'search', label: 'Search', icon: 'search', kbd: 'Ctrl K' },
    { id: 'new', label: 'Blank page', icon: 'plus' },
    { id: 'docs', label: 'Documents', icon: 'folder', kbd: docCount == null ? '' : String(docCount), panel: true },
    { id: 'templates', label: 'Starting points', icon: 'grid' },
    ...(inEditor ? [{ id: 'components', label: 'Components', icon: 'component' }] : []),
    { id: 'import', label: 'Import a bundle', icon: 'import' },
    { id: 'home', label: 'Home', icon: 'home' },
  ];
}

export function dialPanel(docs: LibDoc[], projects: LibProject[], currentDoc: string | null, currentProject: string | null): DialPanel {
  const recent = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
  const row = (d: LibDoc): DialRow => ({
    id: `doc:${d.id}`, label: d.name, meta: relativeTime(d.updatedAt), swatch: true,
    current: d.id === currentDoc, href: `/d/${d.id}`,
  });
  return {
    title: 'Documents',
    filter: 'Filter documents…',
    groups: [
      { title: 'All documents', rows: recent.slice(0, 12).map(row), empty: 'No documents yet' },
      {
        title: 'Projects', empty: 'No projects yet',
        rows: projects.map((p) => ({
          id: `project:${p.id}`, label: p.name, meta: String(p.documentCount), icon: 'folder',
          current: p.id === currentProject, href: `/?project=${encodeURIComponent(p.id)}`,
        })),
      },
      { title: 'Unfiled', rows: recent.filter((d) => !d.projectId).map(row), empty: 'Every document is in a project' },
    ],
  };
}

/** Picks a bundle file and recreates it here; resolves to the new document id. */
export function importBundleFile(projectId?: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const query = projectId ? `?projectId=${projectId}` : '';
      const res = await fetch(`/api/documents/import${query}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text(),
      });
      const body = (await res.json().catch(() => ({}))) as { document?: { id: string }; error?: string };
      if (!res.ok) window.alert(body.error ?? 'Could not import that file');
      resolve(body.document?.id ?? null);
    };
    input.click();
  });
}

export async function createBlank(projectId?: string | null): Promise<string> {
  const res = await fetch('/api/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Untitled', ...(projectId ? { projectId } : {}) }),
  });
  const { document } = (await res.json()) as { document: { id: string } };
  return document.id;
}

/** The library as the dial needs it. Pass `docs`/`projects` when the screen already has them. */
export function useLibrary(enabled: boolean) {
  const [docs, setDocs] = useState<LibDoc[] | null>(null);
  const [projects, setProjects] = useState<LibProject[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.all([
      fetch('/api/documents').then((r) => (r.ok ? r.json() : { documents: [] })),
      fetch('/api/projects').then((r) => (r.ok ? r.json() : { projects: [] })).catch(() => ({ projects: [] })),
    ]).then(([d, p]: [{ documents: LibDoc[] }, { projects: LibProject[] }]) => {
      if (live) { setDocs(d.documents); setProjects(p.projects); }
    }).catch(() => { /* the dial still navigates without a list */ });
    return () => { live = false; };
  }, [enabled]);
  return { docs, projects };
}

export interface DialConfig {
  label: string;
  items: DialItem[];
  activeId: string | null;
  panel: DialPanel;
  corner: boolean;
  onSelect: (id: string) => void;
  onRow: (row: DialRow) => void;
}

const MARK = '<img src="/kit/marks/playground.svg" width="22" height="22" alt="">';

/** Mounts the dial once and keeps it in step with `config`. */
export function useDial(config: DialConfig | null): void {
  const dial = useRef<Dial | null>(null);
  const latest = useRef(config);
  latest.current = config;
  const on = !!config;

  useEffect(() => {
    if (!on) return;
    const c = latest.current!;
    dial.current = createDial({
      app: 'playground', name: 'Playground', label: c.label, mark: MARK,
      items: c.items, activeId: c.activeId, panel: c.panel, corner: c.corner,
      onSelect: (item) => latest.current?.onSelect(item.id),
      onRow: (row) => latest.current?.onRow(row),
    });
    return () => { dial.current?.destroy(); dial.current = null; };
  }, [on]);

  // Re-rendered only when what it shows changes: the editor renders often, and
  // rebuilding the list each time would drop focus from a row mid-arrowing.
  const shape = config ? JSON.stringify([config.label, config.items, config.activeId, config.panel, config.corner]) : '';
  useEffect(() => {
    const c = latest.current;
    if (!c || !dial.current) return;
    dial.current.update({ label: c.label, items: c.items, activeId: c.activeId, panel: c.panel, corner: c.corner });
  }, [shape]);
}

/** Opens a dial row: documents open in the editor, projects open in the library. */
export function openRow(row: DialRow): void {
  const [kind, id] = row.id.split(':') as [string, string];
  navigate(kind === 'doc' ? `/d/${id}` : `/?project=${encodeURIComponent(id)}`);
}

export function firstName(name: string | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}
