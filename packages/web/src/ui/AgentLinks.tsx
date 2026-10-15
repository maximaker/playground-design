/**
 * Settings → Agents: account links, the heymax family standard. One link lets
 * an agent (Claude, Codex, Cursor) work on every document you can open; it is
 * shown once when made, listed with when it was last used, and removable.
 * Per-document and per-project links stay in the Connect agent panel.
 */

import { useEffect, useState } from 'react';

interface Link { code: string; label: string | null; createdAt: number; lastUsedAt: number | null }

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'never');

export function AgentLinks() {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [fresh, setFresh] = useState<{ url: string; command: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState('');

  const load = () =>
    fetch('/api/agents')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Agent links are unavailable right now.'))))
      .then((b: { links: Link[] }) => setLinks(b.links))
      .catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const make = async () => {
    setError(null);
    const r = await fetch('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Claude' }) });
    if (!r.ok) return setError('Could not make a link. Try again.');
    const b = (await r.json()) as { url: string; setup: { claudeCode: string } };
    setFresh({ url: b.url, command: b.setup.claudeCode });
    void load();
  };

  const remove = async (code: string) => {
    await fetch(`/api/agents/${encodeURIComponent(code)}`, { method: 'DELETE' });
    void load();
  };

  const copy = async (value: string, what: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(what);
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div className="settings-group agent-links">
      <span>Agents</span>
      <p className="agent-links-hint">A link lets Claude work on every document you can open. Treat it like a password.</p>
      {fresh ? (
        <div className="agent-links-fresh">
          <code>{fresh.url}</code>
          <div className="agent-links-actions">
            <button className="button" onClick={() => copy(fresh.url, 'url')}>{copied === 'url' ? 'Copied' : 'Copy link'}</button>
            <button className="button" onClick={() => copy(fresh.command, 'cmd')}>{copied === 'cmd' ? 'Copied' : 'Copy Claude Code command'}</button>
          </div>
          <p className="agent-links-hint">Shown once. In Claude: Settings → Connectors → Add custom connector, and paste it.</p>
        </div>
      ) : null}
      {links?.length ? (
        <ul className="agent-links-list">
          {links.map((l) => (
            <li key={l.code}>
              <span>{l.label ?? 'Agent'} <em>last used {when(l.lastUsedAt)}</em></span>
              <button className="button subtle" onClick={() => remove(l.code)} aria-label={`Remove ${l.label ?? 'agent'} link`}>Remove</button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="agent-links-hint">{error}</p> : null}
      <button className="button full" onClick={make}>Make an agent link</button>
    </div>
  );
}
