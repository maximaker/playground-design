/**
 * The Connect agent panel — the thing that makes this an agent-connected tool
 * rather than a design tool with an API.
 *
 * Because Canvas is web-only, the MCP endpoint is hosted and a connection code
 * binds it to this document. The code is the only thing protecting write access
 * in v1, so the UI is explicit about that and makes revoking easy.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCanvas } from '../state/store.ts';

interface ConnectionRow {
  code: string; label: string | null;
  createdAt: number; redeemedAt: number | null; lastUsedAt: number | null;
}

interface SetupInfo {
  claudeCode: string;
  claudeDesktop: unknown;
  cursor: unknown;
  vscode: unknown;
}

type Client = 'claudeCode' | 'claudeDesktop' | 'cursor' | 'vscode';

const CLIENT_LABELS: Record<Client, string> = {
  claudeCode: 'Claude Code',
  claudeDesktop: 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code / Copilot',
};

export function ConnectAgent({ onClose }: { onClose: () => void }) {
  const docId = useCanvas((s) => s.docId);
  const peers = useCanvas((s) => s.peers);
  const toast = useCanvas((s) => s.toast);

  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [latest, setLatest] = useState<{ code: string; url: string; setup: SetupInfo } | null>(null);
  const [client, setClient] = useState<Client>('claudeCode');
  const [label, setLabel] = useState('Claude Code');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!docId) return;
    const res = await fetch(`/api/documents/${docId}/connections`);
    const body = (await res.json()) as { connections: ConnectionRow[] };
    setConnections(body.connections);
  }, [docId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!docId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${docId}/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || 'Agent' }),
      });
      const body = (await res.json()) as { connection: ConnectionRow; url: string; setup: SetupInfo };
      setLatest({ code: body.connection.code, url: body.url, setup: body.setup });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    await fetch(`/api/connections/${code}`, { method: 'DELETE' });
    if (latest?.code === code) setLatest(null);
    await refresh();
    toast('Connection revoked', 'success');
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast('Copied', 'success');
  };

  const command = latest ? snippetFor(client, latest.setup) : '';
  const agentPeers = peers.filter((p) => p.kind === 'agent');

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Connect an agent</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="modal-body">
          <p className="modal-lede">
            Generate a connection code, then paste the setup line into your coding agent. The agent
            gets read and write access to <strong>this document</strong> — it can inspect the tree,
            take screenshots, write HTML, and restyle layers.
          </p>

          {!latest ? (
            <div className="connect-create">
              <label className="field is-wide">
                <span className="field-label">Name this connection</span>
                <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <button className="button primary" onClick={create} disabled={busy}>
                {busy ? 'Generating…' : 'Generate code'}
              </button>
            </div>
          ) : (
            <>
              <div className="code-display">
                <code>{latest.code}</code>
                <button className="button" onClick={() => copy(latest.code)}>Copy code</button>
              </div>

              <div className="client-tabs">
                {(Object.keys(CLIENT_LABELS) as Client[]).map((c) => (
                  <button key={c} className={client === c ? 'is-active' : ''} onClick={() => setClient(c)}>
                    {CLIENT_LABELS[c]}
                  </button>
                ))}
              </div>

              <div className="snippet">
                <pre>{command}</pre>
                <button className="button" onClick={() => copy(command)}>Copy</button>
              </div>

              <p className="panel-hint">
                {client === 'claudeCode'
                  ? 'Run that in your terminal, then ask the agent to "describe what is on the Canvas artboard".'
                  : 'Add that to your MCP configuration, restart the client, then ask it to describe the artboard.'}
              </p>

              <details className="modal-details">
                <summary>What the agent can do</summary>
                <ul>
                  <li>Read structure cheaply (<code>get_tree_summary</code>) and see it (<code>get_screenshot</code>)</li>
                  <li>Create layers by writing HTML (<code>write_html</code>)</li>
                  <li>Restyle, rename, move, duplicate and delete layers</li>
                  <li>Pull JSX or Tailwind for any layer (<code>get_jsx</code>)</li>
                  <li>Export PNG, JPG, SVG and standalone HTML</li>
                </ul>
                <p>
                  Its edits appear here live, are attributed to it in version history, and are
                  undoable. A restore point is saved before any multi-step work.
                </p>
              </details>
            </>
          )}

          {agentPeers.length > 0 && (
            <div className="connect-live">
              {agentPeers.length} agent{agentPeers.length === 1 ? '' : 's'} connected right now
            </div>
          )}

          {connections.length > 0 && (
            <div className="connect-list">
              <h3>Existing connections</h3>
              {connections.map((c) => (
                <div key={c.code} className="connect-row">
                  <div>
                    <strong>{c.label ?? 'Agent'}</strong>
                    <code className="dim">{c.code}</code>
                    <span className="dim">
                      {c.redeemedAt
                        ? `last used ${relative(c.lastUsedAt ?? c.redeemedAt)}`
                        : 'not yet connected — expires 30 min after creation'}
                    </span>
                  </div>
                  <button className="button subtle" onClick={() => revoke(c.code)}>Revoke</button>
                </div>
              ))}
            </div>
          )}

          <p className="security-note">
            There are no accounts in this version, so anyone holding a connection code can edit this
            document. Revoke codes you are no longer using.
          </p>
        </div>
      </div>
    </div>
  );
}

function snippetFor(client: Client, setup: SetupInfo): string {
  if (client === 'claudeCode') return setup.claudeCode;
  const value = client === 'claudeDesktop' ? setup.claudeDesktop : client === 'cursor' ? setup.cursor : setup.vscode;
  return JSON.stringify(value, null, 2);
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
