/**
 * The icon set.
 *
 * Monochrome, stroke-based, one 16×16 grid, one stroke weight. Icons inherit
 * `currentColor` so a single rule themes the whole UI, and none of them carry
 * meaning by colour alone.
 *
 * Emoji were doing this job before. They render differently on every platform,
 * carry their own colour, and sit on their own baseline — which is why the
 * toolbar and layer tree looked uneven.
 */

export type IconName = keyof typeof PATHS;

const PATHS = {
  // --- Tools -------------------------------------------------------------
  cursor: 'M3.2 2.6 12.4 7.1a.4.4 0 0 1-.05.74l-3.4 1.13-1.5 3.3a.4.4 0 0 1-.74-.04L2.6 3.2a.4.4 0 0 1 .6-.6Z',
  hand: 'M5.5 8V4.2a1.1 1.1 0 0 1 2.2 0V7m0 0V3a1.1 1.1 0 0 1 2.2 0v4m0-.6a1.1 1.1 0 0 1 2.2 0V10a4 4 0 0 1-4 4H8.4a3 3 0 0 1-2.2-1L3.6 10a1.1 1.1 0 0 1 1.6-1.5L5.5 9',
  frame: 'M4.5 1.8v12.4M11.5 1.8v12.4M1.8 4.5h12.4M1.8 11.5h12.4',
  text: 'M3 3h10M8 3v10M6 13h4',
  square: 'M2.8 2.8h10.4v10.4H2.8z',
  circle: 'M8 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z',
  image: 'M2.6 3.4h10.8v9.2H2.6zM2.6 10.4 5.8 7.6l2.6 2.3 2-1.7 3 2.6M6 6.2a.7.7 0 1 1-1.4 0 .7.7 0 0 1 1.4 0Z',
  note: 'M3 2.6h10v7.2l-3.2 3.6H3zM13 9.6H9.8v3.8',
  pen: 'M11.2 2.3 13.7 4.8 5.6 12.9 2.3 13.7l.8-3.3z',

  // --- Structure ---------------------------------------------------------
  artboard: 'M2.2 3.4h11.6v9.2H2.2zM2.2 6h11.6',
  component: 'M8 1.9 11.1 5 8 8.1 4.9 5zM8 7.9 11.1 11 8 14.1 4.9 11z',
  instance: 'M8 1.9 11.1 5 8 8.1 4.9 5z',
  vector: 'M8 2.8 13.2 8 8 13.2 2.8 8zM8 5.6 10.4 8 8 10.4 5.6 8z',
  embed: 'M6 4 2.8 8 6 12M10 4l3.2 4-3.2 4',
  slot: 'M3 3h10v10H3zM6 6h4v4H6z',
  // Angle brackets around a diamond: a component that is source code.
  codeComponent: 'M5.2 3.8 2.2 8l3 4.2M10.8 3.8 13.8 8l-3 4.2M8 5.9 9.8 8 8 10.1 6.2 8z',

  share: 'M11.2 5.4a2 2 0 1 0 0-3.4 2 2 0 0 0 0 3.4zM4.8 9.7a2 2 0 1 0 0-3.4 2 2 0 0 0 0 3.4zM11.2 14a2 2 0 1 0 0-3.4 2 2 0 0 0 0 3.4zM6.5 7.1l3.1-1.7M6.5 8.9l3.1 1.7',

  // --- Layout modes ------------------------------------------------------
  // Little diagrams of the resulting layout, not abstract marks: loose boxes,
  // a stack, a row, a grid. You should be able to pick one without reading.
  layoutNone: 'M3.4 3.4h4v3.4h-4zM9.4 6.2h3.2v3.2H9.4zM4.6 9.6h3.6v3H4.6z',
  layoutColumn: 'M3.2 3h9.6v3.1H3.2zM3.2 7.6h9.6v3.1H3.2z',
  layoutRow: 'M3 3.2v9.6h3.1V3.2zM7.6 3.2v9.6h3.1V3.2z',
  layoutGrid: 'M3.2 3.2h4.2v4.2H3.2zM8.6 3.2h4.2v4.2H8.6zM3.2 8.6h4.2v4.2H3.2zM8.6 8.6h4.2v4.2H8.6z',

  // --- Panel controls ----------------------------------------------------
  chevronRight: 'm6.2 3.6 4.4 4.4-4.4 4.4',
  chevronDown: 'm3.6 6.2 4.4 4.4 4.4-4.4',
  chevronUp: 'm12.4 9.8-4.4-4.4-4.4 4.4',
  eye: 'M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8ZM9.7 8a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0Z',
  eyeOff: 'M6.4 4.1A6.3 6.3 0 0 1 8 3.9c4 0 6.4 4.1 6.4 4.1a11 11 0 0 1-2 2.4M4 5.2A11 11 0 0 0 1.6 8s2.4 4.1 6.4 4.1c.9 0 1.7-.2 2.4-.5M2.4 2.4l11.2 11.2',
  lock: 'M4.4 7.2h7.2v5.6H4.4zM5.9 7.2V5.4a2.1 2.1 0 0 1 4.2 0v1.8',
  unlock: 'M4.4 7.2h7.2v5.6H4.4zM5.9 7.2V5.4a2.1 2.1 0 0 1 4.1-.5',
  plus: 'M8 3.4v9.2M3.4 8h9.2',
  minus: 'M3.4 8h9.2',
  close: 'M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4',
  check: 'm3.4 8.4 3 3 6.2-6.8',
  search: 'M7.2 2.6a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2ZM10.6 10.6l2.8 2.8',
  trash: 'M2.8 4.4h10.4M6 4.4V2.8h4v1.6M4.4 4.4l.7 8.8h5.8l.7-8.8',
  edit: 'M11 2.6 13.4 5 6 12.4 3 13l.6-3zM2.8 14.6h10.4',
  copy: 'M5.4 5.4h7.8v7.8H5.4zM2.8 10.6V2.8h7.8',
  download: 'M8 2.6v7.6M4.8 7.2 8 10.4l3.2-3.2M2.8 13.2h10.4',
  upload: 'M8 10.4V2.8M4.8 6 8 2.8 11.2 6M2.8 13.2h10.4',
  link: 'M6.6 9.4a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-1 1M9.4 6.6a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l1-1',
  keyboard: 'M1.8 4.2h12.4v7.6H1.8zM4.4 6.8h.01M7 6.8h.01M9.6 6.8h.01M12 6.8h.01M4.8 9.4h6.4',
  undo: 'M3 8.4h7.2a3 3 0 0 1 0 6H7M3 8.4l3-3M3 8.4l3 3',
  redo: 'M13 8.4H5.8a3 3 0 0 0 0 6H9M13 8.4l-3-3M13 8.4l-3 3',
  sun: 'M8 5.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6ZM8 1.4v1.6M8 13v1.6M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M1.4 8H3M13 8h1.6M3.3 12.7l1.2-1.2M11.5 4.5l1.2-1.2',
  moon: 'M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6Z',
  contrast: 'M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6ZM8 2.2v11.6a5.8 5.8 0 0 0 0-11.6Z',
  settings: 'M8 5.9a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2ZM8 1.6l1 1.7 1.9-.4.5 1.9 1.7 1-1 1.6 1 1.6-1.7 1-.5 1.9-1.9-.4-1 1.7-1-1.7-1.9.4-.5-1.9-1.7-1 1-1.6-1-1.6 1.7-1 .5-1.9 1.9.4z',
  play: 'm5 3.2 7.4 4.8L5 12.8z',
  sparkle: 'M8 2.2 9.4 6.2 13.4 7.6 9.4 9 8 13 6.6 9 2.6 7.6 6.6 6.2zM12.6 2v2.4M11.4 3.2h2.4',
  layers: 'M8 1.9 14 5 8 8.1 2 5zM2 8l6 3.1L14 8M2 11l6 3.1L14 11',
  grid: 'M2.6 2.6h4.6v4.6H2.6zM8.8 2.6h4.6v4.6H8.8zM2.6 8.8h4.6v4.6H2.6zM8.8 8.8h4.6v4.6H8.8z',
  history: 'M8 4.4V8l2.4 1.6M2.8 8a5.2 5.2 0 1 0 1.6-3.7M2.6 3v2.8h2.8',
  page: 'M3.6 1.9h5.6l3.2 3.2v9H3.6zM9.2 1.9v3.2h3.2',
  palette: 'M8 2.2c3.2 0 5.8 2.4 5.8 5.2 0 1.6-1.4 2.6-2.8 2.6h-1a1.3 1.3 0 0 0-1 2.1c.3.4.2 1-.3 1.3a1.5 1.5 0 0 1-.7.2A5.8 5.8 0 0 1 8 2.2ZM5.4 6.4h.01M8 5h.01M10.6 6.4h.01',

  // --- Alignment ---------------------------------------------------------
  alignLeft: 'M2.4 2v12M4.6 5.2h8M4.6 10.8h5',
  alignCenterX: 'M8 2v12M4 5.2h8M5.5 10.8h5',
  alignRight: 'M13.6 2v12M3.6 5.2h8M6.6 10.8h5',
  alignTop: 'M2 2.4h12M5.2 4.6v8M10.8 4.6v5',
  alignCenterY: 'M2 8h12M5.2 4h8v8h-8zM10.8 5.5v5',
  alignBottom: 'M2 13.6h12M5.2 3.6v8M10.8 6.6v5',
  distributeX: 'M2.4 2v12M13.6 2v12M6.4 4.8h3.2v6.4H6.4z',
  distributeY: 'M2 2.4h12M2 13.6h12M4.8 6.4v3.2h6.4V6.4z',

  // --- Flex direction ----------------------------------------------------
  arrowRight: 'M2.8 8h10.4M9.6 4.4 13.2 8l-3.6 3.6',
  arrowLeft: 'M13.2 8H2.8M6.4 4.4 2.8 8l3.6 3.6',
  arrowDown: 'M8 2.8v10.4M4.4 9.6 8 13.2l3.6-3.6',
  arrowUp: 'M8 13.2V2.8M4.4 6.4 8 2.8l3.6 3.6',

  // --- Text alignment ----------------------------------------------------
  textLeft: 'M2.6 4h10.8M2.6 8h6.8M2.6 12h8.8',
  textCenter: 'M2.6 4h10.8M4.6 8h6.8M3.6 12h8.8',
  textRight: 'M2.6 4h10.8M6.6 8h6.8M4.6 12h8.8',
  textJustify: 'M2.6 4h10.8M2.6 8h10.8M2.6 12h10.8',

  // --- Status ------------------------------------------------------------
  agent: 'M5 6.2h6v5H5zM8 6.2V4M6.6 3a1.4 1.4 0 1 1 2.8 0 1.4 1.4 0 0 1-2.8 0ZM3 8.2h2M11 8.2h2M6.8 8.6h.01M9.2 8.6h.01',
  warning: 'M8 2.6 14.2 13H1.8zM8 6.6v3M8 11.4h.01',
  info: 'M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6ZM8 7.4v3.4M8 5.2h.01',
} as const;

/** Paths that describe an area rather than a stroke. */
const FILLED = new Set<IconName>(['cursor', 'play', 'instance']);

interface Props {
  name: IconName;
  /** Pixel size; defaults to 1em so icons scale with the surrounding text. */
  size?: number | string;
  className?: string;
  title?: string;
}

export function Icon({ name, size, className, title }: Props) {
  const d = PATHS[name];
  const filled = FILLED.has(name);

  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 16 16"
      width={size ?? '1em'}
      height={size ?? '1em'}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}

/** Icon for a node type, used by the layer tree. */
export function iconForNodeType(type: string): IconName {
  switch (type) {
    case 'artboard': return 'artboard';
    case 'frame': return 'frame';
    case 'text': return 'text';
    case 'image': return 'image';
    case 'vector': return 'vector';
    case 'shape': return 'square';
    case 'embed': return 'embed';
    case 'instance': return 'instance';
    case 'code': return 'codeComponent';
    default: return 'square';
  }
}
