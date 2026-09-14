/**
 * The Playground logotype.
 *
 * The mark is three nested rings offset on one axis — a play button implied by
 * negative space, and a nod to the artboards stacking on the canvas. The
 * wordmark is Orbitron, which is geometric and unmistakably futuristic without
 * losing legibility at the 13px the top bar actually renders it at.
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
      {variant === 'full' && <span className="logotype-word" style={{ fontSize: size * 0.72 }}>Playground</span>}
    </span>
  );
}

export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id="pg-mark" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--logo-from)" />
          <stop offset="1" stopColor="var(--logo-to)" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" stroke="url(#pg-mark)" strokeWidth="1.6" />
      <path
        d="M9.2 7.4 16.6 12l-7.4 4.6z"
        fill="url(#pg-mark)"
        stroke="url(#pg-mark)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
