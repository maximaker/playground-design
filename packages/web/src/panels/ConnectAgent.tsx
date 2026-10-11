/**
 * The Connect agent panel — the thing that makes this an agent-connected tool
 * rather than a design tool with an API.
 *
 * Because Canvas is web-only, the MCP endpoint is hosted and a connection code
 * binds it to this document. The code is the only thing protecting write access
 * in v1, so the UI is explicit about that and makes revoking easy.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCanvas, getDoc } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';

interface ConnectionRow {
  code: string; label: string | null;
  createdAt: number; redeemedAt: number | null; lastUsedAt: number | null;
  /** Scoped, expiring links. Absent on servers that predate them. */
  expiresAt?: number | null;
  readOnly?: boolean;
  scope?: LinkScope;
  projectId?: string | null;
}

type LinkScope =
  | { kind: 'document' }
  | { kind: 'project'; projectId?: string }
  | { kind: 'sections'; sectionIds: string[] };

type Expiry = '1h' | '1d' | '7d' | 'never';

const EXPIRY_LABELS: Record<Expiry, string> = { '1h': '1 hour', '1d': '1 day', '7d': '7 days', never: 'Never' };

/**
 * Whether the server understands link options. Detected from what it sends
 * back - a list row or a fresh link carrying `expiresAt` - so this UI can ship
 * before the server does and appear the moment it lands. The local flag is for
 * trying the UI against a server that has not caught up.
 */
function serverHasLinkOptions(rows: ConnectionRow[]): boolean {
  try { if (localStorage.getItem('playground.linkOptions') === '1') return true; } catch { /* no storage */ }
  return rows.some((r) => 'expiresAt' in r);
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
  const [supported, setSupported] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>('7d');
  const [readOnly, setReadOnly] = useState(false);
  const [scopeKind, setScopeKind] = useState<LinkScope['kind']>('document');
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  const doc = getDoc();
  const sections = doc?.pages.flatMap((p) => p.sections ?? []) ?? [];

  // The document list is the only place the client learns which project this
  // document is filed in; without one, "whole project" is not offered.
  useEffect(() => {
    if (!docId) return;
    fetch('/api/documents').then((r) => r.json()).then((b: { documents?: { id: string; projectId?: string | null }[] }) => {
      setProjectId(b.documents?.find((d) => d.id === docId)?.projectId ?? null);
    }).catch(() => { /* project scope just stays hidden */ });
  }, [docId]);

  const refresh = useCallback(async () => {
    if (!docId) return;
    const res = await fetch(`/api/documents/${docId}/connections`);
    const body = (await res.json()) as { connections: ConnectionRow[] };
    let rows = body.connections;
    // A project link is listed under the project, not the document.
    if (projectId) {
      const p = (await fetch(`/api/projects/${projectId}/connections`)
        .then((r) => (r.ok ? r.json() : { connections: [] }))
        .catch(() => ({ connections: [] }))) as { connections: ConnectionRow[] };
      const seen = new Set(rows.map((r) => r.code));
      rows = [...rows, ...p.connections.filter((r) => !seen.has(r.code))];
    }
    setConnections(rows);
    if (serverHasLinkOptions(rows)) setSupported(true);
  }, [docId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!docId) return;
    setBusy(true);
    try {
      // Without server support the options are not sent; the link is the old kind.
      const scope: LinkScope = scopeKind === 'project' && projectId
        ? { kind: 'project', projectId }
        : scopeKind === 'sections' && sectionIds.length ? { kind: 'sections', sectionIds } : { kind: 'document' };
      const options = supported ? { expiresIn: expiry, readOnly, scope } : {};
      const url = supported && scope.kind === 'project'
        ? `/api/projects/${scope.projectId}/connections`
        : `/api/documents/${docId}/connections`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: CLIENT_LABELS[client], docId, ...options }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? 'Could not make a link', 'error');
        return;
      }
      const body = (await res.json()) as { connection: ConnectionRow; url: string; setup: SetupInfo };
      if ('expiresAt' in body.connection) setSupported(true);
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
    toast('Link revoked', 'success');
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

          {!latest && supported && (
            <div className="connect-options">
              <label className="field">
                <span className="field-label">Expires in</span>
                <select value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                  {(Object.keys(EXPIRY_LABELS) as Expiry[]).map((k) => <option key={k} value={k}>{EXPIRY_LABELS[k]}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Can reach</span>
                <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as LinkScope['kind'])}>
                  <option value="document">This document</option>
                  {projectId && <option value="project">The whole project</option>}
                  {sections.length > 0 && <option value="sections">Selected sections</option>}
                </select>
              </label>
              {scopeKind === 'sections' && (
                <div className="connect-sections">
                  {sections.map((sec) => (
                    <label key={sec.id} className="connect-check">
                      <input
                        type="checkbox"
                        checked={sectionIds.includes(sec.id)}
                        onChange={(e) => setSectionIds(e.target.checked ? [...sectionIds, sec.id] : sectionIds.filter((x) => x !== sec.id))}
                      />
                      {sec.title || 'Untitled section'} <span className="dim">{sec.artboards.length} frames</span>
                    </label>
                  ))}
                </div>
              )}
              <label className="connect-check">
                <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                Read-only: it can look and comment, not change anything
              </label>
            </div>
          )}

          {!latest ? (
            <div className="connect-create">
              <button className="button primary" onClick={create} disabled={busy || (supported && scopeKind === 'sections' && !sectionIds.length)}>
                {busy ? 'One moment…' : 'Get my connection link'}
              </button>
              <span className="dim">
                {supported
                  ? `A private link that lets your assistant ${readOnly ? 'look at' : 'edit'} ${scopeKind === 'project' ? 'every document in this project' : scopeKind === 'sections' ? 'the chosen sections' : 'this page'}.`
                  : 'A private link that lets your assistant edit this page only.'}
              </span>
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
                    <strong>
                      {c.label ?? 'Agent'}
                      {c.readOnly && <span className="connect-tag">read-only</span>}
                      {c.scope && c.scope.kind !== 'document' && (
                        <span className="connect-tag">{c.scope.kind === 'project' ? 'project' : `${c.scope.sectionIds.length} section${c.scope.sectionIds.length === 1 ? '' : 's'}`}</span>
                      )}
                    </strong>
                    <span className="dim">
                      {c.redeemedAt
                        ? `last used ${relative(c.lastUsedAt ?? c.redeemedAt)}`
                        : 'expiresAt' in c ? 'not used yet' : 'not used yet — stops working 30 minutes after it was made'}
                      {'expiresAt' in c && ` · ${expiryText(c.expiresAt ?? null)}`}
                    </span>
                  </div>
                  <button className="button subtle" onClick={() => revoke(c.code)}>Revoke</button>
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

function expiryText(at: number | null): string {
  if (at === null) return 'never expires';
  const left = at - Date.now();
  if (left <= 0) return 'expired';
  if (left < 3_600_000) return `expires in ${Math.max(1, Math.round(left / 60_000))}m`;
  if (left < 86_400_000) return `expires in ${Math.round(left / 3_600_000)}h`;
  return `expires in ${Math.round(left / 86_400_000)}d`;
}
