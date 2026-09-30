import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, type Op } from './ops.ts';
import { createEmptyDocument, makeNode, type CanvasDocument, type Page } from './model.ts';
import {
  boardItemsInRect, danglingConnectors, deleteBoardItems, emitBoardSvg, makeBoardShape, makeConnector,
  routeConnector, sectionContents, type BoardItem, type Connector,
} from './board.ts';
import { layoutDiagram, parseMermaid } from './diagram.ts';

function fixture(items: BoardItem[] = []): { doc: CanvasDocument; page: Page } {
  const doc = createEmptyDocument('Board');
  const page = doc.pages[0]!;
  page.board = structuredClone(items);
  return { doc, page };
}

const rect = (id: string, x: number, y: number, w = 100, h = 60) =>
  makeBoardShape({ id, kind: 'rect', x, y, width: w, height: h });

// --- Ops ---------------------------------------------------------------------

test('a board op applies every change and its inverse undoes all of them', () => {
  const { doc, page } = fixture([rect('a', 0, 0)]);
  const op: Op = {
    t: 'board', pageId: page.id, changes: [
      { action: 'add', item: rect('b', 200, 0) },
      { action: 'update', id: 'a', patch: { x: 40, text: 'Moved' } },
    ],
  };
  const inverse = applyOp(doc, op);
  assert.equal(page.board!.length, 2);
  assert.equal((page.board![0] as { x: number }).x, 40);
  applyOp(doc, inverse);
  assert.deepEqual(page.board, [rect('a', 0, 0)]);
});

test('removing an item and undoing puts it back at the same depth', () => {
  const { doc, page } = fixture([rect('a', 0, 0), rect('b', 10, 0), rect('c', 20, 0)]);
  const inverse = applyOp(doc, { t: 'board', pageId: page.id, changes: [{ action: 'remove', id: 'b' }] });
  assert.deepEqual(page.board!.map((i) => i.id), ['a', 'c']);
  applyOp(doc, inverse);
  assert.deepEqual(page.board!.map((i) => i.id), ['a', 'b', 'c']);
});

test('undoing a change to a field that was unset removes it again, and survives JSON', () => {
  const { doc, page } = fixture([makeConnector({ id: 'k', from: { kind: 'point', x: 0, y: 0 }, to: { kind: 'point', x: 50, y: 0 } })]);
  const inverse = applyOp(doc, { t: 'board', pageId: page.id, changes: [{ action: 'update', id: 'k', patch: { label: 'yes' } }] });
  assert.equal((page.board![0] as Connector).label, 'yes');
  // The inverse goes over the wire when it is undone; undefined would vanish.
  applyOp(doc, JSON.parse(JSON.stringify(inverse)));
  assert.equal('label' in page.board![0]!, false);
});

test('a batch that fails partway leaves the board untouched', () => {
  const { doc, page } = fixture([rect('a', 0, 0)]);
  assert.throws(() => applyOp(doc, {
    t: 'board', pageId: page.id, changes: [
      { action: 'update', id: 'a', patch: { x: 99 } },
      { action: 'remove', id: 'missing' },
    ],
  }));
  assert.equal((page.board![0] as { x: number }).x, 0);
});

// --- Routing -----------------------------------------------------------------

test('a straight connector meets each outline, not its bounding box', () => {
  const { doc, page } = fixture([
    rect('a', 0, 0, 100, 100),
    makeBoardShape({ id: 'b', kind: 'diamond', x: 300, y: 300, width: 100, height: 100 }),
  ]);
  const c = makeConnector({ from: { kind: 'shape', id: 'a' }, to: { kind: 'shape', id: 'b' }, route: 'straight' });
  const route = routeConnector(doc, page, c)!;
  // Leaves the square at its corner on the diagonal…
  assert.deepEqual(route.points[0], { x: 100, y: 100 });
  // …and meets the diamond on its edge, halfway to its centre along x.
  assert.equal(Math.round(route.points[1]!.x), 325);
  assert.equal(Math.round(route.points[1]!.y), 325);
});

