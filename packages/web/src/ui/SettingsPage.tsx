/**
 * Settings, as a page in the library (/settings), reached from the side nav.
 *
 * Only what the server supports: the account is read from /api/auth/state and
 * cannot be edited here (there is no profile endpoint; under single sign-on it
 * lives at the identity service). Theme is the same appearance preference as
 * the popover. Agent links are the account's MCP links (/api/agents): listed,
 * made, removed. "Regenerate" is making a new link and removing the old one,
 * since a full link is only ever shown once.
 */

import type { Appearance, Theme } from '../state/appearance.ts';
import { type Account, signOut } from '../state/session.ts';
import { initials } from './AccountMenu.tsx';
import { AgentLinks } from './AgentLinks.tsx';
import { Icon, type IconName } from './Icon.tsx';

const THEMES: { value: Theme; icon: IconName; label: string }[] = [
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
  { value: 'system', icon: 'contrast', label: 'System' },
];

export function SettingsPage({ user, idUrl, appearance, onAppearance, onSignedOut }: {
  user: Account;
  idUrl: string | null;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  onSignedOut: () => void;
}) {
  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <h1 className="tempo-h1 home-page-title">Settings</h1>
        <p className="tempo-sub">Your account, how Playground looks, and the links agents use.</p>
      </header>

      <section className="settings-card" aria-labelledby="settings-account">
        <h2 id="settings-account" className="tempo-h2">Account</h2>
        <div className="settings-profile">
          <span className="tempo-initials" style={{ background: user.color }} aria-hidden>{initials(user.name)}</span>
          <dl>
            <div><dt>Name</dt><dd>{user.name}</dd></div>
            <div>
              <dt>Email</dt>
              <dd>{user.email}{user.emailVerified ? '' : <em className="settings-tag">not verified</em>}</dd>
            </div>
          </dl>
        </div>
        <p className="settings-note">
          {idUrl
            ? <>Your name and email come from your heymax account. <a href={idUrl}>Change them there</a>.</>
            : 'Your name and email are set when the account is made.'}
        </p>
        <div>
          <button className="button" onClick={async () => { await signOut(); onSignedOut(); }}>
            <Icon name="logout" size={14} /> Sign out
          </button>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="settings-theme">
        <h2 id="settings-theme" className="tempo-h2">Theme</h2>
        <div className="tempo-tabs" role="radiogroup" aria-labelledby="settings-theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              className="tempo-tab"
              role="radio"
              aria-checked={appearance.theme === t.value}
              onClick={() => onAppearance({ ...appearance, theme: t.value })}
            >
              <Icon name={t.icon} size={14} /> {t.label}
            </button>
          ))}
        </div>
        <p className="settings-note">System follows your computer. Interface size and canvas options are in the editor's settings.</p>
      </section>

      <section className="settings-card" aria-labelledby="settings-agents">
        <h2 id="settings-agents" className="tempo-h2">Agents (MCP)</h2>
        <AgentLinks />
      </section>
    </div>
  );
}
