# Playground

A design tool whose documents are real HTML and CSS — and that coding agents can edit alongside you.

**Live:** <https://playground-design-theta.vercel.app> · **Source:** <https://github.com/maximaker/playground-design>

Draw on an infinite canvas with direct manipulation. Every element is a real DOM node with real
computed styles, real flexbox, real font rendering. There is no export step that translates a
proprietary scene graph into code: the design already *is* the code.

The other half is the agent surface. Playground hosts an MCP server that lets Claude Code, Codex,
Cursor, Copilot or Claude Desktop read and write the live document — inspect the tree, take screenshots,
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
claude mcp add playground --transport http http://localhost:4000/mcp/YOUR-CODE-HERE
```

The hosted version works the same way — its codes point at
`https://playground-design-theta.vercel.app/mcp/…`.

Then ask your agent to *"describe what's on the Canvas artboard"* — or just *"build me a pricing
page"*. Setup snippets for Codex, Claude Desktop, Cursor and VS Code are in the same panel — Codex
gets both the `codex mcp add` line and the `~/.codex/config.toml` block.

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

**Prompt cards**

| Tool | What it does |
|---|---|
| `list_notes` | Cards on the canvas. A `queued` one is a request waiting for an agent |
| `claim_note` | Take a card, so a second agent does not duplicate the work |
| `respond_to_note` | Record what you did; the answer appears on the card |
| `create_note` | Leave a note for the human where they will see it, next to the design |

**Components**

| Tool | What it does |
|---|---|
| `list_components` | Components, with instance counts, slots and structure |
| `create_component` | Turn a subtree into a component and replace it with an instance |
| `insert_instance` | Place instances |
| `get_instance` | What an instance renders, and which parts can be overridden |
| `set_override` | Change one instance without touching the others |
| `detach_instance` | Convert an instance back to ordinary layers |
| `set_component_props` | Declare the properties a component varies by |
| `set_variant` | Define what a property combination looks like |
| `set_instance_props` | Switch instances between variants |

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
| `list_templates` | Built-in starter design systems |

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
| `import_url` | Fetch a public webpage and turn it into editable layers |
| `apply_template` | Merge a starter design system's tokens and foundations sheet |
| `start_working_on_nodes` / `finish_working_on_nodes` | Live "agent working" indicator, and a restore point |

**Code components**

| Tool | Notes |
|---|---|
| `get_code_component_guide` | The bundle contract. Read it before registering |
| `register_code_component` | Upload a bundled component; declare its props |
| `list_code_components` | What is available to place, and how often it is used |
| `add_code_instance` | Place one, with props |
| `set_code_props` | Change a placed instance's props |
| `get_code_usage` | Every instance, with the JSX it will export as |
| `remove_code_component` | Unregister; refuses while instances exist |

### Designing with the project's real components

A design tool that makes you rebuild a button you already have is guessing at your codebase. Code
components close that loop: the agent bundles a real component out of the repo — it has the
filesystem and the toolchain, the browser has neither — and uploads a self-contained ES module that
exports `mount(element, props)`. The canvas renders it for real, with the props you declared as the
designer's controls, and JSX export emits `<Button variant="primary" />` with an import of your own
module rather than a copy of its markup.

The bundle is third-party code, so it runs in an iframe sandboxed `allow-scripts` and deliberately
*without* `allow-same-origin`: an opaque origin, with no access to the document, the page, cookies or
storage. It never fetches its own module either — an opaque origin cannot reach a private address at
all, so the editor fetches the bundle once and the sandbox imports a blob it creates itself. Styles
do not cross that boundary, so a component must bring its own CSS or take tokens as props.

Artboards that host one run with scripts enabled, which used to be impossible anywhere on the canvas;
vector markup is sanitised at render and at export so that loosening it does not hand an imported SVG
a way to run.

### Why `write_html` rather than granular creation tools

Giving agents an HTML-shaped write primitive is the single highest-leverage decision in this design.
HTML is the format models are most fluent in, so one tool covers what would otherwise be thirty
`create_frame` / `set_flex_direction` calls. Inline styles and `<style>` rules become node styles;
`:hover` and `@media` rules become node variants; `<script>` is stripped.

