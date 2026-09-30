# Diagrams: the board layer

Status: slice one is built — board shapes, connectors, sections, and diagrams
an agent can write. Checks: `board.test.ts` (23), `scripts/board-check.mjs`
(19, over MCP) and `scripts/board-ui-check.mjs` (22, through the editor's own
input).

## The decision

Diagrams live on the canvas *between* artboards, not inside them and not in a
separate mode.

An artboard is real HTML laid out with flexbox, which is what makes export,
components, tokens and the linter work. A diagram is the opposite shape: every
box is placed by hand and every arrow is geometry. Writing diagrams into
artboards would mean absolutely-positioned soup — the thing the layout guide
calls the single most common reason agent output gets thrown away. A separate
mode would duplicate selection, undo, ops, realtime, export and the MCP surface
for a feature FigJam and Excalidraw already give away.

The canvas already has a layer that is not HTML: artboards are placed by
`data-x`/`data-y`, and prompt cards are canvas-space rectangles on the page.
The board is more of that layer. It never exports as part of a design, the
linter never sees it, and a flowchart can use absolute positions without
anything flagging it.

What makes it worth building here rather than using a whiteboard is one thing:
**a connector's end can be an artboard.** A user flow drawn between the real
screens stays attached as the screens change.

## Model

Board items live on the page, in stacking order:

```ts
interface Page {
  // …
  board?: BoardItem[];
}

type BoardItem = BoardShape | Connector;

interface BoardShape {
  type: 'shape';
  id: string;
  kind: 'rect' | 'ellipse' | 'diamond' | 'text' | 'section';
  x: number; y: number; width: number; height: number;   // canvas space
  text: string;
  color: BoardColor;      // a named swatch, not a free colour
}

interface Connector {
  type: 'connector';
  id: string;
  from: Endpoint;
  to: Endpoint;
  route: 'straight' | 'elbow' | 'curved';
  arrow: 'end' | 'both' | 'none';
  label?: string;
  color: BoardColor;
  dashed?: boolean;
  fromSide?: Side;      // set by the layout for edges that loop back
  toSide?: Side;
}

type Endpoint =
  | { kind: 'shape'; id: string }       // a board shape
  | { kind: 'artboard'; id: NodeId }    // an artboard — the reason this exists
  | { kind: 'point'; x: number; y: number };
```

Colours are a small named set (`neutral`, `slate`, `blue`, `green`, `yellow`,
`red`, `purple`) resolved to fill, edge, text and line colours in one table, so
a board stays coherent the way a token set keeps a design coherent, and so an
agent chooses a meaning rather than a hex value.

The look is a user-flow sheet rather than a whiteboard: slim white pills with
a hairline slate edge, solid slate pills for the system's own steps, soft grey
circles, dashed open diamonds for decisions, hairline connectors that start
from a small hollow ring, grey pill labels, and "yes"/"no" drawn as a green
tick and a red cross on the line. Colour is kept for meaning. Sections are
white sheets lifted off the canvas. `shapeLook` and `BOARD_STYLE` hold all of
it, and both renderers read them. Connectors can be elbow (the default),
curved — a node-editor wire — or straight.

A section is a shape too: a titled region drawn under everything else. It does
not own its contents — dragging a section moves what sits inside it, which is
computed at the start of the drag rather than stored, so nothing has to keep a
membership list in sync.

## One op

```ts
{ t: 'board'; pageId: string; changes: BoardChange[] }

type BoardChange =
  | { action: 'add'; item: BoardItem; index?: number }
  | { action: 'update'; id: string; patch: Partial<BoardItem> }
  | { action: 'remove'; id: string };
```

A batch of changes in one op, because moving five shapes is one gesture and
one undo step. The inverse is the reversed list of each change's inverse, so
undo is exact: a `remove` inverts to an `add` at the index the item came from,
and an `update` inverts to the fields it touched and only those.

Board ops touch no design nodes: like comments they are chrome, so they bump
the canvas version without re-laying-out a single artboard. Dragging a shape at
sixty frames a second must not restyle every iframe on the page.

Removing a shape does not remove the connectors attached to it. The command
that deletes it first turns their bound ends into points where the shape was —
the Excalidraw behaviour — so a half-drawn diagram survives an edit. That is
done by the caller (`deleteBoardItems`), not inside `applyOp`, so `applyOp`
stays a plain function of each change and its inverse stays exact.

