/**
 * Diagrams an agent writes: Mermaid (or a plain graph) in, board items out.
 *
 * Two halves. `parseMermaid` reads the flowchart grammar agents actually emit
 * into a graph, and reports every line it could not read rather than dropping
 * it. `layoutDiagram` places that graph with a small layered layout and turns
 * it into shapes, sections and connectors ready for a `board` op.
 *
 * The layout is written here rather than pulled in: it is a page of code, it
 * keeps the dependency list what it is, and it is deterministic — the same
 * Mermaid lays out the same way twice, which matters when an agent redraws a
 * diagram and a person is comparing the two.
 */

import {
  type BoardColor, type BoardItem, type BoardShape, type BoardShapeKind, type Connector, type Endpoint,
  BOARD_COLOR_NAMES, makeBoardShape, makeConnector,
} from './board.ts';

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export type Direction = 'TB' | 'BT' | 'LR' | 'RL';

export interface DiagramNode {
  id: string;
  label: string;
  kind?: Exclude<BoardShapeKind, 'section'>;
  rounded?: boolean;
  color?: BoardColor;
  /** An existing artboard, by name or id, instead of a new shape. */
  artboard?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  arrow?: 'end' | 'both' | 'none';
}

export interface DiagramGroup {
  id: string;
  label: string;
  members: string[];
  color?: BoardColor;
}

export interface DiagramGraph {
  direction: Direction;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export interface MermaidResult {
  graph: DiagramGraph;
  /** Lines that were not understood, with their line numbers. */
  skipped: { line: number; text: string }[];
}

/** `A[label]`, `A(label)`, `A([label])`, `A((label))`, `A{label}`, or a bare `A`. */
// No hyphens in ids: `A-->B` would otherwise read as a node called `A--`.
const NODE = /^([A-Za-z0-9_]\w*)\s*(\(\[[^\]]*\]\)|\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?/;

/** Every arrow in the flowchart grammar this reads, with an optional `|label|`. */
const EDGE = /^\s*(-->|---|-\.->|-\.-|==>|===|<-->|--\s+([^-]+?)\s+-->|--\s+([^-]+?)\s+---|==\s+([^=]+?)\s+==>|-\.\s+([^.]+?)\s+\.->)\s*(?:\|([^|]*)\|)?\s*/;

function unquote(s: string): string {
  const t = s.trim();
  return /^".*"$/.test(t) ? t.slice(1, -1) : t;
}

function shapeOf(wrapped: string | undefined): Pick<DiagramNode, 'kind' | 'rounded'> & { label?: string } {
  if (!wrapped) return {};
  if (wrapped.startsWith('([')) return { kind: 'rect', rounded: true, label: unquote(wrapped.slice(2, -2)) };
  if (wrapped.startsWith('((')) return { kind: 'ellipse', label: unquote(wrapped.slice(2, -2)) };
  if (wrapped.startsWith('[')) return { kind: 'rect', label: unquote(wrapped.slice(1, -1)) };
  if (wrapped.startsWith('(')) return { kind: 'rect', rounded: true, label: unquote(wrapped.slice(1, -1)) };
  if (wrapped.startsWith('{')) return { kind: 'diamond', label: unquote(wrapped.slice(1, -1)) };
  return {};
}

/**
 * Reads a Mermaid flowchart.
 *
 * The subset is the one agents write: the four directions, the five node
 * shapes, solid, dotted and thick arrows with labels in either spelling,
 * chains (`A --> B --> C`), `&` fan-out, and `subgraph … end`. `classDef`,
 * `style`, `click` and comments are recognised and ignored on purpose; anything
 * else comes back in `skipped` so the caller can say what was left out.
 */
export function parseMermaid(source: string): MermaidResult {
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [];
  const skipped: { line: number; text: string }[] = [];
  const stack: DiagramGroup[] = [];
  let direction: Direction = 'TB';

  const touch = (id: string, wrapped?: string) => {
    const shape = shapeOf(wrapped);
    const existing = nodes.get(id);
    if (existing) {
      // A later mention with a shape defines it; a bare mention never
      // overwrites a label given earlier.
      if (shape.label !== undefined) Object.assign(existing, shape, { label: shape.label });
    } else {
      nodes.set(id, { id, label: shape.label ?? id, kind: shape.kind ?? 'rect', ...(shape.rounded ? { rounded: true } : {}) });
    }
    const group = stack[stack.length - 1];
    if (group && !group.members.includes(id)) group.members.push(id);
    return id;
  };

  /**
   * Reads `A & B[x] & C` at the start of `rest`; returns ids and what is left.
   *
   * Nothing is recorded yet: a line is only believed once all of it has been
   * read. Otherwise `sequenceDiagram` on a line of its own would leave a node
   * called "sequenceDiagram" behind on its way to being reported as unreadable.
   */
  type Mention = { id: string; wrapped?: string };
  const readNodes = (rest: string, into: Mention[]): { ids: string[]; rest: string } | null => {
    const ids: string[] = [];
    let text = rest;
    for (;;) {
      const m = NODE.exec(text.trimStart());
      if (!m) return ids.length ? { ids, rest: text } : null;
      into.push({ id: m[1]!, wrapped: m[2] });
      ids.push(m[1]!);
      text = text.trimStart().slice(m[0].length);
      const amp = /^\s*&\s*/.exec(text);
      if (!amp) return { ids, rest: text };
      text = text.slice(amp[0].length);
    }
  };

  const lines = source.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/%%.*$/, '').trim().replace(/;$/, '');
    if (!line) return;

