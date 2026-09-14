# Canvas

A design tool whose documents are real HTML and CSS — and that coding agents can edit alongside you.

Draw on an infinite canvas with direct manipulation. Every element is a real DOM node with real
computed styles, real flexbox, real font rendering. There is no export step that translates a
proprietary scene graph into code: the design already *is* the code.

The other half is the agent surface. Canvas hosts an MCP server that lets Claude Code, Cursor,
Copilot or Claude Desktop read and write the live document — inspect the tree, take screenshots,
write HTML, restyle layers, pull JSX. Agent edits appear in the browser within a frame, are
attributed in version history, and are undoable.

This is a working implementation of [PRD.md](PRD.md).

---

## Run it

```bash
npm install
npm run build:web && npm start
```

Then open <http://localhost:4000>. That is the whole thing: one server, one port, no database to
provision. For development with hot reload, run `npm run dev` instead (API on :4000, client on :5173).

Optional, strongly recommended — headless rendering for screenshots and image export:

```bash
npm i -D playwright --workspace=@canvas/server && npx playwright install chromium
```

Without it, screenshots fall back to rasterizing inside a connected browser tab, which is less
faithful (text can re-wrap) and needs someone to have the document open.

## Connect an agent

Open a document, click **Connect agent**, generate a code, and run the line it gives you:

```bash
claude mcp add canvas --transport http http://localhost:4000/mcp/YOUR-CODE-HERE
```

Then ask your agent to *"describe what's on the Canvas artboard"* — or just *"build me a pricing
page"*. Setup snippets for Claude Desktop, Cursor and VS Code are in the same panel.

Two scripts show the shape of an agent session end to end:

```bash
node scripts/agent-demo.mjs <documentId>   # builds a pricing page + a mobile variant
node scripts/headless-demo.mjs             # creates and builds a document with no browser open
```

---

## The agent surface

Most tools run against the server's copy of the document, so they work with **no browser tab open**
— an agent can create a document, build in it, render it, and hand back a URL. Only the tools that
need a real layout engine reach into a connected tab, and they say so plainly when there isn't one.

**Orientation and reading**

| Tool | What it gives you |
|---|---|
| `get_basic_info` | Pages, node count, artboards with sizes and canvas positions. Call this first |
| `get_tree_summary` | Compact indented outline of a subtree — the cheap way to understand a design |
| `get_node_info` | One node in full: styles, variants, attributes, text, parent, children |
| `get_children` | One level down: ids, names, types, child counts |
| `find_nodes` | Search by name, text, tag or type |
| `get_selection` | What the human has selected right now |
| `get_computed_styles` | Authored styles, plus browser-resolved values and measured boxes when a tab is open |
| `get_screenshot` | PNG of any node, so the agent can see its own work |
| `get_html` / `get_jsx` | HTML+CSS, or JSX in Tailwind or inline-style form |
| `get_fill_image` | The bytes behind an image node |
| `get_font_family_info` | Whether a family and weight are actually available |
| `get_tokens` | Design tokens and themes |
| `get_guide` | Workflow briefs: `layout`, `styling`, `responsive`, `components`, `export`, `figma-import` |

**Writing**

| Tool | Notes |
|---|---|
| `write_html` | The main creation tool. HTML in, editable layers out |
| `create_artboard` | New screen, placed clear of existing work |
| `update_styles` | Batch CSS, with `:hover` / `@media` variants via `selector` |
| `set_text_content` | Batch text |
| `rename_nodes` / `set_attributes` | Batch |
| `move_nodes` | Reparent and reorder, preserving ids |
| `duplicate_nodes` | Deep clone; returns a full old→new id map |
| `delete_nodes` | Cascades to descendants |
| `set_tokens` | Add or update tokens |
| `set_selection` | Select nodes in the human's browser and scroll them into view |
| `export` | PNG, JPG, SVG or standalone HTML, returned as download URLs |
| `start_working_on_nodes` / `finish_working_on_nodes` | Live "agent working" indicator, and a restore point |

### Why `write_html` rather than granular creation tools

Giving agents an HTML-shaped write primitive is the single highest-leverage decision in this design.
HTML is the format models are most fluent in, so one tool covers what would otherwise be thirty
`create_frame` / `set_flex_direction` calls. Inline styles and `<style>` rules become node styles;
`:hover` and `@media` rules become node variants; `<script>` is stripped.

---

## How it works

**Document model.** A tree of nodes stored as JSON. HTML/CSS is a *projection* of it, not the
storage format — storage has to hold layer names, lock state, and token *references* that HTML
cannot carry. Every edit, human or agent, goes through one `applyOp` function that returns its own
inverse, which is what makes undo, realtime broadcast and version history the same mechanism.

**Rendering.** Each artboard renders into its own same-origin iframe. This is not incidental: it
gives every artboard a real viewport, so `@media (max-width: 768px)` inside a 390px artboard
resolves the way it will in production. Selection chrome is drawn in an overlay above, measured from
the real DOM on a rAF loop — a hugging frame or a wrapped line has no width in the document at all,
only in the layout engine.

**Agent pairing.** Paper solves this by running MCP on localhost inside a desktop app. Canvas is
web-only, so the MCP endpoint is hosted and a connection code binds it to one document. That
constraint turns out to be an advantage: because tools run against the stored document rather than
a browser tab, fully headless agent sessions work.

```
Browser tab ──WebSocket──┐
                         ├── Server (document authority, op log, SQLite)
Coding agent ──MCP/HTTP──┘         │
                                   └── Playwright (screenshots, export)
```

---

## Deviations from the PRD

Worth stating plainly, since the PRD is in this repo:

- **Server-authoritative ops instead of a CRDT.** [PRD §7.4](PRD.md) specifies Yjs. This
  implementation serializes ops on the server and assigns revisions; a client whose optimistic state
  diverges is handed the authoritative document. This is correct for concurrent editing and much
  simpler, but it does not merge truly simultaneous edits to the same property as gracefully as a
  CRDT would. Swapping the transport later does not change the op vocabulary.
- **Not built:** shaders, the pen tool, component instances and variants, Figma paste, the Snapshot
  extension, live data binding, animation/prototyping, and the in-app AI assistant. These are M5+ in
  the PRD and each is independently shippable.
- **Grid support is partial** — a `grid-template-columns` field, not a visual track editor.

## Testing

```bash
npm test
```

- `packages/shared` — model, ops and their inverses, CSS/HTML parsing, JSX and Tailwind emission
- `packages/server/src/mcp.test.ts` — a real MCP client over real HTTP, exercising the whole tool
  surface the way an agent does, including the error paths
- `packages/server/src/fidelity.test.ts` — the export-fidelity gate: render an artboard, export it,
  re-import the export into a fresh document, render that, and pixel-diff the two

## Security

There are no accounts in this version, by design. Documents are reachable by unguessable URL, and a
connection code is the only thing between an agent and write access. So codes are short-lived before
first use, expire on inactivity, are compared in constant time, and are revocable from the UI. An
unused `owner_session` column is threaded through the document and session schemas so that adding
real ownership later does not mean migrating the realtime and MCP session layers.

Do not put anything sensitive in a Canvas document as it stands.