test('an elbow leaves along the axis the gap runs', () => {
  const { doc, page } = fixture([rect('a', 0, 0), rect('b', 300, 200)]);
  const c = makeConnector({ from: { kind: 'shape', id: 'a' }, to: { kind: 'shape', id: 'b' } });
  const pts = routeConnector(doc, page, c)!.points;
  assert.deepEqual(pts[0], { x: 100, y: 30 });            // right side of a
  assert.deepEqual(pts[pts.length - 1], { x: 300, y: 230 }); // left side of b
  assert.equal(pts.length, 4);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i]!.x === pts[i - 1]!.x || pts[i]!.y === pts[i - 1]!.y, 'every segment is orthogonal');
  }
});

test('a connector can end on an artboard', () => {
  const { doc, page } = fixture([rect('a', 0, 0)]);
  const board = makeNode({ type: 'artboard', name: 'Checkout', styles: { width: '400px', height: '800px' }, attrs: { 'data-x': '600', 'data-y': '0' } });
  doc.nodes[board.id] = board;
  page.artboards.push(board.id);
  const c = makeConnector({ from: { kind: 'shape', id: 'a' }, to: { kind: 'artboard', id: board.id } });
  const pts = routeConnector(doc, page, c)!.points;
  assert.equal(pts[pts.length - 1]!.x, 600);
});

test('a connector to something that is gone is not routed, and is reported', () => {
  const { doc, page } = fixture([
    rect('a', 0, 0),
    makeConnector({ id: 'k', from: { kind: 'shape', id: 'a' }, to: { kind: 'artboard', id: 'n_gone' } }),
  ]);
  assert.equal(routeConnector(doc, page, page.board![1] as Connector), null);
  assert.deepEqual(danglingConnectors(doc, page), ['k']);
});

// --- Deleting ----------------------------------------------------------------

test('deleting a shape keeps its connectors, ending where the shape was', () => {
  const { doc, page } = fixture([
    rect('a', 0, 0), rect('b', 300, 0),
    makeConnector({ id: 'k', from: { kind: 'shape', id: 'a' }, to: { kind: 'shape', id: 'b' } }),
  ]);
  const changes = deleteBoardItems(doc, page, ['b']);
  applyOp(doc, { t: 'board', pageId: page.id, changes });
  const k = page.board!.find((i) => i.id === 'k') as Connector;
  assert.deepEqual(k.to, { kind: 'point', x: 300, y: 30 });
  assert.deepEqual(k.from, { kind: 'shape', id: 'a' });
  assert.equal(page.board!.some((i) => i.id === 'b'), false);
});

// --- Selection helpers -------------------------------------------------------

test('a section contains what sits inside it, and never another section', () => {
  const { page } = fixture([
    makeBoardShape({ id: 's', kind: 'section', x: 0, y: 0, width: 400, height: 300 }),
    makeBoardShape({ id: 'inner', kind: 'section', x: 20, y: 20, width: 100, height: 100 }),
    rect('in', 50, 50), rect('out', 500, 50),
  ]);
  assert.deepEqual(sectionContents(page, 's'), ['in']);
});

test('a marquee inside a section takes its contents, not the section', () => {
  const { doc, page } = fixture([
    makeBoardShape({ id: 's', kind: 'section', x: 0, y: 0, width: 400, height: 300 }),
    rect('in', 50, 50),
  ]);
  assert.deepEqual(boardItemsInRect(doc, page, { x: 40, y: 40, width: 100, height: 100 }), ['in']);
  assert.deepEqual(boardItemsInRect(doc, page, { x: -10, y: -10, width: 500, height: 400 }).sort(), ['in', 's']);
});

// --- Mermaid -----------------------------------------------------------------

