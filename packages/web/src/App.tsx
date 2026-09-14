/** Application shell: routing, layout, panels and global interactions. */

import { useEffect, useState } from 'react';
import { useCanvas } from './state/store.ts';
import { connectDocument } from './net/socket.ts';
import { useKeyboard } from './hooks/useKeyboard.ts';
import { useLayoutMode, panelsOverlay } from './hooks/useLayout.ts';
import { useClipboard } from './hooks/useClipboard.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { Layers } from './panels/Layers.tsx';
import { Properties } from './panels/Properties.tsx';
import { Tokens } from './panels/Tokens.tsx';
import { Components } from './panels/Components.tsx';
import { Review } from './panels/Review.tsx';
import { History } from './panels/History.tsx';
import { ConnectAgent } from './panels/ConnectAgent.tsx';
import { Export } from './panels/Export.tsx';
import { Import } from './panels/Import.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import { ContextMenu, type ContextMenuState } from './ui/ContextMenu.tsx';
import { Shortcuts } from './ui/Shortcuts.tsx';
import { Icon, type IconName } from './ui/Icon.tsx';
import { Logo } from './ui/Logo.tsx';
import { Settings } from './ui/Settings.tsx';
import { OverflowMenu } from './ui/OverflowMenu.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';
import {
  type Appearance, applyAppearance, loadAppearance, saveAppearance, watchSystemTheme,
} from './state/appearance.ts';
import { Home } from './Home.tsx';

type LeftTab = 'layers' | 'pages' | 'components' | 'tokens' | 'review' | 'history';

const LEFT_TABS: { id: LeftTab; icon: IconName; label: string; hint: string }[] = [
  { id: 'layers', icon: 'layers', label: 'Layers', hint: 'The structure of this page' },
  { id: 'pages', icon: 'page', label: 'Pages', hint: 'Pages in this document' },
  { id: 'components', icon: 'component', label: 'Components', hint: 'Reusable components and their variants' },
  { id: 'tokens', icon: 'palette', label: 'Tokens', hint: 'Design tokens and themes' },
  { id: 'review', icon: 'check', label: 'Review', hint: 'Contrast, tap targets, token consistency and layout shape' },
  { id: 'history', icon: 'history', label: 'History', hint: 'Changes and saved versions' },
];

