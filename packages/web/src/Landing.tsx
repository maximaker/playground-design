/**
 * What a signed-out visitor sees.
 *
 * Two jobs, in this order: say what this is, and get the person who owns the
 * instance signed in. The sign-in form is on the page rather than behind a
 * button — for the one person who uses this every day, a landing page that
 * costs a click before the password field is a landing page in the way.
 *
 * On an instance with no accounts yet the form creates the first one, which
 * also claims every document that was made before accounts existed.
 */

import { useState } from 'react';
import { type Account, signIn, signUp } from './state/session.ts';
import { Icon } from './ui/Icon.tsx';

const POINTS = [
  {
    icon: 'code' as const,
    title: 'The document is HTML and CSS',
    body: 'Not a vector file that exports to code. Every artboard is a real browser viewport, so a media query resolves the way it will in production.',
  },
  {
    icon: 'sparkle' as const,
    title: 'Agents edit it over MCP',
    body: 'Eighty tools — read the tree, write HTML, set tokens, measure the rendered layout, take a screenshot — plus the document itself as resources your agent can read and subscribe to. Claude Code, Codex and Cursor connect with one command.',
  },
  {
    icon: 'component' as const,
    title: 'Components, tokens and variants',
    body: 'Real components with instances and overrides, themed design tokens, and hover and breakpoint variants that live on the node rather than in a comment.',
  },
  {
    icon: 'users' as const,
    title: 'Made for more than one person',
    body: 'Live cursors, comments, version history and view-only share links — with every change attributed to whoever, or whatever, made it.',
  },
];

export function Landing({ hasAccounts, signupCodeRequired, onSignedIn }: {
  hasAccounts: boolean;
  /** This instance asks for a shared code before it will create an account. */
  signupCodeRequired: boolean;
  onSignedIn: (user: Account) => void;
}) {
  // A fresh instance has nothing to sign in to, so it opens on sign-up.
  const [mode, setMode] = useState<'in' | 'up'>(hasAccounts ? 'in' : 'up');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === 'in'
        ? await signIn(email, password)
        : await signUp(email, password, name, code);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <header className="landing-bar">
        <span className="landing-brand">
          <Icon name="logo" size={22} /> Playground
        </span>
        <a className="landing-link" href="#what">What it is</a>
      </header>

      <div className="landing-main">
        <section className="landing-pitch">
          <span className="landing-eyebrow">Design tool · HTML-native · MCP</span>
          <h1>Design in the material you ship.</h1>
          <p className="landing-lead">
            A canvas where the document is real HTML and CSS, and an agent can edit it
            through the same model you do — no export step, no translation layer,
            no drifting handoff.
          </p>

          <ul className="landing-points" id="what">
            {POINTS.map((p) => (
              <li key={p.title}>
                <span className="landing-point-icon"><Icon name={p.icon} size={16} /></span>
                <div>
                  <strong>{p.title}</strong>
                  <span>{p.body}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-auth">
          <form className="auth-card" onSubmit={submit}>
            <h2>{mode === 'in' ? 'Sign in' : hasAccounts ? 'Create an account' : 'Set up this instance'}</h2>
            {!hasAccounts && (
              <p className="auth-note">
                Nobody has an account here yet. The first one becomes the owner of everything
                already on this instance.
              </p>
            )}

            {mode === 'up' && signupCodeRequired && (
              <label>
                Sign-up code
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  required
                />
                <span className="auth-hint">This instance does not take open sign-ups.</span>
              </label>
            )}

            {mode === 'up' && (
              <label>
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="What people should see on your cursor"
                />
              </label>
            )}

            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                minLength={mode === 'up' ? 10 : undefined}
                required
              />
              {mode === 'up' && <span className="auth-hint">At least 10 characters.</span>}
            </label>

            {error && <p className="auth-error" role="alert">{error}</p>}

            <button className="button primary" type="submit" disabled={busy}>
              {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
            </button>

            {hasAccounts && (
              <button
                type="button"
                className="auth-switch"
                onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}
              >
                {mode === 'in' ? 'No account? Create one' : 'Already have an account? Sign in'}
              </button>
            )}

            {/*
              * Said plainly rather than hidden: addresses are recorded but not
              * verified, because this instance has no mail service. Someone
              * should know that before they rely on a reset link existing.
              */}
            <p className="auth-fineprint">
              Addresses are not verified yet and there is no password reset by email — the
              operator can set a new one on the server.
            </p>
          </form>
        </section>
      </div>
    </div>
  );
}