    const header = /^(?:flowchart|graph)\s*(TB|TD|BT|LR|RL)?\s*$/i.exec(line);
    if (header) { direction = (header[1]?.toUpperCase() === 'TD' ? 'TB' : (header[1]?.toUpperCase() as Direction)) ?? 'TB'; return; }

    const sub = /^subgraph\s+(.+)$/i.exec(line);
    if (sub) {
      // `subgraph id [Title]` or `subgraph "Title"` or `subgraph Title`.
      const m = /^([\w-]+)\s*\[(.+)\]$/.exec(sub[1]!.trim());
      const label = unquote(m ? m[2]! : sub[1]!);
      const group: DiagramGroup = { id: m ? m[1]! : `group${groups.length + 1}`, label, members: [] };
      groups.push(group);
      stack.push(group);
      return;
    }
    if (/^end$/i.test(line)) { stack.pop(); return; }
    if (/^direction\s+(TB|TD|BT|LR|RL)$/i.test(line)) return;
    if (/^(classDef|class|style|linkStyle|click)\b/i.test(line)) return;

    const mentions: Mention[] = [];
    const found: DiagramEdge[] = [];
    let first = readNodes(line, mentions);
    if (!first) { skipped.push({ line: i + 1, text: raw }); return; }
    let rest = first.rest;
    let ok = !rest.trim();
    while (rest.trim()) {
      const e = EDGE.exec(rest);
      if (!e) break;
      const arrow = e[1]!;
      const inlineLabel = e[2] ?? e[3] ?? e[4] ?? e[5];
      const label = unquote(e[6] ?? inlineLabel ?? '') || undefined;
      const next = readNodes(rest.slice(e[0].length), mentions);
      if (!next) break;
      const dashed = arrow.includes('.');
      const kind: DiagramEdge['arrow'] = arrow === '<-->' ? 'both' : /---|-\.-|===/.test(arrow) && !arrow.endsWith('>') ? 'none' : 'end';
      for (const from of first.ids) for (const to of next.ids) {
        found.push({ from, to, ...(label ? { label } : {}), ...(dashed ? { dashed: true } : {}), ...(kind !== 'end' ? { arrow: kind } : {}) });
      }
      first = next;
      rest = next.rest;
      ok = !rest.trim();
    }
    if (!ok) { skipped.push({ line: i + 1, text: raw }); return; }
    for (const m of mentions) touch(m.id, m.wrapped);
    edges.push(...found);
  });

  return { graph: { direction, nodes: [...nodes.values()], edges, groups }, skipped };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Top-left corner of the diagram in canvas space. */
  origin?: { x: number; y: number };
  /** Resolves `artboard` references to an id and its size. */
  artboards?: (ref: string) => { id: string; width: number; height: number } | null;
  /**
   * Whether artboards take part in the layout. Off, they are anchors: the
   * diagram is laid out without them and its connectors run to wherever they
   * are. On, they get a slot at their real size — for when the caller is about
   * to move them into it.
   */
  placeArtboards?: boolean;
  /** Gap between layers, and between nodes within one. */
  rankGap?: number;
  nodeGap?: number;
}

