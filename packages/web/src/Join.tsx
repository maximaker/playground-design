/**
 * Following an invitation link.
 *
 * Three states, and the middle one is the reason this is a screen rather than a
 * redirect: someone signed in accepts and goes straight through, someone signed
 * out has to sign in *and come back*, and a withdrawn or expired link has to
 * say so rather than dumping them on a sign-in form with no explanation.
 */

import { useEffect, useState } from 'react';
import { type Account } from './state/session.ts';
import { Landing } from './Landing.tsx';
import { Icon } from './ui/Icon.tsx';

interface InviteInfo {
  document: { id: string; name: string };
  role: 'owner' | 'editor' | 'viewer';
  email: string | null;
  invitedBy: { name: string; email: string } | null;
  expired: boolean;
  signedIn: boolean;
}

export function Join({ token, user, hasAccounts, signupCodeRequired, onSignedIn, onOpen }: {
  token: string;
  user: Account | null;
  hasAccounts: boolean;
  signupCodeRequired: boolean;
  onSignedIn: () => void;
  onOpen: (docId: string) => void;
}) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch(`/api/invites/${token}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? 'That invitation is not valid.');
        setInfo(body as InviteInfo);
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/invites/${token}/accept`, { method: 'POST' });
      const body = (await res.json()) as { docId?: string; error?: string };
      if (!res.ok || !body.docId) { setError(body.error ?? 'That did not work.'); return; }
      onOpen(body.docId);
    } finally {
      setBusy(false);
    }
  };

  // Accepting needs an account, so the sign-in form comes first and the
  // invitation is picked up again as soon as there is a session.
  if (!user) {
    return (
      <div className="join-wrap">
        {info && (
          <p className="join-banner">
            <Icon name="users" size={14} />
            {info.invitedBy?.name ?? 'Someone'} invited you to <strong>{info.document.name}</strong>
            {' '}as {info.role}. Sign in to accept
            {info.email ? ` — the invitation is for ${info.email}.` : '.'}
          </p>
        )}
        <Landing
          hasAccounts={hasAccounts}
          signupCodeRequired={signupCodeRequired}
          onSignedIn={onSignedIn}
        />
      </div>
    );
  }

  return (
    <div className="join">
      <div className="join-card">
        <Icon name="users" size={22} />
        {error && <><h1>This invitation is not usable</h1><p className="join-lede">{error}</p></>}
        {!error && !info && <p className="join-lede">Checking that invitation…</p>}
        {!error && info && (
          <>
            <h1>{info.document.name}</h1>
            <p className="join-lede">
              {info.invitedBy?.name ?? 'Someone'} invited you to this document as{' '}
              <strong>{info.role}</strong>.
              {info.expired && ' The invitation has expired.'}
            </p>
            <div className="join-actions">
              <button className="button primary" onClick={accept} disabled={busy || info.expired}>
                {busy ? 'One moment…' : 'Open the document'}
              </button>
              <a className="button" href="/">Go to my documents</a>
            </div>
            <p className="join-note">Signed in as {user.email}.</p>
          </>
        )}
        {error && <a className="button" href="/">Go to my documents</a>}
      </div>
    </div>
  );
}