export function App() {
  const [docId, setDocId] = useState<string | null>(() => docIdFromLocation());
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  // Follow the OS while the preference is "system".
  useEffect(() => {
    if (appearance.theme !== 'system') return;
    return watchSystemTheme(() => applyAppearance(appearance));
  }, [appearance]);

  useEffect(() => {
    const onPop = () => setDocId(docIdFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!docId) {
    return (
      <Home
        onOpen={(id) => { history.pushState({}, '', `/d/${id}`); setDocId(id); }}
        appearance={appearance}
        onAppearance={setAppearance}
      />
    );
  }
  return (
    <Editor
      docId={docId}
      onHome={() => { history.pushState({}, '', '/'); setDocId(null); }}
      appearance={appearance}
      onAppearance={setAppearance}
    />
  );
}

/**
 * Keeps a closed drawer out of the tab order and away from screen readers.
 * `inert` is not in React 18's prop types yet, hence the cast.
 */
function hiddenWhenClosed(open: boolean): Record<string, unknown> {
  return open ? {} : { inert: '', 'aria-hidden': true };
}

function docIdFromLocation(): string | null {
  const m = /^\/d\/([\w-]+)/.exec(location.pathname);
  return m ? m[1]! : null;
}

function Editor({ docId, onHome, appearance, onAppearance }: {
  docId: string;
  onHome: () => void;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
}) {
  const connection = useCanvas((s) => s.connection);
  const fatalError = useCanvas((s) => s.fatalError);
  const doc = useCanvas((s) => s.doc);
  const version = useCanvas((s) => s.version);
  const pageId = useCanvas((s) => s.pageId);
  const setPage = useCanvas((s) => s.setPage);
  const peers = useCanvas((s) => s.peers);
  const transport = useCanvas((s) => s.transport);
  const agentActivity = useCanvas((s) => s.agentActivity);
  const dispatch = useCanvas((s) => s.dispatch);

  const [leftTab, setLeftTab] = useState<LeftTab>('layers');
  const [modal, setModal] = useState<'connect' | 'export' | 'import' | 'shortcuts' | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showPalette, setShowPalette] = useState(false);

  const mode = useLayoutMode();
  const overlay = panelsOverlay(mode);
  // Docked panels are always open; overlay panels start closed so the canvas
  // gets the whole screen, which is the point of the narrow layouts.
  const [openPanel, setOpenPanel] = useState<'left' | 'right' | null>(null);
  const leftOpen = !overlay || openPanel === 'left';
  const rightOpen = !overlay || openPanel === 'right';

  // Selecting something on the canvas is a request to see the canvas.
  useEffect(() => {
    if (overlay) setOpenPanel(null);
  }, [overlay]);

  useKeyboard({
    onExport: () => setModal('export'),
    onShortcuts: () => setModal('shortcuts'),
    onPalette: () => setShowPalette(true),
  });
  useClipboard();

  useEffect(() => {
    const conn = connectDocument(docId);
    return () => conn.close();
  }, [docId]);

  if (!doc) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <Logo size={34} />
          {fatalError ? (
            <>
              <p className="boot-error">{fatalError}</p>
              <button className="button primary" onClick={onHome}>Back to all documents</button>
            </>
          ) : (
            <p>Opening document…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`app is-${mode}`}>
      <header className="topbar">
        <button className="logo" onClick={onHome} title="All documents" aria-label="All documents">
          <Logo size={17} variant={mode === 'narrow' ? 'mark' : 'full'} />
        </button>

        <button
          className="icon-button"
          title="Search and commands (⌘K)"
          aria-label="Search and commands"
          onClick={() => setShowPalette(true)}
        ><Icon name="search" size={15} /></button>

        {overlay && (
          <button
            className={`icon-button panel-toggle${openPanel === 'left' ? ' is-active' : ''}`}
            title="Layers, components and tokens"
            aria-label="Toggle the left panel"
            aria-expanded={openPanel === 'left'}
            onClick={() => setOpenPanel((p) => (p === 'left' ? null : 'left'))}
          ><Icon name="layers" size={16} /></button>
        )}

        <input
          className="doc-name"
          aria-label="Document name"
          key={`${doc.id}-${version}`}
          defaultValue={doc.name}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== doc.name) dispatch([{ t: 'doc', name }]);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
        />

        <div className="topbar-spacer" />

        {peers.length > 0 && (
          <div className="peers" title={peers.map((p) => p.name).join(', ')}>
            {peers.slice(0, 5).map((p) => (
              <span key={p.clientId} className="peer-dot" style={{ background: p.color }} title={p.name}>
                {p.kind === 'agent' ? <Icon name="agent" size={12} /> : p.name.charAt(0).toUpperCase()}
              </span>
            ))}
          </div>
        )}

        {mode === 'narrow' ? (
          <span className="overflow-anchor">
            <button
              className="icon-button"
              title="More actions"
              aria-label="More actions"
              aria-expanded={showOverflow}
              onClick={() => setShowOverflow((v) => !v)}
            ><Icon name="chevronDown" size={15} /></button>
            {showOverflow && (
              <OverflowMenu
                onClose={() => setShowOverflow(false)}
                items={[
                  { label: 'Import a webpage', icon: 'download', run: () => setModal('import') },
                  { label: 'Export', icon: 'upload', run: () => setModal('export') },
                  { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => setModal('shortcuts') },
                  { label: 'Appearance', icon: 'settings', run: () => setShowSettings(true) },
                ]}
              />
            )}
          </span>
        ) : (
          <>
            <button
              className="icon-button"
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
              onClick={() => setModal('shortcuts')}
            ><Icon name="keyboard" size={15} /></button>

            <button
              className="icon-button"
              title="Appearance"
              aria-label="Appearance"
              aria-expanded={showSettings}
              onClick={() => setShowSettings((v) => !v)}
            ><Icon name="settings" size={15} /></button>

            <span className="topbar-divider" />

            <button className="button" onClick={() => setModal('import')} title="Bring a live webpage onto the canvas">
              <Icon name="download" size={14} />
              <span className="button-label">Import</span>
            </button>
            <button className="button" onClick={() => setModal('export')} title="Export this design (\u2318\u21e7E)">
              <Icon name="upload" size={14} />
              <span className="button-label">Export</span>
            </button>
          </>
        )}

        <button className="button primary" onClick={() => setModal('connect')} title="Connect an agent">
          <Icon name="sparkle" size={14} />
          <span className="button-label">Connect agent</span>
        </button>


        {overlay && (
          <button
            className={`icon-button panel-toggle${openPanel === 'right' ? ' is-active' : ''}`}
            title="Properties"
            aria-label="Toggle the properties panel"
            aria-expanded={openPanel === 'right'}
            onClick={() => setOpenPanel((p) => (p === 'right' ? null : 'right'))}
          ><Icon name="settings" size={16} /></button>
        )}
      </header>

      {showSettings && (
        <Settings appearance={appearance} onChange={onAppearance} onClose={() => setShowSettings(false)} />
      )}

      {agentActivity?.active && (
        <div className="agent-banner">
          <span className="pulse" />
          <strong>{agentActivity.agent}</strong>
          {agentActivity.summary ? ` — ${agentActivity.summary}` : ' is working on this document'}
        </div>
      )}

      <div className="workspace">
        {overlay && openPanel && (
          <div className="rail-scrim" onPointerDown={() => setOpenPanel(null)} aria-hidden />
        )}

        <aside className={`rail rail-left${leftOpen ? ' is-open' : ''}`} {...hiddenWhenClosed(leftOpen)}>
          <nav className="rail-tabs" aria-label="Panels">
            {LEFT_TABS.map((t) => (
              <button
                key={t.id}
                className={leftTab === t.id ? 'is-active' : ''}
                onClick={() => setLeftTab(t.id)}
                title={`${t.label} — ${t.hint}`}
                aria-label={t.label}
                aria-pressed={leftTab === t.id}
              >
                <Icon name={t.icon} size={15} />
              </button>
            ))}
          </nav>

          <div className="rail-heading">
            {LEFT_TABS.find((t) => t.id === leftTab)?.label}
          </div>
          <ScrollArea className="rail-body">
            {leftTab === 'layers' && <Layers />}
            {leftTab === 'pages' && (
              <div className="pages">
                {doc.pages.map((p) => (
                  <button
                    key={p.id}
                    className={`page-row${p.id === pageId ? ' is-active' : ''}`}
                    onClick={() => setPage(p.id)}
                  >
                    {p.name}
                    <span className="dim">{p.artboards.length}</span>
                  </button>
                ))}
                <button
                  className="button subtle full"
                  onClick={() => {
                    const name = window.prompt('Page name', `Page ${doc.pages.length + 1}`);
                    if (!name) return;
                    const page = { id: `p_${Math.random().toString(36).slice(2, 10)}`, name, artboards: [] };
                    dispatch([{ t: 'page', action: 'add', page }]);
                    setPage(page.id);
                  }}
                >+ New page</button>
              </div>
            )}
            {leftTab === 'components' && <Components />}
            {leftTab === 'tokens' && <Tokens />}
            {leftTab === 'review' && <Review />}
            {leftTab === 'history' && <History />}
          </ScrollArea>
        </aside>

        <main className="stage">
          <Canvas onContextMenu={setContextMenu} />
          <Toolbar compact={mode === 'narrow'} />
        </main>

        <aside className={`rail rail-right${rightOpen ? ' is-open' : ''}`} {...hiddenWhenClosed(rightOpen)}>
          <ScrollArea className="rail-body">
            <Properties />
          </ScrollArea>
        </aside>
      </div>

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          actions={{
            openImport: () => setModal('import'),
            openExport: () => setModal('export'),
            openConnect: () => setModal('connect'),
            openShortcuts: () => setModal('shortcuts'),
            openPanel: (tab) => { setLeftTab(tab as LeftTab); if (overlay) setOpenPanel('left'); },
            goHome: onHome,
          }}
        />
      )}

      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onExport={() => setModal('export')}
        />
      )}

      {modal === 'connect' && <ConnectAgent onClose={() => setModal(null)} />}
      {modal === 'export' && <Export onClose={() => setModal(null)} />}
      {modal === 'import' && <Import onClose={() => setModal(null)} />}
      {modal === 'shortcuts' && <Shortcuts onClose={() => setModal(null)} />}

      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useCanvas((s) => s.toasts);
  const dismiss = useCanvas((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.tone}`} onClick={() => dismiss(t.id)} role="status">
          {t.message}
        </div>
      ))}
    </div>
  );
}
