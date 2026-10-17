# Figma in Playground

How designs get from Figma into Playground, what comes across, and what does not
yet. Written while rebuilding a 62-slide Figma deck ("How to validate your idea")
as a Playground document; every limitation below was hit on that deck.

## The three ways in

| Route | What it carries | Use it for |
| --- | --- | --- |
| **Copy (Ctrl C) in Figma, paste** | The layers: frames, auto layout, text runs, fills, strokes, radii, shadows, vectors, components, images (copied into the document) | Anything structural. This is the main route. |
| **Copy as SVG** | One vector as markup | Logos and icons you want as a single shape |
| **Copy as PNG** | Figma's own rendering | Layers Playground cannot reproduce exactly (see image adjustments) |

## How the paste works

Figma's clipboard is `fig-kiwi`: a binary scene inside two marker spans in the
`text/html` slot. `shared/src/figma.ts` reads it (kiwi schema + zstd/deflate,
decoded by walking the schema, because kiwi's own decoder uses `new Function`,
which the CSP blocks), converts it to HTML with inline CSS, and the normal paste
path (`parseHtml`) turns that into layers. The clipboard's metadata also maps
each image to a signed Figma link (valid about a week); the paste copies those
into the document through `/api/documents/:id/assets/import`, which only fetches
Figma's image hosts.

Prior art: Grida's `io-figma` package takes the same Kiwi route for `.fig` files and
clipboard data. Figma's vector-network blob has no public spec; ours was
reverse-engineered (vertices, segments with tangents, regions of loops).

## Mapping

| Figma | Playground (CSS) | Fidelity |
| --- | --- | --- |
| Auto layout (direction, gap, padding, align, wrap) | flexbox | exact |
| Hug / fill / fixed sizing | no size / `flex:1 1 0` / px | exact, except text metrics |
| Absolute position, constraints | `position:absolute` at the frame's x/y | position exact; **constraints ignored** |
| Rotation, mirroring | `transform: matrix(...)` | exact |
| Solid, linear and radial gradient fills | `background` | linear exact, radial approximate |
| Image fills: fill, fit, crop, tile | `background` with size/position | exact |
| Image adjustments (exposure, temperature, tint...) | CSS filters | **approximate**; use Copy as PNG |
| Blend modes on layers | `mix-blend-mode` | exact for the common modes |
| Strokes | `border` / `outline` | inside and centre exact; outside via outline |
| Corner radii (uniform, per corner) | `border-radius` | exact; **corner smoothing ignored** |
| Drop/inner shadow, layer blur, background blur | `box-shadow`, `filter`, `backdrop-filter` | exact |
| Text: font, size, weight, line height, letter spacing, case, decoration, alignment | CSS | exact, given the font is on Google Fonts |
| Mixed styles inside one text block | spans | exact |
| Lists (bullets, numbers) and paragraph spacing | `ul`/`ol` with margins | close |
| Outlined text (invisible fill, stroke) | `color:transparent; -webkit-text-stroke` | close |
| Vector networks | SVG paths | exact for fills; open paths stroked |
| Shared styles (colour, effect) | resolved to values | values exact; **the link to the style is lost** |
| Components and instances (with overrides) | rendered as plain layers | looks exact; **no Playground component is created** |
| Layer names | layer names | exact |

## Limitations to work on

Ordered by how much they cost on the deck.

1. **Components arrive as plain layers.** The footer component appears on all 62
   slides as 62 copies. Next: turn each Figma component used more than once into a
   Playground component (`create_component` on the first, `replace_with_instance` on
   the rest), carrying overrides.
2. **Shared colour and text styles become literal values.** Next: map Figma
   styles to document tokens (`set_tokens`) and reference them as `var(--...)`.
3. **Image adjustments are approximate in CSS.** Temperature and tint have no CSS
   filter; an SVG `feColorMatrix` gets closer. Today: Copy as PNG for those layers
   (the deck needed 14).
4. **Constraints are ignored.** Fine at the original size; resizing an artboard
   will not reflow like Figma. Next: map left/right/centre/scale constraints to
   CSS for absolute children.
5. **Corner smoothing (squircles)** is not represented.
6. **Boolean operations and masks** are not converted yet (none on the deck).
7. **Fonts must exist on Google Fonts.** A local or paid font falls back.
8. **Prototype links** (slide order, transitions) do not travel in the clipboard;
   slide order came from the canvas positions.
9. **Image links expire** about a week after the copy; paste soon after copying.

## MCP gaps found on the way

- No image upload: added `import_image` (a Figma link or base64 bytes in, a stored
  asset URL out).
- One link per document: account links already exist (Settings, Agents) and work
  on every document you can open, with `list_documents` and `documentId`
  on each tool.
- Next: a `paste_figma` tool that takes Figma clipboard HTML and does the whole
  conversion server-side, so agents need no local converter.