A connector whose artboard is deleted is not drawn, and comes back on undo.
`get_board` reports it as dangling so an agent can repair it.

## Geometry

Pure functions in `shared/board.ts`, used by both the canvas and the SVG
emitter so the two cannot disagree about where an arrow goes:

- `endpointBox(doc, page, endpoint)` — a shape's box, an artboard's box, or a
  zero-size box at a point.
- `routeConnector(doc, page, connector)` — the polyline. Straight connectors
  run between the two boundary points facing each other, intersected with the
  real outline (a rectangle, an ellipse, a diamond). Elbow connectors leave
  from the sides facing each other and bend once or twice.
- `labelPoint(points)` — the middle of the path by length.

No obstacle avoidance in this slice. Elbows go around nothing; they are right
for flows laid out in rows and columns, which is what `write_diagram` produces.

Each end of an elbow runs straight out of its side before it may turn, so an
arrow never bends while still touching its shape. A connector can name the
side each end uses; the layout does this for edges that run back up the flow,
sending them out of and into the same side, so a "try again" arrow goes round
the outside instead of being drawn on top of the arrow it answers.

## Diagrams an agent writes

`write_diagram` takes either Mermaid or a structure:

```
flowchart LR
  A[Sign up] --> B{Verified?}
  B -- yes --> C([Dashboard])
  B -- no --> D[Resend email]
  subgraph Onboarding
    A
    B
  end
```

The supported subset is the flowchart grammar agents actually emit: the four
directions, `[rect]` `(rounded)` `([stadium])` `((circle))` `{diamond}`,
`-->` `---` `-.->` `==>`, labels as `-->|label|` or `-- label -->`, chains,
`&`, and `subgraph … end` as sections. Anything else is reported back as an
unparsed line rather than silently dropped.

Layout is a small layered (Sugiyama) layout written for this: break cycles,
assign layers by longest path, order each layer by barycentre over a few
sweeps, then place with even spacing. No dependency, and deterministic, so the
same Mermaid lays out the same way twice. Subgraph members are kept together
within each layer; a section's box is its members' box plus padding.

A node in a `write_diagram` call can name an artboard (`artboard: "Checkout"`)
instead of being a new shape, which is how an agent draws a flow between the
real screens. By default the artboard is an *anchor*: it stays where the person
put it, takes no part in the layout, and the connectors run to it. Giving it a
slot at its real size without moving it into that slot put a 1440px hole in
the middle of the first diagram drawn this way. `arrangeArtboards: true` gives
each one a slot and moves it there, in the same undoable step.

## Tools

- **`get_board`** — every item with its geometry and bindings, the artboards
  that can be connected to, dangling connectors, and optionally the board as
  SVG.
- **`edit_board`** — a batch of adds, updates and removes, the op in tool
  form. Removals unbind connectors the same way the canvas does.
- **`write_diagram`** — Mermaid or nodes-and-edges in, laid-out shapes and
  connectors out, placed clear of the artboards unless told where.

A `diagrams` toolset so a session can leave them off.

## On the canvas

- Rectangle (R), ellipse (O) and text (T) drawn on *empty canvas* make board
  shapes. They used to answer "draw inside an artboard" with a toast, so the
  gesture that did nothing now does the obvious thing. Inside an artboard they
  still make HTML layers, exactly as before.
- Diamond (D), connector (X) and section (Shift+S) are new tools. X and
  Shift+S are FigJam's keys.
- A connector is drawn by dragging from one thing to another; whatever is
  under each end — a shape or an artboard — is what it binds to, and the
  target is highlighted before you let go.
- Click selects, Shift-click adds, a marquee on empty canvas takes board items
  too. Drag moves, handles resize, double-click edits text, Delete removes.
  Board selection is separate from layer selection, like prompt cards.
- A small bar over the selection sets colour, the shape of a box, and for
  connectors the route, the arrowheads and dashing.
- Undo is the same undo: every gesture is one entry.
- Connectors are drawn *under* shapes and over artboards. The other way round,
  a line passing over a box took the clicks meant for the box.
- Zoom to fit (1) includes the board, so a page that is only a diagram, or a
  flow beside the screens, comes into view.

## Not in this slice

Freehand ink, stamps and the hand-drawn look — the most visible parts of
whiteboard tools and the least useful ones for a product about design systems.
Obstacle-avoiding routing. Connectors to layers *inside* an artboard (the
endpoint type has room for it; hit-testing through the iframe is the work).
Copy and paste of board items. Board items in presentation mode.