---

## In the editor

**Canvas craft.** Snapping to edges, centres and equal-spacing runs, with guides drawn live and ⌘
to suspend it. Option-hover measures the distance from the selection to whatever is under the
cursor. Right-click menu, and shortcuts that follow Figma (press `?` for the sheet).

**Alignment.** An align row sits at the top of the properties panel for every selection, grouped
three horizontal and three vertical with distribute set apart. It is permanent on purpose: a control
that appears only for a multi-selection cannot be reached for, because you have to find it first.

Aligning is two different operations wearing one word. Artboards and absolutely positioned layers
move — one on its own aligns inside its container, which is what "align this left" means when there
is only one thing. Children in flex or grid flow cannot move: the engine owns their position, so the
honest reading is "make their container align its contents left", and that is what the bar does,
saying which container it changed. Only a block parent has no answer; there the buttons are disabled
and say why.

**Layout.** How a container lays out is four pictures — loose, stack, row, grid — not a `display`
dropdown beside a `flex-direction` dropdown. That split is most of what makes flexbox feel like a
puzzle rather than a choice, and one control settles it.

Alongside it, a 3×3 pad for the contents, because the intent is spatial and the CSS is not:
"top-left" means `justify-content` in a row and `align-items` in a column, and both invert under
`row-reverse`. Each cell previews the result with three bars laid out the way the container actually
lays out, so you can pick one without reading. `stretch` is the CSS default and has no cell, so a
stretched axis lights up the whole row or column it spans rather than leaving nothing selected.

The raw `display`, `flex-direction`, `align-items` and `justify-content` are still there, folded
under a **CSS** disclosure — the premise of the tool is that you are editing CSS and should be able
to see which declaration a control produced, but two controls for one property at equal weight is how
a panel stops being readable.

**Numeric fields.** Three ways to change a value, because different edits want different gestures:
type it, hold ↑/↓ to walk it, or drag the handle to scrub. Shift steps by ten and Alt by a tenth
throughout. Typing `+8`, `-4`, `*2` or `/2` applies to what the field already holds, and the unit is
preserved — stepping `2rem` gives `3rem`, not `3px`. A whole gesture folds into one undo step, so a
two-second scrub does not bury everything before it under ninety entries.

**Live cursors.** Other people's pointers, labelled and in their colour. Positions travel in *world*
coordinates rather than screen ones, because everyone is at a different zoom and scroll position —
send a screen point and the cursor still appears, just over the wrong part of the design, which is
the version that looks like it works. Movement between updates is CSS, not JavaScript interpolation.

Peers arrive as one list and are split into two store slices on purpose: a cursor moves twenty times
a second, a selection changes on a click, and the overlay measures a rect per selected node — which
forces an artboard iframe to lay out. Letting cursor churn invalidate the selection slice would put
the editor into permanent layout thrash the moment a second person joined.

**Comments.** Threads pinned to the design, with `C` to place one. Deliberately not a prompt card: a
card is work you are handing to an agent and it has a lifecycle, a comment is something a person said
and what it needs is a reply and a way to mark it settled. The pin keeps its own coordinates as well
as the node it is about, because a remark has to outlive the thing it criticised — a comment that
vanishes with the layer is worse than no comment.

Agents read them. `list_comments` is the actual brief, more specific than anything an agent will
infer from the design alone; `reply_to_comment` puts the answer on the pin where the question was
asked; `resolve_comment` refuses to close a thread with no reply on it, because a thread that goes
quiet and then closes tells the person who raised it nothing.

A view-only link can comment — that is the reason to send one — and nothing else. Both transports run
the same rule, and it allows only the additive parts: adding, replying, resolving. Rewriting or
deleting someone else's words is not something a link-holder should be able to do.

**Prompt cards.** Sticky notes that live next to the thing they are about. Write what you want
changed, attach the layers it concerns, and hand it to an agent: it claims the card, does the work,
and the answer comes back on the card. This is pen.dev's framing — an agent workspace rather than a
design file with a chatbox bolted on — and it fits a canvas far better than a chat log, because the
request keeps its spatial context.