test('reads the flowchart grammar agents write', () => {
  const { graph, skipped } = parseMermaid(`
    flowchart LR
      A[Sign up] --> B{Verified?}
      B -- yes --> C([Dashboard])
      B -->|no| D[Resend email]
      D -.-> B
      subgraph Onboarding
        A
        B
      end
      classDef hot fill:#f00
  `);
  assert.deepEqual(skipped, []);
  assert.equal(graph.direction, 'LR');
  assert.deepEqual(graph.nodes.map((n) => [n.id, n.label, n.kind]), [
    ['A', 'Sign up', 'rect'], ['B', 'Verified?', 'diamond'], ['C', 'Dashboard', 'rect'], ['D', 'Resend email', 'rect'],
  ]);
  assert.equal(graph.nodes.find((n) => n.id === 'C')!.rounded, true);
  assert.deepEqual(graph.edges, [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C', label: 'yes' },
    { from: 'B', to: 'D', label: 'no' },
    { from: 'D', to: 'B', dashed: true },
  ]);
  assert.deepEqual(graph.groups, [{ id: 'group1', label: 'Onboarding', members: ['A', 'B'] }]);
});

test('chains and fan-out become every edge they imply', () => {
  const { graph } = parseMermaid('graph TD\nA --> B --> C\nC & D --> E');
  assert.deepEqual(graph.edges.map((e) => `${e.from}${e.to}`), ['AB', 'BC', 'CE', 'DE']);
});

test('a line it cannot read is reported, not dropped, and leaves nothing behind', () => {
  const { graph, skipped } = parseMermaid('flowchart TD\nA --> B\nsequenceDiagram nonsense ~~~');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.line, 3);
  // The first word of a bad line looks like a node id; it must not become one.
  assert.deepEqual(graph.nodes.map((n) => n.id), ['A', 'B']);
});

// --- Layout ------------------------------------------------------------------

test('a top-down flow puts each step below the one before, without overlaps', () => {
  const { graph } = parseMermaid('flowchart TD\nA --> B\nA --> C\nB --> D\nC --> D');
  const { items } = layoutDiagram(graph);
  const shapes = items.filter((i) => i.type === 'shape') as { x: number; y: number; width: number; height: number; text: string }[];
  const by = (t: string) => shapes.find((s) => s.text === t)!;
  assert.ok(by('B').y > by('A').y && by('D').y > by('B').y);
  assert.equal(by('B').y, by('C').y, 'siblings share a layer');
  for (const a of shapes) for (const b of shapes) {
    if (a === b) continue;
    const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(!overlap, `${a.text} overlaps ${b.text}`);
  }
});

test('a cycle still lays out, and the same input lays out the same way twice', () => {
  const src = 'flowchart LR\nA --> B\nB --> C\nC --> A';
  const strip = (items: BoardItem[]) => items.map((i) => (i.type === 'shape' ? [i.text, i.x, i.y] : [i.type]));
  const one = layoutDiagram(parseMermaid(src).graph);
  const two = layoutDiagram(parseMermaid(src).graph);
  assert.equal(one.items.filter((i) => i.type === 'connector').length, 3);
  assert.deepEqual(strip(one.items), strip(two.items));
});

test('a subgraph becomes a section around its members, under them', () => {
  const { graph } = parseMermaid('flowchart LR\nsubgraph Pay\nA --> B\nend\nB --> C');
  const { items } = layoutDiagram(graph);
  const section = items.find((i) => i.type === 'shape' && i.kind === 'section')!;
  assert.equal(items.indexOf(section), 0, 'sections come first in stacking order');
  const s = section as { x: number; y: number; width: number; height: number };
  for (const t of ['A', 'B']) {
    const m = items.find((i) => i.type === 'shape' && i.text === t) as typeof s;
    assert.ok(m.x >= s.x && m.y >= s.y && m.x + m.width <= s.x + s.width && m.y + m.height <= s.y + s.height, `${t} is inside`);
  }
});

test('nothing that is not in a group sits inside its section, and the rest of the flow is left alone', () => {
  const { graph } = parseMermaid(`flowchart TD
    S --> A --> B
    B --> C
    B --> D
    D -.-> B
    C --> E --> F
    subgraph G
      A
      B
      D
    end`);
  const { items } = layoutDiagram(graph);
  const section = items.find((i) => i.type === 'shape' && i.kind === 'section') as { x: number; y: number; width: number; height: number };
  const shape = (t: string) => items.find((i) => i.type === 'shape' && i.text === t) as { x: number; y: number; width: number; height: number };
  const inside = (b: typeof section) => b.x < section.x + section.width && b.x + b.width > section.x
    && b.y < section.y + section.height && b.y + b.height > section.y;
  for (const t of ['S', 'C', 'E', 'F']) assert.ok(!inside(shape(t)), `${t} is outside the section`);
  // S sits above the section, so nothing should have pushed it sideways: it
  // stays centred over the node it leads to.
  const s = shape('S'); const a = shape('A');
  assert.equal(Math.round(s.x + s.width / 2), Math.round(a.x + a.width / 2));
});

