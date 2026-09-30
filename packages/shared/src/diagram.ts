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
  // Wrap at about twenty characters; 7px a character at 13px semibold Inter.
  const perLine = Math.max(longest, Math.min(20, text.length));
  const lines = Math.max(1, Math.ceil(text.length / perLine));
  // Slim: a one-line step is a 40px pill, the way a user flow draws one.
  let width = Math.max(112, perLine * 7 + 40);
  let height = Math.max(40, lines * 17 + 22);
  if (node.kind === 'diamond') { width = Math.max(128, perLine * 6.4 + 70); height = Math.max(92, lines * 17 + 62); }
  // A circle's text sits in the square inside it, which is 70% of its width,
  // so it is sized for its longest line to fit there, not across the middle.
  if (node.kind === 'ellipse') { const d = Math.max(88, Math.round((perLine * 7.4 + 12) / 0.7)); width = d; height = d; }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * One layered layout: positions for `ids`, top-left corners, relative to 0,0.
 *
 * The usual four steps. Reverse the edges that close a cycle so the graph has
 * a direction to flow in; give every node the layer of its longest path from a
 * source; order each layer by the average position of its neighbours over a
 * few sweeps down and up, which is what keeps edges from crossing; then lay
 * the layers out with even gaps, each centred across the widest.
 */
function layered(
  ids: string[], edges: { from: string; to: string }[], sizes: Map<string, { width: number; height: number }>,
  direction: Direction, rankGap: number, nodeGap: number, blocks: Set<string> = new Set(),
): { pos: Map<string, { x: number; y: number }>; width: number; height: number; layer: Map<string, number> } {
  const horizontal = direction === 'LR' || direction === 'RL';
  const inGraph = new Set(ids);
  const flow = edges.filter((e) => inGraph.has(e.from) && inGraph.has(e.to) && e.from !== e.to);

  // 1. Break cycles: a depth-first search, reversing the edges that go back.
  const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of flow) adjacency.get(e.from)!.push(e.to);
  const state = new Map<string, number>();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of adjacency.get(id)!) {
      if (state.get(to) === 1) back.add(`${id}\u0000${to}`);
      else if (!state.get(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) visit(id);
  const dag = flow.map((e) => (back.has(`${e.from}\u0000${e.to}`) ? { from: e.to, to: e.from } : e));

  // 2. Layers by longest path.
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of dag) { out.get(e.from)!.push(e.to); indegree.set(e.to, indegree.get(e.to)! + 1); }
  const layer = new Map<string, number>();
  const queue = ids.filter((id) => indegree.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const to of out.get(id)!) {
      layer.set(to, Math.max(layer.get(to) ?? 0, layer.get(id)! + 1));
      indegree.set(to, indegree.get(to)! - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  const count = ids.length ? Math.max(...ids.map((id) => layer.get(id) ?? 0)) + 1 : 0;
  const layers: string[][] = Array.from({ length: count }, () => []);
  for (const id of ids) layers[layer.get(id) ?? 0]!.push(id);

  // 3. Order within layers by barycentre.
  const up = new Map(ids.map((id) => [id, [] as string[]]));
  const down = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of dag) { down.get(e.from)!.push(e.to); up.get(e.to)!.push(e.from); }
  const position = new Map<string, number>();
  const record = () => layers.forEach((l) => l.forEach((id, i) => position.set(id, i)));
  record();
  const reorder = (l: string[], neighbours: Map<string, string[]>) => {
    const score = new Map<string, number>();
    l.forEach((id, i) => {
      const ns = neighbours.get(id)!;
      score.set(id, ns.length ? ns.reduce((sum, n) => sum + position.get(n)!, 0) / ns.length : i);
    });
    l.sort((a, b) => score.get(a)! - score.get(b)!);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let i = 1; i < layers.length; i++) { reorder(layers[i]!, up); record(); }
    for (let i = layers.length - 2; i >= 0; i--) { reorder(layers[i]!, down); record(); }
  }

  // 4. Coordinates. "Main" runs along the flow, "cross" across it.
  const main = (id: string) => (horizontal ? sizes.get(id)!.width : sizes.get(id)!.height);
  const cross = (id: string) => (horizontal ? sizes.get(id)!.height : sizes.get(id)!.width);
  const layerMain = layers.map((l) => Math.max(0, ...l.map(main)));
  // Nodes are centred on the line of the other nodes in their layer, not on a
  // block's: a node beside a tall section used to float to its middle, a
  // thousand pixels from the edges that reach it.
  const lineOf = layers.map((l) => Math.max(0, ...l.filter((id) => !blocks.has(id)).map(main)));
  const layerCross = layers.map((l) => l.reduce((sum, id) => sum + cross(id), 0) + Math.max(0, l.length - 1) * nodeGap);
  const widest = Math.max(0, ...layerCross);
  const totalMain = layerMain.reduce((sum, m) => sum + m, 0) + Math.max(0, layers.length - 1) * rankGap;
  const pos = new Map<string, { x: number; y: number }>();
  let mainAt = 0;
  layers.forEach((l, li) => {
    let crossAt = (widest - layerCross[li]!) / 2;
    for (const id of l) {
      // Centred on its layer's line, so a small node beside a big one sits
      // level with it rather than hanging from its top edge.
      let m = mainAt + (blocks.has(id) ? 0 : (lineOf[li]! - main(id)) / 2);
      if (direction === 'BT' || direction === 'RL') m = totalMain - m - main(id);
      pos.set(id, horizontal ? { x: m, y: crossAt } : { x: crossAt, y: m });
      crossAt += cross(id) + nodeGap;
    }
    mainAt += layerMain[li]! + rankGap;
  });
  return {
    pos, layer,
    width: horizontal ? totalMain : widest,
    height: horizontal ? widest : totalMain,
  };
}

