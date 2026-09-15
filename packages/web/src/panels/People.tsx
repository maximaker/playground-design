/**
 * Who can open this document, and as what.
 *
 * Roles are enforced on the server — this panel is the way to set them, not the
 * thing that makes them true. It sits beside share links in the same modal
 * because the question people actually have is "who can see this", and the
 * answer has two halves: the named people here, and anyone holding a link.
 *
 * There is no mail service, so an invitation is a link the inviter sends
 * themselves. An address that already has an account skips the link entirely
 * and is added on the spot; the panel says which of the two happened, because
 * "invited" and "added" mean different things to whoever is waiting.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCanvas } from '../state/store.ts';
import { Avatar } from '../ui/AccountMenu.tsx';
import { Icon } from '../ui/Icon.tsx';

type Role = 'owner' | 'editor' | 'viewer';

interface Member {
  user: { id: string; name: string; email: string; color: string };
  role: Role;
}

interface Invite {
  token: string;
  role: Role;
  email: string | null;
  expiresAt: number;
  url: string;
}

const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: 'viewer', label: 'Viewer', hint: 'Can open it and comment. Cannot change the design.' },
  { value: 'editor', label: 'Editor', hint: 'Can change the design and connect agents.' },
  { value: 'owner', label: 'Owner', hint: 'Everything an editor can do, plus sharing and deleting.' },
];

export function People({ docId, myRole }: { docId: string; myRole: Role | null }) {
  const toast = useCanvas((s) => s.toast);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const [madeLink, setMadeLink] = useState<string | null>(null);

  const canManage = myRole === 'owner';

  const refresh = useCallback(async () => {
    const [m, i] = await Promise.all([
      fetch(`/api/documents/${docId}/members`).then((r) => r.json()).catch(() => ({ members: [] })),
      // Only an owner may list invitations; for everyone else this is a 403 and
      // an empty list is the right answer rather than an error in the panel.
      fetch(`/api/documents/${docId}/invites`).then((r) => (r.ok ? r.json() : { invites: [] }))
        .catch(() => ({ invites: [] })),
    ]);
    setMembers(m.members ?? []);
    setInvites(i.invites ?? []);
  }, [docId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Invitation link copied', 'info');
    } catch {
      toast('Could not reach the clipboard — select the link and copy it.', 'error');
    }
  };

  const invite = async () => {
    setBusy(true);
    setMadeLink(null);
    try {
      const res = await fetch(`/api/documents/${docId}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() || undefined, role }),
      });
      const body = (await res.json()) as {
        added?: { name: string }; invite?: Invite; error?: string;
      };
      if (!res.ok) { toast(body.error ?? 'That did not work', 'error'); return; }
      if (body.added) {
        toast(`${body.added.name} can now open this document`, 'info');
      } else if (body.invite) {
        setMadeLink(body.invite.url);
        await copy(body.invite.url);
      }
      setEmail('');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setMemberRole = async (member: Member, next: Role) => {
    await fetch(`/api/documents/${docId}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: member.user.email, role: next }),
    });
    await refresh();
  };

  const removeMember = async (member: Member) => {
    const res = await fetch(`/api/documents/${docId}/members/${member.user.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast(body.error ?? 'Could not remove them', 'error');
    }
    await refresh();
  };

  const withdraw = async (token: string) => {
    await fetch(`/api/documents/${docId}/invites/${token}`, { method: 'DELETE' });
    if (madeLink?.endsWith(token)) setMadeLink(null);
    await refresh();
  };

  return (
    <section className="people">
      {canManage && (
        <div className="people-invite">
          <label className="field is-wide">
            <span className="field-label">Invite by email, or make a link for anyone</span>
            <input
              className="input"
              type="email"
              value={email}
              placeholder="colleague@example.com — or leave empty"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void invite(); e.stopPropagation(); }}
            />
          </label>
          <label className="field">
            <span className="field-label">As</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <button className="button primary" onClick={invite} disabled={busy}>
            {busy ? 'One moment…' : 'Invite'}
          </button>
        </div>
      )}

      {canManage && (
        <p className="panel-hint" style={{ padding: 0 }}>
          {ROLES.find((r) => r.value === role)?.hint}
          {' '}Nothing is emailed — you get a link to send. An address that already has an account is
          added straight away.
        </p>
      )}

      {madeLink && (
        <div className="code-display">
          <code>{madeLink}</code>
          <button className="button" onClick={() => copy(madeLink)}>Copy</button>
        </div>
      )}

      <ul className="people-list">
        {members.map((m) => (
          <li key={m.user.id}>
            <Avatar name={m.user.name} color={m.user.color} size={26} />
            <div className="people-who">
              <strong>{m.user.name}</strong>
              <span className="dim">{m.user.email}</span>
            </div>
            {canManage ? (
              <select
                className="input people-role"
                value={m.role}
                aria-label={`Role for ${m.user.name}`}
                onChange={(e) => void setMemberRole(m, e.target.value as Role)}
              >
                {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            ) : (
              <span className="role-badge">{m.role}</span>
            )}
            {canManage && (
              <button
                className="icon-button"
                title="Remove from this document"
                aria-label={`Remove ${m.user.name}`}
                onClick={() => void removeMember(m)}
              ><Icon name="close" size={13} /></button>
            )}
          </li>
        ))}

        {invites.map((i) => (
          <li key={i.token} className="is-pending">
            <span className="avatar-chip is-pending" aria-hidden><Icon name="link" size={12} /></span>
            <div className="people-who">
              <strong>{i.email ?? 'Anyone with the link'}</strong>
              <span className="dim">
                Invited as {i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}
              </span>
            </div>
            <button className="button subtle" onClick={() => copy(i.url)}>Copy link</button>
            <button className="button subtle" onClick={() => void withdraw(i.token)}>Withdraw</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
