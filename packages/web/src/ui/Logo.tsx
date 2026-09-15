/**
 * The Playground logotype.
 *
 * The mark is a filled tile with the play triangle knocked out of it — the
 * canvas as a solid object rather than an outline, which holds up at 16px in a
 * toolbar where a 1.6px stroke turns into grey mush.
 *
 * The wordmark is set in capitals and tracked out. Caps have a flat top and
 * bottom, so the word sits square against the tile instead of hanging off its
 * descender; it is also the only way a nine-letter word reads as a mark rather
 * than as a label. The gradient stays on the tile alone — gradient text is
 * illegible at small sizes and dates a product faster than anything else in it.
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
        {/*
          * The triangle is cut out of the tile rather than drawn on top of it,
          * so the mark works on any background — including the one case that
          * caught the painted version out, a white favicon tile on a white card.
          */}
        <mask id="pg-play">
          <rect x="0" y="0" width="24" height="24" fill="#fff" />
          <path d="M9.4 7.8 16.4 12l-7 4.2z" fill="#000" />
        </mask>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="7" fill="url(#pg-mark)" mask="url(#pg-play)" />
    </svg>
  );
}