**Components and variants.** Create a component from a selection; it is replaced by an instance so
the canvas keeps rendering the same pixels. Declare properties (`size: sm|md|lg`, `tone: …`) and each
combination can look different. The cascade is base → matching variants, least specific first → the
instance's own overrides, so `{tone: danger}` applies at every size and `{size: lg, tone: danger}`
refines it rather than replacing it. Mark a layer `data-slot` to let instances supply their own
content. Detach bakes everything in and drops the link.

**Appearance.** Light and dark themes, following the system by default. Interface scale is a separate
control from browser zoom, because browser zoom scales the canvas too — and the canvas has to stay at
its true size while you design.

**Responsive.** Three columns rarely fit. Above 1024px the panels are docked; below it they become
overlay drawers so the canvas keeps the full width; below 700px the chrome condenses to icons and
secondary actions move into a menu. On touch, tap targets get a 40px floor in pixels rather than rem —
a finger does not get smaller when you pick a denser interface scale — and the canvas supports pinch
to zoom and two-finger pan.

**Import from a URL.** Fetches a page and its stylesheets and parses them into layers. This is the
thing an HTML-native model can do that a vector tool cannot — it is not a conversion, it is the same
kind of document. SSRF-guarded: private and loopback addresses are refused, redirects bounded,
responses size-capped.

**Starter design systems.** Four kits — Clean, Editorial, Brutalist, Soft — each a token set plus a
foundations sheet. Mostly so that neither you nor an agent starts from a blank canvas inventing hex
codes.

**Gradients.** A visual editor for linear, radial and conic gradients that reads whatever CSS is
already there, including gradients typed by hand or imported from a live page.

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

**Components.** A definition's nodes live in `doc.nodes` like any others, simply attached to no
page — so every existing op, style and selection mechanism works on them unchanged. An instance
carries overrides keyed by *definition node id*, which survives the definition being restructured.
One `expandInstance` function resolves instances, slots and overrides, and the canvas, HTML export
and JSX export all go through it, so what you see is what is emitted.

**Agent pairing.** Paper solves this by running MCP on localhost inside a desktop app. Canvas is
web-only, so the MCP endpoint is hosted and a connection code binds it to one document. That
constraint turns out to be an advantage: because tools run against the stored document rather than
a browser tab, fully headless agent sessions work.

**Performance.** Only artboards near the viewport hold a live iframe; the rest keep their footprint
and drop their document. Each iframe is a real layout and style engine, so without this a page of
dozens of artboards would cost hundreds of megabytes.

```
Browser tab ──WebSocket──┐
                         ├── Server (document authority, op log, SQLite)
Coding agent ──MCP/HTTP──┘         │
                                   └── Playwright (screenshots, export)
```

---

## Deployment

The app runs in two shapes from one codebase:

| | Self-hosted (Node) | Vercel |
|---|---|---|
| Storage | SQLite | Vercel Blob |
| Sync | WebSocket, instant | HTTP polling, ~1.5s |
| Presence | Yes | No |
| Agent screenshots | Yes (Playwright) | No |
| Live computed styles | Yes | Authored styles only |

Vercel's serverless runtime has no persistent filesystem and cannot hold a WebSocket open, so the
client detects the missing socket and falls back to polling, and persistence goes to Blob. Everything
else — the editor, agent read/write, components, import, export — works the same. Screenshots need a
browser the server can drive, so they are a self-hosted capability.

Blob has no transactions, so two people editing the same document on the hosted version can clobber
one another. Self-host for real collaborative work.

## Deviations from the PRD

Worth stating plainly, since the PRD is in this repo:

- **Server-authoritative ops instead of a CRDT.** [PRD §7.4](PRD.md) specifies Yjs. This
  implementation serializes ops on the server and assigns revisions; a client whose optimistic state
  diverges is handed the authoritative document. This is correct for concurrent editing and much
  simpler, but it does not merge truly simultaneous edits to the same property as gracefully as a
  CRDT would. Swapping the transport later does not change the op vocabulary.