test('in a left-to-right flow a node beside a section clears its title too', () => {
  const { graph } = parseMermaid(`flowchart LR
    A --> B
    B -- yes --> D((Done))
    B -- no --> C
    subgraph G
      A
      B
      C
    end`);
  const { items } = layoutDiagram(graph);
  const section = items.find((i) => i.type === 'shape' && i.kind === 'section') as { x: number; y: number; width: number; height: number };
  const done = items.find((i) => i.type === 'shape' && i.text === 'Done') as typeof section;
  const overlaps = done.x < section.x + section.width && done.x + done.width > section.x
    && done.y < section.y + section.height && done.y + done.height > section.y;
  assert.ok(!overlaps, 'Done sits clear of the whole section, title included');
});

test('an edge back up the flow goes round the outside', () => {
  const { graph } = parseMermaid('flowchart TD\nA --> B\nB --> C\nC --> A');
  const { items } = layoutDiagram(graph);
  const back = items.find((i) => i.type === 'connector' && i.fromSide) as Connector;
  assert.equal(back.fromSide, 'right');
  assert.equal(back.toSide, 'right');
  const { doc, page } = fixture(items);
  const pts = routeConnector(doc, page, back)!.points;
  const shapes = items.filter((i) => i.type === 'shape') as { x: number; width: number }[];
  const rightmost = Math.max(...shapes.map((s) => s.x + s.width));
  assert.ok(Math.max(...pts.map((p) => p.x)) > rightmost - 60, 'it runs outside the column, not through it');
});

test('a node can be a real artboard, which is left where it is', () => {
  const { items, placed, problems, boxes } = layoutDiagram(
    { direction: 'LR', nodes: [{ id: 'a', label: 'Cart', artboard: 'Cart' }, { id: 'b', label: 'Pay' }], edges: [{ from: 'a', to: 'b' }], groups: [] },
    { artboards: (ref) => (ref === 'Cart' ? { id: 'n_cart', width: 390, height: 844 } : null) },
  );
  // No slot is laid out for a screen that is not going to move into it: the
  // diagram starts at its own origin rather than 390px in.
  assert.equal(boxes.a, undefined);
  assert.equal(boxes.b!.x, 28);
  assert.deepEqual(problems, []);
  assert.deepEqual(placed.a, { kind: 'artboard', id: 'n_cart' });
  assert.equal(items.filter((i) => i.type === 'shape').length, 1, 'no shape is drawn for the artboard');
  assert.deepEqual((items.find((i) => i.type === 'connector') as Connector).from, { kind: 'artboard', id: 'n_cart' });
});

// --- SVG ---------------------------------------------------------------------

test('asked to place artboards, the layout gives each one a slot at its real size', () => {
  const { boxes } = layoutDiagram(
    { direction: 'LR', nodes: [{ id: 'a', label: 'Cart', artboard: 'Cart' }, { id: 'b', label: 'Pay' }], edges: [{ from: 'a', to: 'b' }], groups: [] },
    { placeArtboards: true, artboards: () => ({ id: 'n_cart', width: 390, height: 844 }) },
  );
  assert.equal(boxes.a!.width, 390);
  assert.ok(boxes.b!.x > boxes.a!.x + 390);
});

test('the SVG draws every shape, connector and label', () => {
  const { graph } = parseMermaid('flowchart LR\nA[Start] -->|go| B((End))');
  const { items } = layoutDiagram(graph);
  const { doc, page } = fixture(items);
  const svg = emitBoardSvg(doc, page);
  assert.match(svg, /^<svg /);
  assert.match(svg, />Start</);
  assert.match(svg, /<ellipse /);
  assert.match(svg, />go</);
  assert.match(svg, /<path d="M/);
});