/**
 * Places a graph as board items.
 *
 * A subgraph is laid out as a block. Its members are arranged on their own,
 * the block they make is sized to fit them with room for a title, and then
 * the blocks and the nodes outside any group are arranged together as though
 * each block were one big node. Laying everything out as one flat graph and
 * drawing a rectangle round each group afterwards is what the first version
 * did, and with more than one or two groups the rectangles overlapped and
 * sections claimed nodes that were not in them. As blocks, a section contains
 * exactly its members and no two sections can overlap.
 */
export function layoutDiagram(graph: DiagramGraph, opts: LayoutOptions = {}): LayoutResult {
  const problems: string[] = [];
  const rankGap = opts.rankGap ?? 72;
  const nodeGap = opts.nodeGap ?? 44;
  const origin = opts.origin ?? { x: 0, y: 0 };
  const direction = graph.direction;
  const horizontal = direction === 'LR' || direction === 'RL';
  /** Space between a section's edge and what it contains. */
  const sectionPad = 28;
  /** Height of a section's title, above its contents. */
  const titleBand = 40;

  const known = new Map(graph.nodes.map((n) => [n.id, n]));
  const allEdges = graph.edges.filter((e) => {
    const ok = known.has(e.from) && known.has(e.to);
    if (!ok) problems.push(`edge ${e.from} → ${e.to} names a node that is not defined`);
    return ok && e.from !== e.to;
  });

  // Artboard references; anchored ones take no part in the layout.
  const artboardOf = new Map<string, string>();
  const sizes = new Map<string, { width: number; height: number }>();
  const anchored = new Set<string>();
  for (const n of graph.nodes) {
    if (n.artboard) {
      const found = opts.artboards?.(n.artboard);
      if (found) {
        artboardOf.set(n.id, found.id);
        // Laying out a slot for a screen that is not going to move there put
        // a 1440px hole in the middle of the diagram.
        if (opts.placeArtboards) sizes.set(n.id, { width: found.width, height: found.height });
        else anchored.add(n.id);
        continue;
      }
      problems.push(`no artboard called "${n.artboard}" — drawn as a shape instead`);
    }
    sizes.set(n.id, sizeFor(n));
  }
  const laidOut = graph.nodes.filter((n) => !anchored.has(n.id)).map((n) => n.id);
  const edges = allEdges.filter((e) => !anchored.has(e.from) && !anchored.has(e.to));

  // Each node belongs to at most one group: the first that names it.
  const groupOf = new Map<string, number>();
  graph.groups.forEach((g, gi) => { for (const m of g.members) if (sizes.has(m) && !anchored.has(m) && !groupOf.has(m)) groupOf.set(m, gi); });
  const blockId = (gi: number) => `\u0000group${gi}`;

  // Inner layouts, one per group, and the block each becomes.
  const inner = new Map<number, ReturnType<typeof layered>>();
  graph.groups.forEach((_, gi) => {
    const members = laidOut.filter((id) => groupOf.get(id) === gi);
    if (!members.length) return;
    const own = edges.filter((e) => groupOf.get(e.from) === gi && groupOf.get(e.to) === gi);
    const l = layered(members, own, sizes, direction, rankGap, nodeGap);
    inner.set(gi, l);
    sizes.set(blockId(gi), { width: l.width + sectionPad * 2, height: l.height + sectionPad * 2 + titleBand });
  });

  // The outer layout: top-level nodes and blocks, joined by whatever crosses.
  const outerOf = (id: string) => (groupOf.has(id) && inner.has(groupOf.get(id)!) ? blockId(groupOf.get(id)!) : id);
  const outerIds = [...new Set(laidOut.map(outerOf))];
  const seen = new Set<string>();
  const outerEdges: { from: string; to: string }[] = [];
  for (const e of edges) {
    const from = outerOf(e.from);
    const to = outerOf(e.to);
    if (from === to || seen.has(`${from}\u0000${to}`)) continue;
    seen.add(`${from}\u0000${to}`);
    outerEdges.push({ from, to });
  }
  const outer = layered(outerIds, outerEdges, sizes, direction, rankGap, nodeGap,
    new Set([...inner.keys()].map(blockId)));

  // Absolute boxes.
  const at = { x: origin.x + sectionPad, y: origin.y + sectionPad };
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const sections: BoardShape[] = [];
  for (const id of outerIds) {
    const p = outer.pos.get(id)!;
    const size = sizes.get(id)!;
    const gi = [...inner.keys()].find((g) => blockId(g) === id);
    if (gi === undefined) {
      boxes.set(id, { x: Math.round(at.x + p.x), y: Math.round(at.y + p.y), ...size });
      continue;
    }
    const block = { x: Math.round(at.x + p.x), y: Math.round(at.y + p.y), ...size };
    const g = graph.groups[gi]!;
    sections.push(makeBoardShape({ kind: 'section', text: g.label, ...block, color: g.color ?? 'neutral' }));
    const l = inner.get(gi)!;
    for (const [member, q] of l.pos) {
      boxes.set(member, {
        x: Math.round(block.x + sectionPad + q.x),
        y: Math.round(block.y + sectionPad + titleBand + q.y),
        ...sizes.get(member)!,
      });
    }
  }

  const items: BoardItem[] = [];
  const placed: Record<string, Endpoint> = {};
  for (const id of anchored) placed[id] = { kind: 'artboard', id: artboardOf.get(id)! };
  for (const n of graph.nodes) {
    const box = boxes.get(n.id);
    if (!box) continue;
    const artboard = artboardOf.get(n.id);
    if (artboard) { placed[n.id] = { kind: 'artboard', id: artboard }; continue; }
    const shape = makeBoardShape({
      kind: n.kind ?? 'rect', text: n.label, ...box,
      color: n.color && BOARD_COLOR_NAMES.includes(n.color) ? n.color : 'neutral',
      ...(n.rounded ? { rounded: true } : {}),
    });
    items.push(shape);
    placed[n.id] = { kind: 'shape', id: shape.id };
  }

  /*
   * An edge that runs back up the flow goes round the outside — out of one
   * side and into the same side of its target — rather than straight back
   * along the path of the edge it answers. Judged from where things ended up,
   * so it holds for edges inside a block and for edges between blocks alike.
   */
  const upstream = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => {
    switch (direction) {
      case 'TB': return b.y + b.height <= a.y;
      case 'BT': return b.y >= a.y + a.height;
      case 'LR': return b.x + b.width <= a.x;
      case 'RL': return b.x >= a.x + a.width;
    }
  };
  const loopSide = horizontal ? 'bottom' as const : 'right' as const;
  const connectors: Connector[] = allEdges.map((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    return makeConnector({
      from: placed[e.from]!, to: placed[e.to]!,
      route: 'elbow', arrow: e.arrow ?? 'end',
      ...(e.label ? { label: e.label } : {}), ...(e.dashed ? { dashed: true } : {}),
      ...(a && b && upstream(a, b) ? { fromSide: loopSide, toSide: loopSide } : {}),
    });
  });

  const all = [...boxes.values(), ...sections];
  const bx = all.length ? Math.min(...all.map((b) => b.x)) : origin.x;
  const by = all.length ? Math.min(...all.map((b) => b.y)) : origin.y;
  return {
    // Sections first in stacking order, so they sit under what they contain.
    items: [...sections, ...items, ...connectors],
    placed,
    boxes: Object.fromEntries(boxes),
    bounds: {
      x: bx, y: by,
      width: all.length ? Math.max(...all.map((b) => b.x + b.width)) - bx : 0,
      height: all.length ? Math.max(...all.map((b) => b.y + b.height)) - by : 0,
    },
    problems,
  };
}