export interface LayoutResult {
  items: BoardItem[];
  /** Diagram node id → the board shape (or artboard) it became. */
  placed: Record<string, Endpoint>;
  /** Diagram node id → where the layout put it, artboards included. */
  boxes: Record<string, { x: number; y: number; width: number; height: number }>;
  bounds: { x: number; y: number; width: number; height: number };
  /** References that could not be resolved, and edges to unknown nodes. */
  problems: string[];
}

interface Sized { id: string; width: number; height: number }

/** How big a shape has to be for its label, roughly, before anything is measured. */
function sizeFor(node: DiagramNode): { width: number; height: number } {
  const text = node.label ?? '';
  const longest = Math.max(4, ...text.split(/\s+/).map((w) => w.length));
  // Wrap at about eighteen characters; 7.4px per character at 14px Inter.
  const perLine = Math.max(longest, Math.min(18, text.length));
  const lines = Math.max(1, Math.ceil(text.length / perLine));
  let width = Math.max(120, perLine * 7.4 + 36);
  let height = Math.max(56, lines * 19 + 30);
  if (node.kind === 'diamond') { width *= 1.45; height *= 1.45; }
  if (node.kind === 'ellipse') { width *= 1.2; height *= 1.15; }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Places a graph as board items.
 *
 * A layered layout, in the usual four steps: reverse the edges that close a
 * cycle so the graph has a direction to flow in, give every node the layer of
 * its longest path from a source, order each layer by the average position of
 * its neighbours over a few sweeps down and up (which is what keeps edges from
 * crossing), then lay the layers out with even gaps. Members of a subgraph are
 * kept next to each other within every layer, so the section drawn round them
 * contains them rather than half the diagram.
 */
export function layoutDiagram(graph: DiagramGraph, opts: LayoutOptions = {}): LayoutResult {
  const problems: string[] = [];
  const rankGap = opts.rankGap ?? 80;
  const nodeGap = opts.nodeGap ?? 48;
  const origin = opts.origin ?? { x: 0, y: 0 };
  const horizontal = graph.direction === 'LR' || graph.direction === 'RL';
  /** Space between a section's edge and what it contains. */
  const sectionPad = 28;
  /** Height of a section's title, above its contents. */
  const titleBand = graph.groups.length ? 36 : 0;

  const known = new Map(graph.nodes.map((n) => [n.id, n]));
  const allEdges = graph.edges.filter((e) => {
    const ok = known.has(e.from) && known.has(e.to);
    if (!ok) problems.push(`edge ${e.from} → ${e.to} names a node that is not defined`);
    return ok && e.from !== e.to;
  });

  // Artboard references resolved; anchored ones leave the layout entirely.
  const artboardOf = new Map<string, string>();
  const sized = new Map<string, Sized>();
  const anchored = new Set<string>();
  for (const n of graph.nodes) {
    if (n.artboard) {
      const found = opts.artboards?.(n.artboard);
      if (found) {
        artboardOf.set(n.id, found.id);
        if (opts.placeArtboards) {
          sized.set(n.id, { id: n.id, width: found.width, height: found.height });
        } else {
          // Laying out a slot for a screen that is not going to move there put
          // a 1440px hole in the middle of the diagram, and a long connector
          // from the real screen across it.
          anchored.add(n.id);
        }
        continue;
      }
      problems.push(`no artboard called "${n.artboard}" — drawn as a shape instead`);
    }
    sized.set(n.id, { id: n.id, ...sizeFor(n) });
  }
  const laidOut = graph.nodes.filter((n) => !anchored.has(n.id));
  // The layout runs on what it places; edges to an anchored artboard still
  // become connectors, they just do not decide anyone's layer.
  const edges = allEdges.filter((e) => !anchored.has(e.from) && !anchored.has(e.to));

  // 1. Break cycles with a depth-first search, reversing back edges.
  const out = new Map<string, string[]>();
  for (const n of laidOut) out.set(n.id, []);
  const flow: { from: string; to: string }[] = [];
  /** Edges that run against the flow, by index into `edges`. */
  const reversed = new Set<number>();
  {
    const state = new Map<string, 0 | 1 | 2>();
    const adjacency = new Map<string, string[]>();
    for (const n of laidOut) adjacency.set(n.id, []);
    for (const e of edges) adjacency.get(e.from)!.push(e.to);
    const back = new Set<string>();
    const visit = (id: string) => {
      state.set(id, 1);
      for (const to of adjacency.get(id)!) {
        if (state.get(to) === 1) back.add(`${id}\u0000${to}`);
        else if (!state.get(to)) visit(to);
      }
      state.set(id, 2);
    };
    for (const n of laidOut) if (!state.get(n.id)) visit(n.id);
    edges.forEach((e, i) => {
      const isBack = back.has(`${e.from}\u0000${e.to}`);
      if (isBack) reversed.add(i);
      const f = isBack ? { from: e.to, to: e.from } : { from: e.from, to: e.to };
      flow.push(f);
      out.get(f.from)!.push(f.to);
    });
  }

  // 2. Layers by longest path from a source.
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>();
  for (const n of laidOut) indegree.set(n.id, 0);
  for (const f of flow) indegree.set(f.to, indegree.get(f.to)! + 1);
  const queue = laidOut.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const to of out.get(id)!) {
      layer.set(to, Math.max(layer.get(to) ?? 0, layer.get(id)! + 1));
      indegree.set(to, indegree.get(to)! - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  const layerCount = Math.max(0, ...layer.values()) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  // Declaration order is the starting order, so an unconnected graph keeps the
  // order it was written in.
  for (const n of laidOut) layers[layer.get(n.id) ?? 0]!.push(n.id);

  // 3. Order within layers by barycentre, keeping groups together.
  const groupOf = new Map<string, number>();
  graph.groups.forEach((g, gi) => { for (const m of g.members) if (!groupOf.has(m)) groupOf.set(m, gi); });
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const n of laidOut) { up.set(n.id, []); down.set(n.id, []); }
  for (const f of flow) { down.get(f.from)!.push(f.to); up.get(f.to)!.push(f.from); }

  const position = new Map<string, number>();
  const record = () => layers.forEach((l) => l.forEach((id, i) => position.set(id, i)));
  record();
  const reorder = (l: string[], neighbours: Map<string, string[]>) => {
    const score = new Map<string, number>();
    l.forEach((id, i) => {
      const ns = neighbours.get(id)!.filter((n) => position.has(n));
      score.set(id, ns.length ? ns.reduce((s, n) => s + position.get(n)!, 0) / ns.length : i);
    });
    // A group sorts by the average of its members, so it moves as a block.
    const groupScore = new Map<number, number>();
    for (const [gi] of graph.groups.entries()) {
      const members = l.filter((id) => groupOf.get(id) === gi);
      if (members.length) groupScore.set(gi, members.reduce((s, id) => s + score.get(id)!, 0) / members.length);
    }
    l.sort((a, b) => {
      const ga = groupOf.get(a);
      const gb = groupOf.get(b);
      const ka = ga === undefined ? score.get(a)! : groupScore.get(ga)!;
      const kb = gb === undefined ? score.get(b)! : groupScore.get(gb)!;
      if (ka !== kb) return ka - kb;
      if (ga !== gb) return (ga ?? -1) - (gb ?? -1);
      return score.get(a)! - score.get(b)!;
    });
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let i = 1; i < layers.length; i++) { reorder(layers[i]!, up); record(); }
    for (let i = layers.length - 2; i >= 0; i--) { reorder(layers[i]!, down); record(); }
  }

  // 4. Coordinates. "Main" runs along the flow, "cross" across it.
  const main = (s: Sized) => (horizontal ? s.width : s.height);
  const cross = (s: Sized) => (horizontal ? s.height : s.width);
  const layerMain = layers.map((l) => Math.max(0, ...l.map((id) => main(sized.get(id)!))));
  const layerCross = layers.map((l) => l.reduce((s, id) => s + cross(sized.get(id)!), 0) + Math.max(0, l.length - 1) * nodeGap);
  const widest = Math.max(0, ...layerCross);
  const centres = new Map<string, { x: number; y: number }>();
  let mainAt = 0;
  layers.forEach((l, li) => {
    // Each layer is centred across the widest one, so a flow with a fan-out
    // in the middle does not lean to one side.
    let crossAt = (widest - layerCross[li]!) / 2;
    for (const id of l) {
      const s = sized.get(id)!;
      const c = crossAt + cross(s) / 2;
      const m = mainAt + layerMain[li]! / 2;
      centres.set(id, horizontal ? { x: m, y: c } : { x: c, y: m });
      crossAt += cross(s) + nodeGap;
    }
    mainAt += layerMain[li]! + rankGap;
  });

  // Reversed directions are mirrored along the main axis.
  const totalMain = Math.max(0, mainAt - rankGap);
  if (graph.direction === 'BT' || graph.direction === 'RL') {
    for (const c of centres.values()) {
      if (horizontal) c.x = totalMain - c.x;
      else c.y = totalMain - c.y;
    }
  }

  /*
   * Keep what is not in a group out of its section.
   *
   * Members sit together within each layer, but a section is one rectangle
   * across every layer its members reach — so a node that shares a layer with
   * a narrow member can still land inside the box drawn for a wide member two
   * layers up, and the diagram then says it belongs to a group it is not in.
   * Such a node is moved out, taking everything beyond it along, so nothing
   * else ends up on top of it.
   */
  const crossOf = (id: string) => (horizontal ? centres.get(id)!.y : centres.get(id)!.x);
  const shiftCross = (id: string, by: number) => {
    const c = centres.get(id)!;
    if (horizontal) c.y += by; else c.x += by;
  };
  graph.groups.forEach((g, gi) => {
    const members = g.members.filter((m) => centres.has(m));
    if (!members.length) return;
    // In a left-to-right flow the cross axis is vertical, and the title band
    // is part of the section on that axis: a node cleared of the members but
    // not of the title sat on top of the section's name.
    const lo = Math.min(...members.map((m) => crossOf(m) - cross(sized.get(m)!) / 2)) - sectionPad - (horizontal ? titleBand : 0);
    const hi = Math.max(...members.map((m) => crossOf(m) + cross(sized.get(m)!) / 2)) + sectionPad;
    const middle = (lo + hi) / 2;
    // Only the layers the section actually spans: it is a rectangle, and a
    // node above or below it is nowhere near it however wide it is.
    const spanned = members.map((m) => layer.get(m) ?? 0);
    const first = Math.min(...spanned);
    const last = Math.max(...spanned);
    for (const l of layers.slice(first, last + 1)) {
      const order = [...l].sort((a, b) => crossOf(a) - crossOf(b));
      for (let i = 0; i < order.length; i++) {
        const id = order[i]!;
        if (groupOf.get(id) === gi) continue;
        const half = cross(sized.get(id)!) / 2;
        const left = crossOf(id) - half;
        const right = crossOf(id) + half;
        if (right <= lo || left >= hi) continue;
        if (crossOf(id) < middle) {
          const by = lo - nodeGap / 2 - right;
          for (let j = 0; j <= i; j++) if (groupOf.get(order[j]!) !== gi) shiftCross(order[j]!, by);
        } else {
          const by = hi + nodeGap / 2 - left;
          for (let j = i; j < order.length; j++) if (groupOf.get(order[j]!) !== gi) shiftCross(order[j]!, by);
        }
      }
    }
  });
  // Shifting can push a column past the origin; bring the whole thing back.
  const minCross = Math.min(...[...centres.keys()].map((id) => crossOf(id) - cross(sized.get(id)!) / 2));
  if (minCross < 0) for (const id of centres.keys()) shiftCross(id, -minCross);

  // Sections get a title band; members are shifted so the band fits above
  // the first row rather than over it.

  const items: BoardItem[] = [];
  const placed: Record<string, Endpoint> = {};
  for (const id of anchored) placed[id] = { kind: 'artboard', id: artboardOf.get(id)! };
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const n of laidOut) {
    const s = sized.get(n.id)!;
    const c = centres.get(n.id)!;
    const box = {
      x: Math.round(origin.x + sectionPad + c.x - s.width / 2),
      y: Math.round(origin.y + sectionPad + titleBand + c.y - s.height / 2),
      width: s.width, height: s.height,
    };
    boxes.set(n.id, box);
    const artboard = artboardOf.get(n.id);
    if (artboard) { placed[n.id] = { kind: 'artboard', id: artboard }; continue; }
    const shape: BoardShape = makeBoardShape({
      kind: n.kind ?? 'rect', text: n.label, ...box,
      color: n.color && BOARD_COLOR_NAMES.includes(n.color) ? n.color : 'neutral',
      ...(n.rounded ? { rounded: true } : {}),
    });
    items.push(shape);
    placed[n.id] = { kind: 'shape', id: shape.id };
  }

  // Sections first in stacking order, so they sit under what they contain.
  const sections: BoardShape[] = [];
  for (const g of graph.groups) {
    const member = g.members.map((m) => boxes.get(m)).filter((b): b is NonNullable<typeof b> => !!b);
    if (!member.length) continue;
    const minX = Math.min(...member.map((b) => b.x)) - sectionPad;
    const minY = Math.min(...member.map((b) => b.y)) - sectionPad - titleBand;
    const maxX = Math.max(...member.map((b) => b.x + b.width)) + sectionPad;
    const maxY = Math.max(...member.map((b) => b.y + b.height)) + sectionPad;
    sections.push(makeBoardShape({
      kind: 'section', text: g.label, x: minX, y: minY, width: maxX - minX, height: maxY - minY,
      color: g.color ?? (BOARD_COLOR_NAMES[(sections.length % (BOARD_COLOR_NAMES.length - 1)) + 1] as BoardColor),
    }));
  }

  // An edge that runs back up the flow goes round the outside — out of one
  // side and into the same side of its target — rather than straight back
  // along the path of the edge it answers.
  const loopSide = horizontal ? 'bottom' as const : 'right' as const;
  const connectors: Connector[] = allEdges.map((e) => makeConnector({
    from: placed[e.from]!, to: placed[e.to]!,
    route: 'elbow', arrow: e.arrow ?? 'end',
    ...(e.label ? { label: e.label } : {}), ...(e.dashed ? { dashed: true } : {}),
    ...(reversed.has(edges.indexOf(e)) && layer.get(e.from) !== layer.get(e.to) ? { fromSide: loopSide, toSide: loopSide } : {}),
  }));

  const all = [...boxes.values()];
  const bx = Math.min(origin.x, ...all.map((b) => b.x), ...sections.map((s) => s.x));
  const by = Math.min(origin.y, ...all.map((b) => b.y), ...sections.map((s) => s.y));
  const bw = Math.max(...all.map((b) => b.x + b.width), ...sections.map((s) => s.x + s.width)) - bx;
  const bh = Math.max(...all.map((b) => b.y + b.height), ...sections.map((s) => s.y + s.height)) - by;

  return {
    items: [...sections, ...items, ...connectors],
    placed,
    boxes: Object.fromEntries(boxes),
    bounds: { x: bx, y: by, width: all.length ? bw : 0, height: all.length ? bh : 0 },
    problems,
  };
}
