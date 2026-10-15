/**
 * The Playground logotype, in the heymax family system.
 *
 * The mark is the family ink tile on the 48-unit grid: the crop marks of an
 * artboard in white and the cursor working on it in blue 300 — one accent
 * shape, like every app in the family. The wordmark is Inter 600 in sentence
 * case with no tracking, the same as Studio OS, Artifactory and Notes.
 */

interface Props {
  /** `full` shows the wordmark; `mark` is the glyph alone, for tight spaces. */
  variant?: 'full' | 'mark';
  size?: number;
  className?: string;
}

export function Logo({ variant = 'full', size = 18, className }: Props) {
  return (
    <span className={`logotype${className ? ` ${className}` : ''}`} aria-label="Playground">
      <LogoMark size={size} />
      {/*
        * Sentence case in the markup, capitals in the CSS: a screen reader
        * saying "P-L-A-Y" one letter at a time is what shouting in the DOM
        * gets you.
        */}
      {variant === 'full' && <span className="logotype-word" style={{ fontSize: size * 0.58 }}>Playground</span>}
    </span>
  );
}

export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden focusable="false">
      <rect width="48" height="48" rx="12" />
      <path
        d="M13.75 21V13.75H21 M27 13.75H34.25V21 M13.75 27V34.25H21"
        fill="none"
        style={{ stroke: 'var(--white)' }}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M25 25 L37 29.5 L31.6 31.6 L29.5 37 Z" style={{ fill: 'var(--blue-300)', stroke: 'var(--blue-300)' }} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
