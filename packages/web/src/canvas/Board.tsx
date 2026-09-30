/**
 * The board, drawn on the canvas.
 *
 * Two layers, because stacking order is the whole point of a section: sections
 * render *under* the artboards, so a section can gather a set of screens into
 * a named flow, and everything else renders over them, so a connector reaching
 * an artboard's edge is not hidden behind it.
 *
 * Geometry — where a connector goes, where its label sits, what an arrowhead
 * looks like — comes from shared/board.ts, the same functions the SVG export
 * and the agent's picture use. The canvas only decides how to paint it.
 */

import { memo, useEffect, useRef } from 'react';
import {
  type BoardItem, type BoardShape, type Connector, type Point,
  BOARD_COLORS, BOARD_COLOR_NAMES, BOARD_FONT, BOARD_STYLE, arrowHead, boardOf, diamondPath, isConnector, isShape,
  connectorPathData, pathData, routeConnector, shapeLook, verdictOf,
} from '@playground/shared';

function cardShadow(zoom: number): string {
  const z = Math.max(0.25, zoom);
  return `0 ${z}px ${2 * z}px rgba(30, 41, 59, 0.05), 0 ${2 * z}px ${8 * z}px ${-2 * z}px rgba(30, 41, 59, 0.06)`;
}

/** BOARD_STYLE's section shadow at the canvas zoom, so a sheet lifts the same at any scale. */
function sheetShadow(zoom: number): string {
  const z = Math.max(0.25, zoom);
  return `0 ${z}px ${2 * z}px rgba(30, 41, 59, 0.05), 0 ${12 * z}px ${32 * z}px ${-8 * z}px rgba(30, 41, 59, 0.14)`;
}
import { useCanvas, getDoc, currentPage } from '../state/store.ts';
import { Icon } from '../ui/Icon.tsx';

/** A connector being drawn, in canvas space. */
export interface ConnectPreview {
  from: Point;
  to: Point;
  /** The board shape or artboard the pointer would attach to, if any. */
  target: { kind: 'shape' | 'artboard'; id: string } | null;
}

export const BOARD_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type BoardHandle = (typeof BOARD_HANDLES)[number];

