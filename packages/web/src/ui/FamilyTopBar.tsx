import type { ReactNode } from 'react';
import { LogoMark } from './Logo';

/*
 * The heymax family top bar: the same `hm-` markup and kit-topbar.css as the
 * kit's <hm-topbar> element, written as JSX so React owns it. Mark, name and
 * app switcher; then the screen's own middle (search on Home); then the
 * five-dot position indicator and the screen's actions.
 */
const APPS = [
  { key: 'studio', name: 'Studio', role: 'Run the business', url: 'https://studio.heymax.im' },
  { key: 'artifactory', name: 'Artifactory', role: 'Keep the work', url: 'https://artifactory.heymax.im' },
  { key: 'playground', name: 'Playground', role: 'Make the work', url: 'https://playground.heymax.im' },
  { key: 'notes', name: 'Notes', role: 'Think it through', url: 'https://notes.heymax.im' },
  { key: 'kit', name: 'Kit', role: 'Share the system', url: '' },
] as const;

export function FamilyTopBar({ middle, end }: { middle?: ReactNode; end?: ReactNode }) {
  return (
    <header className="hm-topbar hm-topbar--float family-topbar">
      <div className="hm-topbar__brand">
        <LogoMark size={28} />
        <a className="hm-topbar__name" href="/">Playground</a>
        <AppSwitcher />
      </div>
      {middle !== undefined && <div className="hm-topbar__search">{middle}</div>}
      <div className="hm-topbar__end">
        <div className="hm-dots" aria-hidden="true">
          {APPS.map((a) => (
            <span key={a.key} data-current={a.key === 'playground' ? '' : undefined} />
          ))}
        </div>
        {end}
      </div>
    </header>
  );
}

/** The app switcher on its own, for the editor header. */
export function AppSwitcher() {
  return (
    <details className="hm-switcher">
      <summary aria-label="Switch app">▾</summary>
      <div className="hm-switcher__menu">
        {APPS.filter((a) => a.url).map((a) => (
          <a key={a.key} className="hm-switcher__item" href={a.url} aria-current={a.key === 'playground'}>
            <img src={`/kit/marks/${a.key}.svg`} alt="" width={22} height={22} />
            {a.name}
            <span className="hm-switcher__role">{a.role}</span>
          </a>
        ))}
      </div>
    </details>
  );
}
