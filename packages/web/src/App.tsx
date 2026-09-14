/** Application shell: routing, layout, panels and global interactions. */

import { useEffect, useState } from 'react';
import { useCanvas } from './state/store.ts';
import { connectDocument } from './net/socket.ts';
import { useKeyboard } from './hooks/useKeyboard.ts';
import { useClipboard } from './hooks/useClipboard.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { Layers } from './panels/Layers.tsx';
import { Properties } from './panels/Properties.tsx';
import { Tokens } from './panels/Tokens.tsx';
import { History } from './panels/History.tsx';
import { ConnectAgent } from './panels/ConnectAgent.tsx';
import { Export } from './panels/Export.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import { Home } from './Home.tsx';

type LeftTab = 'layers' | 'pages' | 'tokens' | 'history';

export function App() {
  const [docId, setDocId] = useState<string | null>(() => docIdFromLocation());

  useEffect(() => {
    const onPop = () => setDocId(docIdFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!docId) {
    return <Home onOpen={(id) => { history.pushState({}, '', `/d/${id}`); setDocId(id); }} />;
  }
  return <Editor docId={docId} onHome={() => { history.pushState({}, '', '/'); setDocId(null); }} />;
}

function docIdFromLocation(): string | null {
  const m = /^\/d\/([\w-]+)/.exec(location.pathname);
  return m ? m[1]! : null;
}

function Editor({ docId, onHome }: { docId: string; onHome: () => void }) {
  const connection = useCanvas((s) => s.connection);
  const fatalError = useCanvas((s) => s.fatalError);
  const doc = useCanvas((s) => s.doc);
  const version = useCanvas((s) => s.version);
  const pageId = useCanvas((s) => s.pageId);
  const setPage = useCanvas((s) => s.setPage);
  const peers = useCanvas((s) => s.peers);
  const agentActivity = useCanvas((s) => s.agentActivity);
  const dispatch = useCanvas((s) => s.dispatch);

  const [leftTab, setLeftTab] = useState<LeftTab>('layers');
  const [modal, setModal] = useState<'connect' | 'export' | null>(null);

  useKeyboard();
  useClipboard();

  useEffect(() => {
    const conn = connectDocument(docId);
    return () => conn.close();
  }, [docId]);

  if (!doc) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <h1>Canvas</h1>
          {fatalError ? (
            <>
              <p className="boot-error">{fatalError}</p>
              <button className="button primary" onClick={onHome}>Back to all documents</button>
            </>
          ) : (
            <p>{connection === 'closed' ? 'Reconnecting…' : 'Opening document…'}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="logo" onClick={onHome} title="All documents">◧ Canvas</button>

        <input
          className="doc-name"
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
              <span key={p.clientId} className="peer-dot" style={{ background: p.color }}>
                {p.kind === 'agent' ? '🤖' : p.name.charAt(0).toUpperCase()}
              </span>
            ))}
          </div>
        )}

        <span className={`conn-status is-${connection}`} title={`Connection: ${connection}`}>
          {connection === 'open' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}
        </span>

        <button className="button" onClick={() => setModal('export')}>Export</button>
        <button className="button primary" onClick={() => setModal('connect')}>Connect agent</button>
      </header>

      {agentActivity?.active && (
        <div className="agent-banner">
          <span className="pulse" />
          <strong>{agentActivity.agent}</strong>
          {agentActivity.summary ? ` — ${agentActivity.summary}` : ' is working on this document'}
        </div>
      )}

      <div className="workspace">
        <aside className="rail rail-left">
          <nav className="rail-tabs">
            {(['layers', 'pages', 'tokens', 'history'] as LeftTab[]).map((t) => (
              <button key={t} className={leftTab === t ? 'is-active' : ''} onClick={() => setLeftTab(t)}>
                {t}
              </button>
            ))}
          </nav>
          <div className="rail-body">
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
            {leftTab === 'tokens' && <Tokens />}
            {leftTab === 'history' && <History />}
          </div>
        </aside>

        <main className="stage">
          <Canvas />
          <Toolbar />
        </main>

        <aside className="rail rail-right">
          <Properties />
        </aside>
      </div>

      {modal === 'connect' && <ConnectAgent onClose={() => setModal(null)} />}
      {modal === 'export' && <Export onClose={() => setModal(null)} />}

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