export function BoardLayer({ part, preview, dragging }: {
  part: 'under' | 'over';
  preview?: ConnectPreview | null;
  dragging?: boolean;
}) {
  // The document is mutated in place, so the version is what says it changed.
  useCanvas((s) => s.version);
  const zoom = useCanvas((s) => s.viewport.zoom);
  const selection = useCanvas((s) => s.boardSelection);
  const editing = useCanvas((s) => s.editingBoard);
  const page = currentPage();
  const doc = getDoc();
  if (!page || !doc) return null;

  const items = boardOf(page);
  const selected = new Set(selection);

  if (part === 'under') {
    return (
      <>
        {items.filter((i): i is BoardShape => isShape(i) && i.kind === 'section').map((s) => (
          <ShapeView key={s.id} shape={s} zoom={zoom} selected={selected.has(s.id)} editing={editing === s.id} />
        ))}
      </>
    );
  }

  const shapes = items.filter((i): i is BoardShape => isShape(i) && i.kind !== 'section');
  const connectors = items.filter(isConnector);
  const single = selection.length === 1 ? items.find((i) => i.id === selection[0]) : undefined;

  return (
    <>
      {/*
        * Connectors first, so shapes sit on top of them.
        *
        * The other way round, a line that happened to pass over a box took the
        * clicks meant for the box — its hit area is fourteen pixels wide — and
        * the box could not be selected or dragged where the line crossed it. A
        * line running behind a shape is also simply the cleaner picture: it
        * does not strike through the words in it.
        *
        * One SVG for every connector, positioned at the world origin and left
        * to overflow: connectors run anywhere on an infinite canvas, and a
        * bounded SVG would clip whatever fell outside it.
        */}
      <svg className="board-connectors" width="1" height="1" overflow="visible">
        {connectors.map((c) => (
          <ConnectorView key={c.id} connector={c} zoom={zoom} selected={selected.has(c.id)} />
        ))}
        {preview && (
          <path
            className="board-preview"
            d={pathData([preview.from, preview.to], zoom)}
            stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 5" fill="none"
          />
        )}
      </svg>

      {shapes.map((s) => (
        <ShapeView key={s.id} shape={s} zoom={zoom} selected={selected.has(s.id)} editing={editing === s.id} />
      ))}

      {/* Labels over the shapes: small, and worse hidden than overlapping. */}
      {connectors.map((c) => (
        <ConnectorLabel key={c.id} connector={c} zoom={zoom} editing={editing === c.id} />
      ))}

      {preview?.target && <TargetHighlight target={preview.target} zoom={zoom} />}

      {single && isShape(single) && !dragging && editing !== single.id && <ResizeHandles shape={single} zoom={zoom} />}
      {single && isConnector(single) && !dragging && <EndHandles connector={single} zoom={zoom} />}
      {selection.length > 0 && !dragging && !editing && <StyleBar zoom={zoom} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const ShapeView = memo(function ShapeView({ shape: s, zoom, selected, editing }: {
  shape: BoardShape; zoom: number; selected: boolean; editing: boolean;
}) {
  const S = BOARD_STYLE;
  const look = shapeLook(s);
  const stroke = Math.max(1, look.strokeWidth * zoom);
  const isSection = s.kind === 'section';
  const isText = s.kind === 'text';

  const style: React.CSSProperties = {
    left: s.x * zoom, top: s.y * zoom, width: s.width * zoom, height: s.height * zoom,
    color: look.text, fontFamily: BOARD_FONT,
    fontSize: look.fontSize * zoom, fontWeight: look.weight,
  };
  if (s.kind === 'rect') Object.assign(style, {
    background: look.fill, border: `${stroke}px solid ${look.stroke}`,
    ...(s.color === 'neutral' ? { boxShadow: cardShadow(zoom) } : {}),
    borderRadius: (s.rounded ? s.height / 2 : Math.min(S.radius, s.height / 2)) * zoom,
  });
  if (s.kind === 'ellipse') Object.assign(style, {
    background: look.fill, border: `${stroke}px solid ${look.stroke}`, borderRadius: '50%',
  });
  // A section is a sheet: white, lifted off the canvas, no edge.
  if (isSection) Object.assign(style, {
    background: '#ffffff', borderRadius: S.sectionRadius * zoom, boxShadow: sheetShadow(zoom),
  });

  return (
    <div
      className={`board-shape board-${s.kind}${selected ? ' is-selected' : ''}`}
      data-board-id={s.id}
      style={style}
    >
      {s.kind === 'diamond' && (
        <svg className="board-diamond-outline" viewBox={`0 0 ${s.width} ${s.height}`} preserveAspectRatio="none">
          <path
            d={diamondPath(s.width, s.height, 0, 0, 3)}
            fill={look.fill} stroke={look.stroke} strokeWidth={stroke}
            strokeDasharray={look.dashed ? `${3 * zoom} ${3 * zoom}` : undefined}
            // The polygon is drawn in the shape's own units and stretched to its
            // box, which would stretch the stroke with it; this keeps it even.
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {editing ? (
        <BoardTextEditor id={s.id} value={s.text} zoom={zoom} align={isText || isSection ? 'left' : 'center'} />
      ) : (
        <span
          className={isSection ? 'board-section-title' : 'board-shape-text'}
          style={{
            padding: isSection ? `${18 * zoom}px ${24 * zoom}px`
              : s.kind === 'diamond' ? `${s.height / 4 * zoom}px ${s.width / 4 * zoom}px`
              : s.kind === 'ellipse' ? `${s.height * 0.15 * zoom}px ${s.width * 0.15 * zoom}px`
              : `${4 * zoom}px ${14 * zoom}px`,
            justifyContent: isText || isSection ? 'flex-start' : 'center',
            textAlign: isText || isSection ? 'left' : 'center',
          }}
        >{s.text}</span>
      )}
      {selected && <span className="board-outline" />}
    </div>
  );
});

function ResizeHandles({ shape: s, zoom }: { shape: BoardShape; zoom: number }) {
  const w = s.width * zoom;
  const h = s.height * zoom;
  const at: Record<BoardHandle, [number, number]> = {
    nw: [0, 0], n: [w / 2, 0], ne: [w, 0], e: [w, h / 2], se: [w, h], s: [w / 2, h], sw: [0, h], w: [0, h / 2],
  };
  return (
    <div className="board-handles" style={{ left: s.x * zoom, top: s.y * zoom, width: w, height: h }}>
      {BOARD_HANDLES.map((k) => (
        <span key={k} className={`board-handle is-${k}`} data-board-handle={k} data-board-for={s.id}
          style={{ left: at[k][0], top: at[k][1] }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

const ConnectorView = memo(function ConnectorView({ connector: c, zoom, selected }: {
  connector: Connector; zoom: number; selected: boolean;
}) {
  const doc = getDoc();
  const page = currentPage();
  const route = doc && page ? routeConnector(doc, page, c) : null;
  if (!route) return null;
  const color = selected ? 'var(--accent)' : BOARD_COLORS[c.color].accent;
  const d = connectorPathData(route, zoom);
  const pts = route.points.map((p) => ({ x: p.x * zoom, y: p.y * zoom }));
  const size = Math.max(3, BOARD_STYLE.arrowSize * zoom);
  const head = (tip: Point, from: Point) => arrowHead(tip, from, size).map((p) => `${p.x},${p.y}`).join(' ');
  const n = pts.length;
  return (
    <g className={`board-connector${selected ? ' is-selected' : ''}`}>
      {/* A wide invisible stroke to click on: a 2px line is too thin to hit. */}
      <path d={d} className="board-connector-hit" data-board-id={c.id} stroke="transparent" strokeWidth={14} fill="none" />
      <path d={d} stroke={color} strokeWidth={Math.max(1, BOARD_STYLE.lineWidth * zoom)} fill="none"
        strokeLinejoin="round"
        strokeDasharray={c.dashed ? `${3 * zoom} ${3 * zoom}` : undefined} pointerEvents="none" />
      {c.arrow !== 'none' && <polygon points={head(pts[n - 1]!, pts[n - 2]!)} fill={color} pointerEvents="none" />}
      {c.arrow === 'both'
        ? <polygon points={head(pts[0]!, pts[1]!)} fill={color} pointerEvents="none" />
        // Where a line starts, a small hollow ring: the flow's "from here".
        : <circle cx={pts[0]!.x} cy={pts[0]!.y} r={Math.max(1.5, BOARD_STYLE.originDot * zoom)} fill="#ffffff" stroke={color} strokeWidth={1} pointerEvents="none" />}
    </g>
  );
});

function ConnectorLabel({ connector: c, zoom, editing }: { connector: Connector; zoom: number; editing: boolean }) {
  const doc = getDoc();
  const page = currentPage();
  if (!c.label && !editing) return null;
  const route = doc && page ? routeConnector(doc, page, c) : null;
  if (!route) return null;
  const verdict = editing ? null : verdictOf(c.label);
  if (verdict) {
    // Yes and no are a tick and a cross on the line, the way a flow sheet
    // marks the two ways out of a decision; the words are still the label.
    const size = Math.max(10, 18 * zoom);
    return (
      <div
        className={`board-verdict is-${verdict}`}
        data-board-id={c.id}
        title={c.label}
        style={{ left: route.label.x * zoom, top: route.label.y * zoom, width: size, height: size,
          background: verdict === 'yes' ? BOARD_STYLE.yes : BOARD_STYLE.no }}
      >
        <svg viewBox="-9 -9 18 18" width="100%" height="100%">
          {verdict === 'yes'
            ? <path d="M-4 0 L-1 3 L4.5 -3" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            : <path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />}
        </svg>
      </div>
    );
  }
  return (
    <div
      className="board-label"
      data-board-id={c.id}
      style={{
        left: route.label.x * zoom, top: route.label.y * zoom,
        fontSize: BOARD_STYLE.labelFontSize * zoom,
        padding: `${3 * zoom}px ${9 * zoom}px`, borderRadius: 999,
        background: BOARD_STYLE.labelFill,
        color: c.color === 'neutral' ? BOARD_STYLE.labelText : BOARD_COLORS[c.color].text, fontFamily: BOARD_FONT,
      }}
    >
      {editing ? <BoardTextEditor id={c.id} value={c.label ?? ''} zoom={zoom} align="center" single /> : c.label}
    </div>
  );
}

function EndHandles({ connector: c, zoom }: { connector: Connector; zoom: number }) {
  const doc = getDoc();
  const page = currentPage();
  const route = doc && page ? routeConnector(doc, page, c) : null;
  if (!route) return null;
  const first = route.points[0]!;
  const last = route.points[route.points.length - 1]!;
  return (
    <>
      <span className="board-end" data-board-end="from" data-board-for={c.id} style={{ left: first.x * zoom, top: first.y * zoom }} />
      <span className="board-end" data-board-end="to" data-board-for={c.id} style={{ left: last.x * zoom, top: last.y * zoom }} />
    </>
  );
}

function TargetHighlight({ target, zoom }: { target: NonNullable<ConnectPreview['target']>; zoom: number }) {
  const doc = getDoc();
  const page = currentPage();
  if (!doc || !page) return null;
  let box: { x: number; y: number; width: number; height: number } | null = null;
  if (target.kind === 'shape') {
    const s = boardOf(page).find((i) => i.id === target.id);
    if (isShape(s)) box = s;
  } else {
    const n = doc.nodes[target.id];
    if (n) box = { x: Number(n.attrs['data-x'] ?? 0), y: Number(n.attrs['data-y'] ?? 0), width: parseFloat(n.styles.width ?? '0'), height: parseFloat(n.styles.height ?? '0') };
  }
  if (!box) return null;
  return <div className="board-target" style={{ left: box.x * zoom - 4, top: box.y * zoom - 4, width: box.width * zoom + 8, height: box.height * zoom + 8 }} />;
}

// ---------------------------------------------------------------------------
// Editing text in place
// ---------------------------------------------------------------------------

function BoardTextEditor({ id, value, zoom, align, single }: {
  id: string; value: string; zoom: number; align: 'left' | 'center'; single?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const cancelled = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const commit = (text: string) => {
    const page = currentPage();
    const state = useCanvas.getState();
    state.setEditingBoard(null);
    if (!page || cancelled.current) return;
    const item = boardOf(page).find((i) => i.id === id);
    if (!item) return;
    // A text shape left empty is nothing at all — an invisible box you would
    // find later by accident — so finishing one empty removes it.
    if (isShape(item) && item.kind === 'text' && !text.trim()) {
      state.dispatch([{ t: 'board', pageId: page.id, changes: [{ action: 'remove', id }] }]);
      state.selectBoard([]);
      return;
    }
    const current = isShape(item) ? item.text : item.label ?? '';
    if (text === current) return;
    const patch = isShape(item) ? { text } : { label: text.trim() ? text : null };
    state.dispatch([{ t: 'board', pageId: page.id, changes: [{ action: 'update', id, patch }] }]);
  };

  return (
    <textarea
      ref={ref}
      className="board-editor"
      defaultValue={value}
      rows={single ? 1 : undefined}
      style={{ fontSize: 'inherit', textAlign: align, minWidth: single ? 60 * zoom : undefined }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
        // Enter finishes a label; a shape takes line breaks with Shift-Enter
        // and finishes with a plain Enter, the way FigJam does.
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// The style bar
// ---------------------------------------------------------------------------

/**
 * Colour, and for connectors the route, the arrowheads and dashing.
 *
 * Sits over the selection, where the eye already is, rather than in the side
 * panel: the panel is about the design's CSS, and none of this is CSS.
 */
function StyleBar({ zoom }: { zoom: number }) {
  const ids = useCanvas((s) => s.boardSelection);
  const dispatch = useCanvas((s) => s.dispatch);
  const panY = useCanvas((s) => s.viewport.y);
  const page = currentPage();
  const doc = getDoc();
  if (!page || !doc) return null;
  const items = boardOf(page).filter((i) => ids.includes(i.id));
  if (!items.length) return null;

  // Above the top of the selection, centred on it — or below it when the top
  // is off the screen, where a bar hung above it would be under the topbar.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    if (isShape(item)) {
      minX = Math.min(minX, item.x); maxX = Math.max(maxX, item.x + item.width);
      minY = Math.min(minY, item.y); maxY = Math.max(maxY, item.y + item.height);
    } else {
      for (const p of routeConnector(doc, page, item)?.points ?? []) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  const below = panY + minY * zoom - 12 < 52;

  const connectors = items.filter(isConnector);
  const shapes = items.filter(isShape);
  const change = (patch: (item: BoardItem) => Record<string, unknown> | null) => {
    const changes = items.flatMap((item) => {
      const p = patch(item);
      return p ? [{ action: 'update' as const, id: item.id, patch: p }] : [];
    });
    if (changes.length) dispatch([{ t: 'board', pageId: page.id, changes }]);
  };
  const all = <K extends keyof Connector>(key: K, value: Connector[K]) => connectors.every((c) => c[key] === value);
  const reshapeable = shapes.filter((s) => s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'diamond');

  return (
    <div
      className={`board-stylebar${below ? ' is-below' : ''}`}
      style={{ left: ((minX + maxX) / 2) * zoom, top: below ? maxY * zoom + 12 : minY * zoom - 12 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {BOARD_COLOR_NAMES.map((name) => (
        <button
          key={name}
          className={`board-swatch${items.every((i) => i.color === name) ? ' is-active' : ''}`}
          // The accent as the ring: the fills are pale enough that six of them
          // side by side would be hard to tell apart.
          style={{ background: BOARD_COLORS[name].fill, borderColor: BOARD_COLORS[name].accent }}
          aria-label={`Colour: ${name}`}
          title={name}
          onClick={() => change(() => ({ color: name }))}
        />
      ))}
      {reshapeable.length > 0 && <span className="board-stylebar-divider" />}
      {reshapeable.length > 0 && (['rect', 'ellipse', 'diamond'] as const).map((kind) => (
        <button
          key={kind}
          className={`board-tool${reshapeable.every((s) => s.kind === kind) ? ' is-active' : ''}`}
          aria-label={`Shape: ${kind}`}
          title={kind === 'rect' ? 'Rectangle' : kind === 'ellipse' ? 'Ellipse' : 'Diamond'}
          onClick={() => change((i) => (isShape(i) && i.kind !== 'section' && i.kind !== 'text' ? { kind } : null))}
        ><Icon name={kind === 'rect' ? 'square' : kind === 'ellipse' ? 'circle' : 'diamond'} size={14} /></button>
      ))}
      {connectors.length > 0 && <span className="board-stylebar-divider" />}
      {connectors.length > 0 && (
        <>
          <button className={`board-tool${all('route', 'elbow') ? ' is-active' : ''}`} aria-label="Elbow" title="Elbow"
            onClick={() => change((i) => (isConnector(i) ? { route: 'elbow' } : null))}><Icon name="lineElbow" size={14} /></button>
          <button className={`board-tool${all('route', 'curved') ? ' is-active' : ''}`} aria-label="Curved" title="Curved"
            onClick={() => change((i) => (isConnector(i) ? { route: 'curved' } : null))}><Icon name="lineCurved" size={14} /></button>
          <button className={`board-tool${all('route', 'straight') ? ' is-active' : ''}`} aria-label="Straight" title="Straight"
            onClick={() => change((i) => (isConnector(i) ? { route: 'straight' } : null))}><Icon name="lineStraight" size={14} /></button>
          <button
            className="board-tool"
            aria-label="Arrowheads"
            title={`Arrowheads: ${connectors[0]!.arrow === 'end' ? 'one end' : connectors[0]!.arrow === 'both' ? 'both ends' : 'none'}`}
            onClick={() => {
              // One button that cycles, because three for a rarely-changed
              // setting would crowd out the ones people reach for.
              const next = { end: 'both', both: 'none', none: 'end' } as const;
              change((i) => (isConnector(i) ? { arrow: next[connectors[0]!.arrow] } : null));
            }}
          ><Icon name={connectors[0]!.arrow === 'both' ? 'arrowBoth' : connectors[0]!.arrow === 'none' ? 'arrowNone' : 'lineElbow'} size={14} /></button>
          <button className={`board-tool${all('dashed', true) ? ' is-active' : ''}`} aria-label="Dashed" title="Dashed"
            onClick={() => {
              const dashed = !all('dashed', true);
              change((i) => (isConnector(i) ? { dashed: dashed || null } : null));
            }}><Icon name="dashed" size={14} /></button>
        </>
      )}
    </div>
  );
}