- **Not built:** shaders, the pen tool, Figma paste, the Snapshot browser extension, live data
  binding, animation and prototyping, presentation mode, and the in-app AI assistant. These are M5+
  in the PRD and each is independently shippable.
- **Grid support is partial** — a `grid-template-columns` field, not a visual track editor.
- **Webpage import is a static snapshot.** Scripts and client-rendered content do not come across,
  and the CSS selector matcher handles simple selectors only, so complex descendant rules can
  over-apply.

## Testing

```bash
npm test
```

Frame timing has its own check, because it cannot be measured from an unfocused
browser — `requestAnimationFrame` is throttled there, and an idle page will
report multi-second "frames":

```bash
node scripts/perf-check.mjs
```

It drives a real Chromium and prints an idle baseline next to each gesture, so
the numbers validate themselves: if idle is not ~16.7ms, the run was throttled
and the rest should be ignored. On a 998-node document with three live
artboards, idle, dragging and panning all sit at 60fps.

Layout across viewports has its own check too:

```bash
node scripts/responsive-check.mjs
```

It loads the editor at seven widths from 1680px down to 360px and fails on
horizontal overflow, controls pushed off-screen, drawers that will not open, and
tap targets below 32px on a coarse pointer.

Code components cross more boundaries than anything else here — MCP, asset
storage, CORS, two levels of iframe sandbox, a postMessage handshake, React
inside React — and every one of them fails silently, leaving a component that is
missing or stuck on its defaults. So they are checked end to end, with a real
component bundled out of `scripts/fixtures/repo` by real esbuild:

```bash
node scripts/code-component-check.mjs
```

Share links are checked the same way, because what they promise is a negative — that a viewer
*cannot* write — and negatives are where UI-only enforcement quietly fails:

```bash
node scripts/share-check.mjs
```

It attempts the write over the real socket rather than through the interface that hides the button,
re-reads the document to confirm nothing moved, and asserts the document id appears nowhere in
anything a viewer receives.

The code-component check asserts the sandbox actually held (no same-origin access, scripts enabled only
on the hosting artboard), that props reach the component rather than being
replaced by its defaults, that a prop change re-renders the live instance, and
that export emits the import rather than the markup.

- `packages/shared` — model, ops and their inverses, CSS/HTML parsing, JSX and Tailwind emission,
  snapping geometry, gradient parsing, component expansion
- `packages/server/src/mcp.test.ts` — a real MCP client over real HTTP, exercising the whole tool
  surface the way an agent does, including the error paths
- `packages/server/src/fidelity.test.ts` — the export-fidelity gate: render an artboard, export it,
  re-import the export into a fresh document, render that, and pixel-diff the two

## Sharing

A document URL is an edit credential — anyone holding `/d/<id>` can change the file — so showing work
to someone used to be all-or-nothing. A share link is a separate, revocable token that opens the
document read-only and **live**: the viewer watches changes land as they happen, which is the reason
to send a link rather than a PNG.

The link must not leak the document id, or the restriction is decoration: a viewer who learned it
would open the editor instead. So every endpoint a viewer touches is addressed by token, the server
resolves the id on its side, and the document is redacted on the way out — `doc.id` becomes the token.

Read-only is enforced on the server. Hiding the toolbar stops an honest viewer from making a mess;
refusing the ops over the socket is what stops the rest. The properties panel stays visible and
readable — inspecting real values is most of why you send someone a link — inside a disabled
`fieldset`, so no control can be forgotten one at a time.

## Security

There are no accounts in this version, by design. Documents are reachable by unguessable URL, and a
connection code is the only thing between an agent and write access. So codes are short-lived before
first use, expire on inactivity, are compared in constant time, and are revocable from the UI. An
unused `owner_session` column is threaded through the document and session schemas so that adding
real ownership later does not mean migrating the realtime and MCP session layers.

Code component bundles are executed, which is a larger trust decision than anything else the tool
does. The sandbox contains what they can reach — no document, no parent page, no cookies or storage —
but it does not stop network access, so register bundles you would be willing to run in a preview.

Do not put anything sensitive in a Playground document as it stands.
