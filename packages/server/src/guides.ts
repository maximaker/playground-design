/**
 * Guided workflows returned by `get_guide`.
 *
 * These exist because the failure mode of an agent on a design canvas is not
 * "can't call the tools" — it is producing a technically valid tree that a
 * designer would never accept: absolutely-positioned soup, hardcoded colors,
 * text baked into images. Each guide is a short, opinionated brief.
 */

export const GUIDES: Record<string, string> = {
  'getting-started': `
# Working in Playground

1. Call \`get_basic_info\` first. It gives you the artboards and their sizes.
2. Call \`get_tree_summary\` on an artboard before changing anything inside it.
3. Build with \`write_html\`. It is the main creation tool — write ordinary HTML
   with inline styles or a <style> block, and it becomes editable layers.
4. Call \`get_screenshot\` after writing to see what you actually produced.
   Do not skip this: it is the only way to catch layout you did not intend.
5. Adjust with \`update_styles\` (batch) rather than rewriting the subtree.

Wrap multi-step work in \`start_working_on_nodes\` / \`finish_working_on_nodes\`
so the human sees which artboards you are touching.
`.trim(),

  layout: `
# Layout that a designer will accept

- Use flexbox. \`display: flex\` with \`flex-direction\`, \`gap\`, \`align-items\`,
  \`justify-content\` and padding covers almost every real layout.
- Do NOT position children absolutely to place them. Absolute positioning is for
  overlays, badges and decorations only. A tree full of \`position: absolute\`
  cannot be edited or made responsive, and is the single most common way agent
  output gets thrown away.
- Size with \`fit-content\` (hug), \`flex: 1\` (fill) or an explicit value. Prefer
  hug over fixed heights so text can grow.
- Use \`gap\` for spacing between siblings, not margins on children.
- Let the artboard be the viewport: a full-width section is \`width: 100%\`, not
  \`width: 1440px\`.
`.trim(),

  styling: `
# Styling

- Use tokens where they exist. Call \`get_tokens\`, then write
  \`var(--color-brand)\` instead of \`#3b82f6\`. Hardcoded values that duplicate a
  token will be flagged by the human.
- Real text, never text inside an image.
- Set \`font-family\` explicitly; call \`get_font_family_info\` first to check the
  family and weight are available, otherwise it renders in a fallback.
- Hover and focus states go in a <style> block as \`.cls:hover { ... }\` when you
  write HTML; they become node variants and survive export.
`.trim(),

  responsive: `
# Responsive work

Artboards are real viewports. A 390px artboard resolves \`@media (max-width: 768px)\`
on its own width, so responsive work here is not a preview — it is the thing.

1. \`get_breakpoints\` first. Author against those widths rather than inventing
   your own, so the design responds where the codebase does.
2. Style the base case, then add overrides with \`update_styles\` and the
   breakpoint's \`selector\`. Only put in an override what actually changes.
3. \`preview_at_width\` to check. It sets the width, lets the browser re-resolve
   the media queries, and gives you the screenshot. Do not assume a layout
   reflows correctly — look at it.

Two things reliably break at narrow widths, so check them specifically: a row
that should become a column, and a fixed width that should be a percentage or
\`fit-content\`.

To build a separate mobile artboard: \`duplicate_nodes\` the desktop one, set the
copy's width with \`preview_at_width\` or \`update_styles\`, then restyle.
Duplicating preserves structure so the two stay recognisably the same design.
`.trim(),

  'figma-import': `
# Bringing a Figma design in

Playground has no Figma API integration. The path is paste:

1. In Figma, select the frame and copy it.
2. In Canvas, paste onto the canvas. Frames become flex containers, auto-layout
   becomes flex properties, text becomes real text nodes.
3. Expect a fidelity report listing what did not convert — usually effects on
   groups, variants, and prototyping links.
4. Then call \`get_tree_summary\` and clean up: the import is usually heavier than
   it needs to be, with redundant wrapper frames worth flattening.

If the human has not pasted anything yet, say so rather than inventing content.
`.trim(),

  components: `
# Repeated elements

The moment you would build the same thing twice, make it a component.

1. \`list_components\` — it may already exist.
2. Build one well, then \`create_component\` on it. The original is replaced by an
   instance, so the canvas keeps rendering the same pixels.
3. \`insert_instance\` for the rest.

Varying by size, tone or state is a variant, not a copy:

- \`set_component_props\` declares what it varies by, e.g. size: sm | md | lg.
- \`set_variant\` says what a combination looks like. A partial match applies
  broadly — {tone: "danger"} applies at every size — and a more specific
  combination refines it rather than replacing it.
- \`set_instance_props\` switches an instance between them.

Use \`set_override\` only for a genuine one-off; if two instances need the same
change, that is a variant. \`detach_instance\` is the escape hatch when one
instance has to diverge past what overrides can express.

Put shared values in tokens so a change is one edit, not N.
`.trim(),

  export: `
# Getting the design into code

- \`get_jsx\` with \`format: "tailwind"\` is what most codebases want.
- \`format: "inline"\` gives explicit style objects — better when you need to read
  exact values or the project does not use Tailwind.
- Properties with no Tailwind utility are emitted in a \`style\` prop, so the
  output is complete either way.
- \`export\` produces PNG/JPG/SVG/HTML files.
`.trim(),
};

export function guideList(): string {
  return Object.keys(GUIDES).join(', ');
}
