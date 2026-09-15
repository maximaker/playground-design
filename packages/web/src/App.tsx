/** Application shell: routing, layout, panels and global interactions. */

import { Fragment, useEffect, useRef, useState } from 'react';
import { useCanvas } from './state/store.ts';
import { type Source, connectDocument } from './net/socket.ts';
import { useKeyboard } from './hooks/useKeyboard.ts';
import { useLayoutMode, panelsOverlay } from './hooks/useLayout.ts';
import { useClipboard } from './hooks/useClipboard.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { Layers } from './panels/Layers.tsx';
import { Properties } from './panels/Properties.tsx';
import { Tokens } from './panels/Tokens.tsx';
import { Components } from './panels/Components.tsx';
import { Review } from './panels/Review.tsx';
import { Spec } from './panels/Spec.tsx';
import { Comments } from './panels/Comments.tsx';
import { HistoryBar } from './ui/HistoryBar.tsx';
import { Crumbs } from './ui/Crumbs.tsx';
import { ConnectAgent } from './panels/ConnectAgent.tsx';
import { Share } from './panels/Share.tsx';
import { Present } from './Present.tsx';
import { artboardOf } from '@playground/shared';
import { Export } from './panels/Export.tsx';
import { Import } from './panels/Import.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import { ContextMenu, type ContextMenuState } from './ui/ContextMenu.tsx';
import { Shortcuts } from './ui/Shortcuts.tsx';
import { Icon, type IconName } from './ui/Icon.tsx';
import { Logo } from './ui/Logo.tsx';
import { Settings } from './ui/Settings.tsx';
import { Landing } from './Landing.tsx';
import { Join } from './Join.tsx';
import { AccountMenu } from './ui/AccountMenu.tsx';
import { useSession } from './state/session.ts';
import { OverflowMenu } from './ui/OverflowMenu.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { AgentChangeBar } from './ui/AgentChangeBar.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';
import {
  type Appearance, applyAppearance, loadAppearance, saveAppearance, watchSystemTheme,
} from './state/appearance.ts';
import { Home } from './Home.tsx';

type LeftTab = 'layers' | 'pages' | 'components' | 'tokens';

/**
 * The left rail is the document's structure. The right rail is how you are
 * looking at it: the design of the selection, its spec, the conversation about
 * it, the problems in it.
 *
 * The lenses moved here because that is what they are — ways of looking, not
 * parts of the file. Opening one is meant to change the canvas: Comments shows
 * its pins, Review outlines what it found.
 */
type RightTab = 'properties' | 'spec' | 'comments' | 'review';

const RIGHT_TABS: { id: RightTab; icon: IconName; label: string; hint: string }[] = [
  { id: 'properties', icon: 'settings', label: 'Design', hint: 'Edit the selected layer' },
  { id: 'spec', icon: 'ruler', label: 'Spec', hint: 'Measured size, tokens, notes and code to paste' },
  { id: 'comments', icon: 'comment', label: 'Comments', hint: 'The conversation about this design — shows the pins while open' },
  { id: 'review', icon: 'check', label: 'Review', hint: 'Contrast, tap targets, tokens and layout — outlines what it finds' },
];

const LEFT_TABS: { id: LeftTab; icon: IconName; label: string; hint: string }[] = [
  { id: 'layers', icon: 'layers', label: 'Layers', hint: 'The structure of this page' },
  { id: 'pages', icon: 'page', label: 'Pages', hint: 'Pages in this document' },
  { id: 'components', icon: 'component', label: 'Components', hint: 'Reusable components and their variants' },
  { id: 'tokens', icon: 'palette', label: 'Tokens', hint: 'Design tokens and themes' },
];

