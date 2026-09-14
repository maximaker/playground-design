# PRD — Codename **Canvas**
### A code-native, agent-connected design tool for the web

**Status:** Draft v1 — pre-development
**Date:** 2026-09-14
**Owner:** max@calemis.org

---

## 1. Summary

Canvas is a browser-based design tool whose document model *is* HTML and CSS. Designers work on an infinite canvas with Figma-like direct manipulation; every element they draw is a real DOM node with real computed styles, real flexbox, real font rendering. There is no export step that translates a proprietary scene graph into code — the design already is the code.

The second half of the product is the agent interface. Canvas ships an MCP server that lets coding agents (Claude Code, Cursor, Copilot, Claude Desktop) read and write the live document: inspect the tree, screenshot nodes, pull JSX, create artboards, write HTML, restyle, move, duplicate, delete. Agents and humans edit the same document concurrently, and each sees the other's changes live.

This is a deliberate clone-and-adapt of [paper.design](https://paper.design/), with one significant architectural departure: **Paper's MCP server runs inside a native desktop app on `127.0.0.1`. Canvas is web-only, so the MCP server is a hosted HTTP endpoint that pairs to a specific open document via a token.** That single change drives much of the system design in §7.

**Explicit non-goals for v1:** accounts, authentication, permissions, billing, teams. Documents are addressable by unguessable URL. This is stated by the requester as a deliberate priority call — the risk it carries is noted in §13.

---

## 2. Problem

Three problems compound in current design workflows:

1. **Translation loss.** Designs are drawn in a vector scene graph that has no concept of flex, inline flow, text wrapping under a real font stack, or cascade. Engineers re-derive intent from pixel measurements. Every handoff leaks.
2. **Agents cannot see design.** Coding agents are now doing a large share of UI implementation, but they are blind to the design file. They get a screenshot at best. They cannot inspect structure, cannot check their own work visually, cannot write back.
3. **Prototypes rot.** Prototype tooling produces artifacts that are not the product and cannot become the product.

Canvas addresses all three by making one artifact — a DOM tree — the design, the prototype, and the code.

---

## 3. Target users

| User | Job to be done |
|---|---|
| **Product designer** | Design screens that are actually buildable; hand the agent the file instead of a spec |
| **Design engineer** | Move fluidly between drawing and code; keep a component library that is simultaneously real |
| **Coding agent** | Read a design's structure and pixels; produce and revise UI without a human relaying it |
| **Developer prototyping** | Sketch an interface faster than writing it, then take the JSX |

---

## 4. Product principles

1. **The canvas is a browser.** If the browser can't do it, Canvas doesn't fake it. Layout, typography, and cascade are the real engine, not a simulation.
2. **Agents are first-class editors, not an API afterthought.** Every operation a human can do has an agent-reachable equivalent, and agent edits appear live on the human's screen.
3. **Structure survives.** Node identity is stable across moves, renames, and reparents so agents can hold references across turns.
4. **Escape hatches everywhere.** Any node can be inspected as CSS, copied as JSX, or replaced by pasted HTML.
5. **Read cheap, write precise.** Agent reads are summarizable and token-efficient (tree summaries, batch style reads); agent writes are surgical (batch, id-addressed, no full-document rewrites).

---

## 5. Feature scope

### 5.1 Canvas & navigation — *P0*

- Infinite pannable/zoomable canvas (space-drag, trackpad pan, ⌘/ctrl-scroll zoom, pinch).
- Zoom to fit / to selection / 100%.
- **Artboards**: named, sized frames that are the roots of renderable trees. Presets (Desktop 1440, Tablet 768, Mobile 390, custom). An artboard is a viewport, not just a rectangle — media queries inside it resolve against its own width.
- Multiple artboards per page; multiple pages per document.
- Rulers, snapping to node edges/centers, smart alignment guides, pixel grid at high zoom.
- Marquee select, deep-select (⌘-click into groups), multi-select across artboards.

### 5.2 Element model — *P0*

Every node is a DOM element with a stable `id`. Node types:

| Type | Backing element | Notes |
|---|---|---|
| Artboard | `<div>` root + isolated layout context | Own viewport width for media queries |
| Frame | `<div>` | The workhorse container; flex by default |
| Text | `<p>` / `<span>` / heading tags | Real text flow, selectable, editable in place |
| Image | `<img>` | With object-fit controls |
| Vector | `<svg>` | Paths preserved losslessly on import |
| Shape | `<div>` with border-radius, or `<svg>` | Rect/ellipse/line |
| Embed | `<iframe>` | For live-site or video embeds |
| Component instance | custom element wrapper | See §5.7 |

Constraints: no node type may exist that cannot round-trip to HTML/CSS and back.

### 5.3 Layout — *P0*

- **Flexbox as the primary model**, exposed with a designer-legible UI (direction, align, justify, gap, wrap, padding) rather than raw CSS names, with the real property name always visible on hover.
- **Absolute positioning** available per-child ("ignore layout") with offsets relative to nearest positioned ancestor.
- Sizing controls: fixed / hug (`fit-content`) / fill (`flex: 1`) / min/max, with `%`, `px`, `rem`, `vw/vh`, `ch` units.
- **CSS Grid** — *P1*. Column/row track editor with visual gutters.
- Overflow controls, aspect-ratio, z-order.
- Responsive: per-artboard-width overrides authored as real media queries or container queries. *P1.*

### 5.4 Styling — *P0*

- Fills: solid, linear/radial/conic gradient, image, **mesh gradient**.
- Strokes/borders: per-side width, style, color, radius per-corner.
- Shadows: box-shadow (multiple), text-shadow, inner shadow.
- Blur: layer blur (`filter: blur`) and backdrop blur.
- Blend modes (`mix-blend-mode`, `background-blend-mode`), opacity.
- Filters: brightness, contrast, saturate, hue-rotate, grayscale, invert, sepia. *P1.*
- Typography: family (Google Fonts + upload), weight, size, line-height, letter-spacing, transform, decoration, align, columns, truncation/line-clamp, OpenType features. *P0, with OpenType at P1.*
- **Raw CSS field** on every node — type any declaration not exposed in the UI. *P0.* This is the pressure valve that keeps the UI honest.
- Interaction states: hover / active / focus previews and authoring. *P1.*

### 5.5 Shaders & advanced visuals — *P1*

Paper's most differentiated surface. A library of GPU-accelerated animated fills rendered to a WebGL canvas layered inside a node:

- Mesh gradient, liquid metal, halftone, fluted glass, grain/noise, dot orbit, warp, swirl, static/ditherings.
- Each with a live parameter panel (colors, speed, scale, distortion) and live preview.
- Export as: animated (WebGL component code), still PNG, or MP4/WebM loop.
- Ship as a standalone open npm package (`@canvas/shaders`) so exported code has a real runtime dependency, mirroring Paper Shaders.

Particle system, advanced image filters, and Three.js islands are **P3** / explicitly deferred.

### 5.6 Vector editing — *P1*

- Pen/path tool, bezier handles, node add/remove/convert.
- Boolean ops (union, subtract, intersect, exclude).
- Stroke-to-path, path offset.
- **Lossless SVG import** — preserve gradients, masks, clip paths, `<use>`, filter primitives rather than flattening. This is a stated Paper differentiator and should be a correctness requirement, tested against a corpus of real-world SVGs.
- Icon pack browser (Lucide, Phosphor, Heroicons, Simple Icons). *P2.*

### 5.7 Components, tokens, themes — *P1*

- **Components**: create from selection, instances with overrides, variant sets (prop → value matrix), slots for children.
- **Tokens**: color, spacing, radius, typography, shadow, duration. Referenced by name; emitted as CSS custom properties.
- **Themes/modes**: a token set can have modes (light/dark/brand); switching a theme on an artboard re-resolves variables. Implemented as `data-theme` scoping, not a proprietary mechanism.
- **Token import/export**: W3C Design Tokens JSON, plus Tailwind config emit. *P2.*
- **Code components** — render a real React component from the user's repo inside the canvas. **P3, explicitly out of v1.** Requires a sandboxed bundler service; scope it separately.

### 5.8 Import & paste — *P0/P1*

- **Paste HTML** → parsed into the node tree with computed styles preserved. *P0.* This is also the primary agent write path.
- **Paste from Figma** → best-effort conversion of frames/auto-layout/text/vectors into DOM equivalents, with a fidelity report listing what could not be represented. *P1.*
- **Paste image** → upload + place. *P0.*
- **Snapshot**: a browser extension that captures a live page (DOM + computed styles + assets) and pastes it into Canvas as editable nodes. *P2.* Powerful for redesign workflows.
- Import SVG, PNG/JPG/WebP/AVIF, GIF, MP4, fonts (WOFF2/TTF/OTF).

### 5.9 Export — *P0*

| Target | Detail | Priority |
|---|---|---|
| JSX + Tailwind | Per-node or per-artboard, classnames resolved from tokens | P0 |
| JSX + inline styles | For agents/tools that prefer explicit values | P0 |
| HTML + CSS | Standalone document, stylesheet or inline | P0 |
| CSS only | Computed styles for a node | P0 |
| PNG / JPG / WebP | 1x/2x/3x, per node or artboard | P0 |
| SVG | Vector nodes | P0 |
| MP4 / WebM / GIF | For shaders and animated nodes | P1 |
| Design tokens JSON | W3C format | P2 |

Copy-to-clipboard is the primary affordance; file download secondary.

### 5.10 Live data — *P2*

Bind a text or image node to a field from a fetched JSON endpoint so designs render real content instead of lorem ipsum. Scope for v1: a URL + JQ-ish path expression + a refresh button. Write-back to source systems is **out of scope**.

### 5.11 Animation & prototyping — *P2*

- Transition/keyframe authoring on a node (CSS transitions and `@keyframes`), previewed live.
- Scroll-driven animation (`animation-timeline: scroll()`).
- Click-through prototyping: link a node to another artboard, presented in a Present mode.

### 5.12 Collaboration — *P1*

Given no accounts in v1, collaboration is anonymous-but-live:

- Multiplayer presence: cursors, selection highlights, per-session color and generated handle.
- Concurrent editing via CRDT (see §7.4).
- **Comments**: pinned threads on nodes or canvas coordinates, with replies and resolve. *P2.*
- Version history: named snapshots + automatic periodic checkpoints, with restore. *P1.*

### 5.13 AI inside the product — *P2*

Distinct from the MCP surface (which is about *external* agents):

- A canvas-aware assistant panel that can operate on the selection ("make this responsive", "generate three variations", "write real copy for this").
- Right-click → Remix on any node.
- Image generation into an image fill.

These are deferred because the MCP surface delivers most of the value first and with far less product surface area.

---

## 6. The agent interface (the centerpiece)

### 6.1 Requirements

- **R1.** An agent running on the user's machine can read and write the document currently open in the user's browser tab, with no local installation of Canvas itself.
- **R2.** Setup is one command the user copy-pastes.
- **R3.** Reads must be token-efficient: an agent must be able to understand a 2000-node document without ingesting 2000 nodes.
- **R4.** Writes must be addressable and batched: never "here is the new document."
- **R5.** Agent edits are visible to the human within ~200ms and are undoable by the human as discrete units.
- **R6.** The agent can *see* — screenshots of any node, at scale, so it can verify its own work.

### 6.2 Tool surface

Modeled closely on Paper's, which is well-designed. Grouped by kind.

**Orientation & read**

| Tool | Params | Returns |
|---|---|---|
| `get_basic_info` | — | Document name, current page, node count, artboard list with ids/names/dimensions |
| `get_selection` | — | Currently selected node ids, names, types, sizes, owning artboard |
| `get_node_info` | `id` | Size, position, visibility, lock, parent, children ids, text content, applied token refs |
| `get_children` | `id` | Direct children: ids, names, types, child counts |
| `get_tree_summary` | `id`, `depth?` | Compact indented text outline of a subtree — the primary cheap-read tool |
| `get_computed_styles` | `ids[]`, `properties?` | Batch computed CSS |
| `get_jsx` | `id`, `format: tailwind \| inline` | JSX for node + descendants |
| `get_screenshot` | `id`, `scale: 1\|2` | Base64 PNG |
| `get_fill_image` | `id` | Base64 JPEG of an image fill |
| `get_font_family_info` | `family` | Availability, weights, styles |
| `get_tokens` | `theme?` | Token set with resolved values |
| `get_guide` | `topic` | Guided workflow text (e.g. `figma-import`, `responsive`, `components`) |

**Write**

| Tool | Params | Notes |
|---|---|---|
| `create_artboard` | `name?`, `width`, `height`, `styles?` | Returns new id |
| `write_html` | `html`, `target_id`, `mode: insert-children \| replace \| insert-before \| insert-after` | The main creation path. Parses HTML/CSS into nodes. Returns created ids |
| `update_styles` | `updates: [{id, styles}]` | Batch; accepts token references |
| `set_text_content` | `updates: [{id, text}]` | Batch |
| `rename_nodes` | `updates: [{id, name}]` | Batch |
| `move_nodes` | `moves: [{id, parent_id?, index?, position?}]` | Reparent/reorder **preserving ids** |
| `duplicate_nodes` | `ids[]`, `target?` | Deep clone; returns new ids **and old→new descendant id map** |
| `delete_nodes` | `ids[]` | Cascades to descendants |
| `set_selection` | `ids[]` | Drives the human's viewport highlight |
| `export` | `ids[]`, `format`, `scale?` | PNG/JPG/SVG/MP4/… returns data or URL |

**Session hygiene**

| Tool | Notes |
|---|---|
| `start_working_on_nodes` | Marks artboards with a live "agent working" indicator for the human |
| `finish_working_on_nodes` | Clears it |

`write_html` deserves emphasis: giving agents an HTML-shaped write primitive rather than 30 granular creation tools is the single best design decision in Paper's MCP, because HTML is the format LLMs are most fluent in. Canvas must match or exceed its parsing fidelity (inline styles, `<style>` blocks, classes resolved against tokens, SVG, data attributes).

### 6.3 Pairing model (the web adaptation)

Paper avoids this problem by running MCP on `localhost` inside a desktop app. Canvas is web-only, so:

1. User opens a document and clicks **Connect agent**.
2. Canvas issues a short-lived **pair code** and displays the exact CLI command:
   ```bash
   claude mcp add canvas --transport http https://mcp.canvas.app/mcp?pair=XXXX-XXXX
   ```
3. The agent's first tool call redeems the code for a session token bound to `(document, browser tab)`.
4. The browser tab holds a WebSocket to the MCP gateway. Tool calls are proxied to the tab, executed against the live document, and results returned.
5. If the tab closes, the gateway serves a headless renderer of the document instead, so agents keep working (reads and writes persist; `get_selection` returns empty).
6. Pairing is revocable from the UI and expires on inactivity.

**Fallback:** a `npx canvas-mcp` stdio shim for clients that can't do remote HTTP MCP.

This design is also what makes a *headless* mode possible — an agent can create and populate a document with no human present, then hand over a URL. That is a capability Paper does not have and is worth treating as a v1 differentiator.

---

## 7. Architecture

### 7.1 Document model

A tree of nodes. Each node:

```ts
type NodeId = string;              // stable, never reused
interface Node {
  id: NodeId;
  type: 'artboard'|'frame'|'text'|'image'|'vector'|'shape'|'embed'|'instance';
  name: string;                     // layer name, authored or derived
  tag: string;                      // real HTML tag
  attrs: Record<string,string>;
  styles: StyleMap;                 // base styles
  variants: { selector: string; styles: StyleMap }[];  // :hover, media queries
  children: NodeId[];
  parent: NodeId | null;
  meta: { locked: boolean; visible: boolean; componentRef?: string };
}
```

`StyleMap` values are either literals or token references (`{$ref: 'color.brand.500'}`). The document serializes to JSON; HTML/CSS is a *projection* of it, not the storage format — this is important, because storage must hold things HTML can't (layer names, lock state, component bindings).

### 7.2 Rendering

The canvas renders each artboard into a **same-origin iframe** with an isolated CSS reset. Reasons: true media/container query resolution per artboard width, style isolation from the editor chrome, and a real `getComputedStyle` to read back.

Editor chrome (selection outlines, handles, guides) draws in an overlay layer above the iframes, positioned from `getBoundingClientRect` of the target nodes. Pointer events are intercepted at the overlay and mapped to nodes by hit-testing through the iframe.

Risk: iframe-per-artboard costs memory. Mitigation: virtualize — only artboards intersecting the viewport (plus a margin) get live iframes; offscreen ones render to a cached raster.

### 7.3 Stack

- **Frontend:** React + TypeScript, Vite. Zustand or Valtio for editor state. No heavy canvas framework — the DOM is the renderer.
- **Shaders:** WebGL2 via a thin custom runtime, published as `@canvas/shaders`.
- **Backend:** Node (Hono or Fastify). Postgres for document metadata; document bodies in object storage with a Postgres-backed op log. Redis for presence and pairing codes.
- **Realtime:** Yjs over WebSocket (y-websocket or a custom gateway).
- **MCP gateway:** separate service, HTTP streaming transport, proxies to browser sessions over WS; falls back to a headless Playwright renderer for screenshot/export and for tabless sessions.
- **Export/render workers:** Playwright + ffmpeg for PNG/MP4.

### 7.4 Concurrency

Yjs CRDT over the node map. Human edits and agent edits go through the same mutation API, so they merge without special-casing. Undo is per-origin (`Y.UndoManager` scoped by client id), so a human's ⌘Z does not undo an agent's work by accident — but an explicit "undo agent changes" action exists, scoped to a batch.

Agent writes are wrapped in a labeled transaction so version history shows *"Claude Code — added pricing section (12 nodes)"* rather than an unattributed diff.

---

## 8. UX specification

### 8.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  ⌂  Document name       [ Connect agent ]  [Present] [Share] │  top bar
├────────────┬──────────────────────────────────┬──────────────┤
│  Layers    │                                  │  Properties  │
│  Pages     │           CANVAS                 │  ─ Layout    │
│  Assets    │                                  │  ─ Styles    │
│  Tokens    │      [artboard] [artboard]       │  ─ Typography│
│  Components│                                  │  ─ Effects   │
│            │                                  │  ─ CSS       │
│            │                                  │              │
├────────────┴──────────────────────────────────┴──────────────┤
│   ▢ Frame  T Text  ⬚ Shape  ✎ Pen  ⬤ Image  ✦ Shader  ⌗ …   │  toolbar
└──────────────────────────────────────────────────────────────┘
```

- **Left rail** — tabbed: Layers (tree, drag-reorder, rename inline, visibility/lock), Pages, Assets, Tokens, Components.
- **Right panel** — contextual to selection; collapsible sections; every control shows its CSS property on hover; a raw-CSS editor lives at the bottom, always.
- **Toolbar** — bottom-center floating, keyboard-first (`F` frame, `T` text, `R` rect, `O` ellipse, `P` pen, `V` move).
- **Agent presence** — when an agent is working, affected artboards get an animated border and a small chip naming the agent. A collapsible activity log shows tool calls in plain language.

### 8.2 Key interactions

- Double-click to enter a frame / edit text in place.
- Drag between flex children shows an insertion line; dropping reparents and the layout resolves live.
- Alt-drag duplicates; Alt-hover measures distances.
- ⌘C on a node copies JSX by default (configurable); ⌘⇧C copies CSS.
- ⌘V of arbitrary HTML from the clipboard creates nodes.
- Right-click → Copy as / Export / Create component / Wrap in frame.

### 8.3 Empty state

New document opens with one Desktop artboard and a persistent card: *"Connect an agent"* with the copy-paste command, plus *"Paste HTML or a Figma frame to start."*

---

## 9. Milestones

| Phase | Scope | Exit criteria |
|---|---|---|
| **M0 — Spike** (2 wks) | Node model, iframe renderer, selection overlay, move/resize | Can draw and move a frame; styles round-trip to CSS |
| **M1 — Editor core** (6 wks) | Frames, text, images, shapes; flex layout panel; full style panel; layers tree; pages; undo; persistence | A designer can build a real landing page artboard unaided |
| **M2 — Agent surface** (4 wks) | MCP gateway, pairing, all read tools, `write_html`, `update_styles`, move/duplicate/delete, screenshots, JSX export | Claude Code builds a full artboard from a prompt and iterates on it using screenshots |
| **M3 — Fidelity** (4 wks) | JSX/Tailwind/CSS/HTML export, HTML paste fidelity, SVG import, token system, Google Fonts | Exported JSX renders pixel-identical in a fresh Vite app |
| **M4 — Multiplayer** (3 wks) | Yjs, presence, version history, agent-attributed transactions | Two humans + one agent edit concurrently without corruption |
| **M5 — Depth** (6 wks) | Shaders, vector/pen tool, components + variants, themes, responsive overrides | Ship-ready public beta |

Deferred past beta: Grid editor, Snapshot extension, live data, animation/prototyping, in-app AI, code components.

---

## 10. Success metrics

- **Agent round-trip success rate** — % of agent sessions that produce an artboard the human keeps without manual repair. Target ≥ 60% at beta.
- **Export fidelity** — automated pixel-diff between an artboard and its exported JSX rendered standalone. Target ≥ 99% of pixels within tolerance across a 50-design corpus. Treat as a CI gate.
- **Time-to-first-artboard** for a new document. Target < 3 min unaided.
- **Agent read cost** — median tokens to orient in a 500-node document. Target < 4k.
- **Canvas performance** — 60fps pan/zoom with 12 live artboards / 2000 nodes.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| iframe-per-artboard memory/perf ceiling | High | Virtualize offscreen artboards to raster; cap live iframes; measure from M0, not M4 |
| Selection overlay drift vs real DOM geometry | High | Drive overlay from `ResizeObserver` + rAF-synced `getBoundingClientRect`; never cache geometry across layout |
| HTML-paste fidelity is a bottomless pit | Medium | Corpus-driven: fix against a fixed test set of 100 real pages; ship a fidelity report instead of pretending |
| Remote MCP pairing is more fragile than localhost | Medium | Headless fallback renderer; clear reconnect UX; stdio shim |
| Agents producing large, low-quality trees | Medium | `get_guide` workflows; a linter that flags absolutely-positioned soup; agent-attributed undo |
| CRDT + DOM tree edge cases (concurrent reparent) | Medium | Yjs with a well-tested tree-move algorithm; property-based tests on concurrent op sequences |
| Scope: shaders + vectors + components are each a product | High | Sequenced to M5; each independently shippable and independently cuttable |

---

## 12. Open questions

1. **Tailwind-first or CSS-first storage?** Storing literal CSS and *emitting* Tailwind is more faithful; storing Tailwind classes is more useful for the common export target. Recommendation: CSS-first with a token-aware Tailwind emitter — reversible, and Tailwind versions change.
2. **How much Figma import fidelity is worth buying?** Suggest: frames, auto-layout, text, fills, vectors. Not: variants, prototyping, effects-on-groups. Ship the fidelity report from day one.
3. **Do agents get their own document-level lock?** Concurrent human+agent edits to the same subtree will be confusing even when they merge correctly. A soft lock ("agent is editing this artboard") may be worth more than the CRDT correctness alone.
4. **Component system: DOM-native or React-native?** A component that is a subtree with overrides is simple; a component that emits a real React component with props is far more useful downstream. Leaning the second, but it complicates the canvas.

---

## 13. Note on the no-accounts decision

The requester has scoped out accounts, auth, and permissions for v1 to prioritize a working product. That is a reasonable sequencing call and this PRD follows it. Two consequences to hold in view:

- Documents reachable by unguessable URL are effectively public to anyone who obtains the link, and MCP pairing codes are the only thing standing between an agent and document writes. Pairing codes must be short-lived, single-redemption, and revocable even in v1 — this is not "auth", it's basic hygiene, and it costs little.
- Retrofitting ownership onto documents later is cheap; retrofitting it onto the *realtime and MCP session layers* is not. Recommend threading an opaque `owner_session` field through the document and session schemas now, unused, so v2 has somewhere to land.

---

## Appendix A — Reference material

- [paper.design](https://paper.design/) — product site
- [Paper roadmap](https://paper.design/roadmap) — shipped/in-progress/planned features
- [Paper MCP docs](https://paper.design/docs/mcp) — tool surface this PRD's §6.2 is modeled on
- [Paper docs index](https://paper.design/docs)
- [Banani review of Paper](https://www.banani.co/blog/paper-design-mcp-review) — MCP capabilities, pricing
- [DesignMonks case study](https://www.designmonks.co/case-study/paper-design-tool)
- [EverydayUX on Paper](https://www.everydayux.net/paper-code-native-design-tool/) — design philosophy
- [Abduzeedo on Paper shaders](https://abduzeedo.com/paperdesign-gpu-shaders-mcp-and-vibe-coding-designers)
