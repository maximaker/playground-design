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
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';

interface ConnectionRow {
  code: string; label: string | null;
  createdAt: number; redeemedAt: number | null; lastUsedAt: number | null;
}

interface SetupInfo {
  claudeCode: string;
  codex: string;
  claudeDesktop: unknown;
  cursor: unknown;
  vscode: unknown;
}

type Client = 'claudeApp' | 'claudeCode' | 'codex' | 'claudeDesktop' | 'cursor' | 'vscode';

const CLIENT_LABELS: Record<Client, string> = {
  claudeApp: 'Claude app or website',
  claudeCode: 'Claude Code',
  codex: 'Codex',
  claudeDesktop: 'Claude Desktop (config file)',
  cursor: 'Cursor',
  vscode: 'VS Code / Copilot',
};

/** Clients configured from a terminal rather than by editing a JSON file. */
const TERMINAL_CLIENTS: Client[] = ['claudeCode', 'codex'];

export function ConnectAgent({ onClose }: { onClose: () => void }) {
  const docId = useCanvas((s) => s.docId);
  const peers = useCanvas((s) => s.peers);
  const toast = useCanvas((s) => s.toast);

  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [latest, setLatest] = useState<{ code: string; url: string; setup: SetupInfo } | null>(null);
  const [client, setClient] = useState<Client>('claudeApp');
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
        body: JSON.stringify({ label: CLIENT_LABELS[client] }),
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
    toast('Link turned off', 'success');
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast('Copied', 'success');
  };

  const command = latest ? snippetFor(client, latest.setup) : '';
  const agentPeers = peers.filter((p) => p.kind === 'agent');

  const isLocal = latest ? /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(latest.url) : false;

  return (
    <Modal title={'Work on this page with AI'} onClose={onClose}>
          <p className="modal-lede">
            Connect an AI assistant such as Claude and ask it for changes in plain words —
            “make the headline friendlier”, “add a section with prices”. You see every change
            here as it happens, and can undo any of it.
          </p>

          <div className="field is-wide">
            <span className="field-label">Which assistant do you use?</span>
            <div className="client-tabs">
              {(Object.keys(CLIENT_LABELS) as Client[]).map((c) => (
                <button key={c} className={client === c ? 'is-active' : ''} onClick={() => setClient(c)}>
                  {CLIENT_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {agentPeers.length > 0 && (
            <div className="connect-live">
              <Icon name="check" size={14} />
              <span>
                <strong>Connected.</strong> Try asking it: “Describe what is on my Playground page, then suggest three improvements.”
              </span>
            </div>
          )}

          {!latest ? (
            <div className="connect-create">
              <button className="button primary" onClick={create} disabled={busy}>
                {busy ? 'One moment…' : 'Get my connection link'}
              </button>
              <span className="dim">A private link that lets your assistant edit this page only.</span>
            </div>
          ) : (
            <>
              {client === 'claudeApp' ? (
                <ol className="connect-steps">
                  <li>
                    Copy your private link:
                    <div className="snippet">
                      <pre>{latest.url}</pre>
                      <button className="button" onClick={() => copy(latest.url)}>Copy link</button>
                    </div>
                  </li>
                  <li>In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</li>
                  <li>Name it <strong>Playground</strong>, paste the link, and save.</li>
                  <li>Start a chat, turn on Playground from the tools menu, and ask for what you want.</li>
                </ol>
              ) : (
                <ol className="connect-steps">
                  <li>
                    {TERMINAL_CLIENTS.includes(client) ? 'Run this in your terminal:' : 'Add this to the app’s MCP settings file:'}
                    <div className="snippet">
                      <pre>{command}</pre>
                      <button className="button" onClick={() => copy(command)}>Copy</button>
                    </div>
                  </li>
                  {!TERMINAL_CLIENTS.includes(client) && <li>Restart the app.</li>}
                  <li>Ask it to “describe what is on my Playground page”.</li>
                </ol>
              )}

              {isLocal && client === 'claudeApp' && (
                <p className="connect-warning">
                  This Playground runs on your own computer, so Claude’s website cannot reach it.
                  Use the online Playground, or Claude Code on this computer.
                </p>
              )}

              <details className="modal-details">
                <summary>What the assistant can do</summary>
                <ul>
                  <li>Look at the page — its structure and a screenshot of it</li>
                  <li>Add new sections and change text, colours, sizes and layout</li>
                  <li>Rename, move, copy and delete parts of the page</li>
                  <li>Export images and code (for developers: JSX, Tailwind, HTML)</li>
                </ul>
                <p>
                  Its changes are labelled with its name in the history at the bottom, and a
                  restore point is saved before any bigger change, so you can always go back.
                </p>
              </details>
            </>
          )}

          {connections.length > 0 && (
            <details className="connect-list">
              <summary>Links you have made ({connections.length})</summary>
              {connections.map((c) => (
                <div key={c.code} className="connect-row">
                  <div>
                    <strong>{c.label ?? 'Agent'}</strong>
                    <span className="dim">
                      {c.redeemedAt
                        ? `last used ${relative(c.lastUsedAt ?? c.redeemedAt)}`
                        : 'not used yet — stops working 30 minutes after it was made'}
                    </span>
                  </div>
                  <button className="button subtle" onClick={() => revoke(c.code)}>Turn off</button>
                </div>
              ))}
            </details>
          )}

          <p className="security-note">
            Keep the link private: anyone who has it can change this page. Turn off links you no longer use.
          </p>
    </Modal>
  );
}

function snippetFor(client: Client, setup: SetupInfo): string {
  if (client === 'claudeApp') return '';
  if (client === 'claudeCode') return setup.claudeCode;
  if (client === 'codex') return setup.codex;
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