export function App() {
  const [source, setSource] = useState<Source | null>(() => sourceFromLocation());
  const [joining, setJoining] = useState<string | null>(() => joinFromLocation());
  const session = useSession();
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
    const onPop = () => { setSource(sourceFromLocation()); setJoining(joinFromLocation()); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A share link is the one route that works signed out: the token is the
  // credential, and sending a reviewer to a sign-in form would defeat the link.
  if (session.loading && source?.kind !== 'share') {
    return <div className="boot" aria-busy>Loading…</div>;
  }

  // An invitation needs an account, but it explains itself first — and carries
  // the person back to the invitation once they have signed in.
  if (joining) {
    return (
      <Join
        token={joining}
        user={session.user}
        hasAccounts={session.hasAccounts}
        signupCodeRequired={session.signupCodeRequired}
        onSignedIn={() => { void session.refresh(); }}
        onOpen={(id) => {
          history.pushState({}, '', `/d/${id}`);
          setJoining(null);
          setSource({ kind: 'doc', id });
        }}
      />
    );
  }

  if (!session.user && source?.kind !== 'share') {
    return (
      <Landing
        hasAccounts={session.hasAccounts}
        signupCodeRequired={session.signupCodeRequired}
        onSignedIn={() => { void session.refresh(); }}
      />
    );
  }

  if (!source) {
    return (
      <Home
        onOpen={(id) => { history.pushState({}, '', `/d/${id}`); setSource({ kind: 'doc', id }); }}
        appearance={appearance}
        onAppearance={setAppearance}
        session={session}
      />
    );
  }
  return (
    <Editor
      key={source.kind === 'doc' ? source.id : source.token}
      source={source}
      // A viewer arrived by link and has no library to go back to; sending them
      // to a list of documents they cannot open would be a dead end.
      onHome={source.kind === 'doc'
        ? () => { history.pushState({}, '', '/'); setSource(null); }
        : null}
      appearance={appearance}
      onAppearance={setAppearance}
      session={session}
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

function sourceFromLocation(): Source | null {
  const doc = /^\/d\/([\w-]+)/.exec(location.pathname);
  if (doc) return { kind: 'doc', id: doc[1]! };
  const share = /^\/s\/([\w-]+)/.exec(location.pathname);
  if (share) return { kind: 'share', token: share[1]! };
  return null;
}

/**
 * The invitation being followed, if any.
 *
 * Kept apart from `Source` because an invitation is not a document the editor
 * can open — it is a thing you accept, which then produces one. Tokens are
 * base64url, so they carry `-` and `_` as well as word characters.
 */
function joinFromLocation(): string | null {
  return /^\/join\/([\w-]+)/.exec(location.pathname)?.[1] ?? null;
}

function Editor({ source, onHome, appearance, onAppearance, session }: {
  session: ReturnType<typeof useSession>;
  source: Source;
  onHome: (() => void) | null;
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

  // A command can ask for a panel — "go to component" selects a node that lives
  // in no page, and doing that without showing where would look like nothing
  // happened.
  /*
   * Presenting starts on the frame you are looking at.
   *
   * Starting at the first frame every time is the behaviour that makes people
   * stop using the button: you are usually presenting the thing you have open,
   * not the deck from the top.
   */
  const startPresenting = () => {
    const state = useCanvas.getState();
    const page = state.doc?.pages.find((p) => p.id === state.pageId) ?? state.doc?.pages[0];
    if (!page || !page.artboards.length) { state.toast('This page has no frames to present', 'error'); return; }
    const selected = state.selection[0]?.split('::')[0];
    const board = selected ? artboardOf(state.doc!, selected) : null;
    const index = board ? Math.max(0, page.artboards.indexOf(board)) : 0;
    state.setPresent({ pageId: page.id, index });
  };

  const present = useCanvas((s) => s.present);

  // The presentation is in the URL, so it survives a reload and can be sent to
  // someone: a link that opens on frame four opens on frame four.
  // Skipped on the first run: this effect and the one below it both fire after
  // the first render, and this one would strip the parameters out of the URL
  // before the other had read them.
  const urlSynced = useRef(false);
  useEffect(() => {
    if (!urlSynced.current) {
      urlSynced.current = true;
      if (!present) return;
    }
    const url = new URL(window.location.href);
    const had = url.searchParams.has('present');
    if (present) {
      url.searchParams.set('present', present.pageId);
      url.searchParams.set('frame', String(present.index + 1));
    } else {
      if (!had) return;
      url.searchParams.delete('present');
      url.searchParams.delete('frame');
    }
    window.history.replaceState(null, '', url.toString());
  }, [present]);

  // And read back on arrival, once the document is there to check it against.
  const docReady = !!doc;
  useEffect(() => {
    if (!docReady) return;
    const url = new URL(window.location.href);
    const pageId = url.searchParams.get('present');
    if (!pageId) return;
    const state = useCanvas.getState();
    const page = state.doc?.pages.find((p) => p.id === pageId) ?? state.doc?.pages[0];
    if (!page) return;
    const frame = Math.max(1, Number(url.searchParams.get('frame') ?? 1)) - 1;
    state.setPresent({ pageId: page.id, index: frame });
    // Once: re-running would drag a presenter back to the linked frame every
    // time the document changed under them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docReady]);

  const panelRequest = useCanvas((s) => s.panelRequest);
  useEffect(() => {
    if (!panelRequest) return;
    if (LEFT_TABS.some((t) => t.id === panelRequest)) {
      setLeftTab(panelRequest as LeftTab);
      setOpenPanel('left');
    } else if (RIGHT_TABS.some((t) => t.id === panelRequest)) {
      setRightTab(panelRequest as RightTab);
    }
    useCanvas.getState().requestPanel(null);
  }, [panelRequest]);
  // Someone holding a view-only link is there to read the design, not to look at
  // controls they cannot use: the inspector opens on the spec for them.
  const [rightTab, setRightTab] = useState<RightTab>(source.kind === 'share' ? 'spec' : 'properties');
  const [modal, setModal] = useState<'connect' | 'share' | 'export' | 'import' | 'shortcuts' | null>(null);
  const contextMenu = useCanvas((s) => s.contextMenu) as ContextMenuState | null;
  const setContextMenu = useCanvas((s) => s.openContextMenu);
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

  const readOnly = source.kind === 'share';
  // Subscribed to the depths rather than the arrays, so a new entry only
  // re-renders the header when it changes whether the buttons are usable.
  const canUndo = useCanvas((s) => s.undoStack.length > 0);
  // Tooltips name the key the reader actually has.
  const modKey = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const canRedo = useCanvas((s) => s.redoStack.length > 0);

  useEffect(() => {
    useCanvas.getState().setReadOnly(readOnly);
    const conn = connectDocument(source);
    return () => conn.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind === 'doc' ? source.id : source.token]);

  if (!doc) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <Logo size={34} />
          {fatalError ? (
            <>
              <p className="boot-error">{fatalError}</p>
              {/^sign in/i.test(fatalError) ? (
                <a className="button primary" href="/">Sign in</a>
              ) : (
                <>
                  {/access/i.test(fatalError) && (
                    <p className="boot-hint dim">
                      It exists, but you are not on it. Ask whoever sent the link to add you —
                      they can do that from People in the right rail.
                    </p>
                  )}
                  {onHome && <button className="button primary" onClick={onHome}>Back to all documents</button>}
                </>
              )}
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
        {onHome ? (
          <button className="logo" onClick={onHome} title="All documents" aria-label="All documents">
            <Logo size={17} variant={mode === 'narrow' ? 'mark' : 'full'} />
          </button>
        ) : (
          <span className="logo">
            <Logo size={17} variant={mode === 'narrow' ? 'mark' : 'full'} />
          </span>
        )}

        <button
          className="icon-button"
          title="Search and commands (⌘K)"
          aria-label="Search and commands"
          onClick={() => setShowPalette(true)}
        ><Icon name="search" size={15} /></button>

        {/*
          * Undo and redo are in the toolbar with the tools now — they act on the
          * canvas, and this corner is the furthest point on screen from where
          * the work happens. On a phone the toolbar drops them for width and the
          * overflow menu carries them, which is where they were before; putting
          * them back in the topbar there overflowed it.
          */}

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
          readOnly={readOnly}
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
                  ...(readOnly ? [] : [
                    { label: 'Undo', icon: 'undo' as IconName, run: () => useCanvas.getState().undo() },
                    { label: 'Redo', icon: 'redo' as IconName, run: () => useCanvas.getState().redo() },
                    { label: 'Import a webpage', icon: 'download' as IconName, run: () => setModal('import') },
                    { label: 'Share a link', icon: 'share' as IconName, run: () => setModal('share') },
                  ]),
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

            {session.user && (
              <AccountMenu user={session.user} onSignedOut={() => { void session.refresh(); }} />
            )}

            <span className="topbar-divider" />

            {!readOnly && (
              <button className="button" onClick={() => setModal('import')} title="Bring a live webpage onto the canvas">
                <Icon name="download" size={14} />
                <span className="button-label">Import</span>
              </button>
            )}
            <button className="button" onClick={() => setModal('export')} title="Export this design (\u2318\u21e7E)">
              <Icon name="upload" size={14} />
              <span className="button-label">Export</span>
            </button>
          </>
        )}

        {/* Present is for everyone, including a viewer on a share link: showing
            the work is most of what a link is for. */}
        <button className="button" onClick={startPresenting} title="Present this page (P)">
          <Icon name="play" size={14} />
          <span className="button-label">Present</span>
        </button>

        {!readOnly && (
          <>
            <button className="button" onClick={() => setModal('share')} title="Create a read-only link">
              <Icon name="share" size={14} />
              <span className="button-label">Share</span>
            </button>
            <button className="button primary" onClick={() => setModal('connect')} title="Connect an agent">
              <Icon name="sparkle" size={14} />
              <span className="button-label">Connect agent</span>
            </button>
          </>
        )}

        {readOnly && (
          <span className="view-badge" title="You are looking at a shared link. Nothing you do changes the document.">
            <Icon name="eye" size={13} /> View only
          </span>
        )}


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
                className={`tip is-bottom${leftTab === t.id ? ' is-active' : ''}`}
                onClick={() => setLeftTab(t.id)}
                data-tip={`${t.label} — ${t.hint}`}
                aria-label={t.label}
                aria-pressed={leftTab === t.id}
              >
                <Icon name={t.icon} size={15} />
              </button>
            ))}
          </nav>

          {/* Heading and content are one card on the rail's plate: the rail is
              furniture, the panel is content, and nesting says so without a rule. */}
          <div className="rail-panel">
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
          </ScrollArea>
          </div>
        </aside>

        <main className="stage">
          <Canvas onContextMenu={setContextMenu} />

          {/*
            * One stack along the bottom, rather than three things each pinned at
            * their own offset: the history bar changes height when it opens, and
            * a toolbar positioned a fixed distance above it ends up underneath.
            */}
          <div className="stage-bottom">
            <AgentChangeBar />
            <Toolbar compact={mode === 'narrow'} />
            {/* History is a record of what has been done to the document, not
                part of what the document is, so it is not in a rail. */}
            <HistoryBar />
          </div>
        </main>

        <aside className={`rail rail-right${rightOpen ? ' is-open' : ''}`} {...hiddenWhenClosed(rightOpen)}>
          {/* The same tabs as the left rail. One tab style in the application. */}
          <nav className="rail-tabs" aria-label="Inspector">
            {RIGHT_TABS.map((t) => (
              <button
                key={t.id}
                className={`tip is-bottom${rightTab === t.id ? ' is-active' : ''}`}
                onClick={() => setRightTab(t.id)}
                data-tip={`${t.label} — ${t.hint}`}
                aria-label={t.label}
                aria-pressed={rightTab === t.id}
              >
                <Icon name={t.icon} size={15} />
              </button>
            ))}
          </nav>

          <div className="rail-panel">
          <div className="rail-heading">
            {RIGHT_TABS.find((t) => t.id === rightTab)?.label}
          </div>

          {/* Where the selection sits, for the two panels that are about it. */}
          {(rightTab === 'properties' || rightTab === 'spec') && <Crumbs />}

          <ScrollArea className="rail-body">
            {rightTab === 'spec' && <Spec />}
            {rightTab === 'comments' && <Comments />}
            {rightTab === 'review' && <Review />}
            {rightTab === 'properties' && (
              /*
                * A viewer keeps the properties panel — reading the real values is
                * most of why you send someone a link — but every control inside is
                * disabled natively. A `fieldset` does that in one place and cannot
                * be forgotten, which a per-control `disabled` prop could.
                */
              <fieldset className="rail-fieldset" disabled={readOnly}>
                <Properties />
              </fieldset>
            )}
          </ScrollArea>
          </div>
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
            goHome: onHome ?? (() => {}),
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
      {modal === 'share' && <Share onClose={() => setModal(null)} />}

      {/* Over everything, including the modals: presenting is the whole window. */}
      <Present />
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
