# Interface audit — September 2026

Measured against what a product designer arrives with: Figma and Framer for the
editor's gestures, Paper and Pen for how a document-shaped tool behaves, and the
three visual references now written up in [DESIGN.md](DESIGN.md).

Findings are ordered by how much they cost the person using the tool, not by
how hard they were to fix. Every "fixed" line is covered by a check in
`scripts/ui-check.mjs` unless it says otherwise.

---

## Fixed in this pass

**1. The interface could not be traversed by keyboard.** `Tab` was captured
globally to select the next sibling, so every press was swallowed before it
reached a panel: nothing in either rail could be focused, and the focus ring
the stylesheet drew for every control was unreachable in practice. Tab now
means "next sibling" only when the canvas has a selection and focus is on the
canvas; anywhere else it traverses the interface the way the platform does.
This was the most serious thing in the audit and it was invisible to anyone
using a mouse.

**2. Selecting a component instance drew nothing on the canvas.** An instance
renders its definition, so its element carries the expanded key and not the
instance's own id; the layer tree, the spec, reveal and agents all say the
instance id and found no element. Fixed in the registry, where node-to-element
lives. (`scripts/selection-check.mjs`)

**3. Four idioms for "pick one of these".** Underlined rail tabs, a filled
segmented control, bordered client tabs and variant chips were four shapes for
one idea. All are now the segmented control from the reference: an inset track
with the selection as a raised pill.

**4. The accent colour meant two things at once.** It was both "this is the
primary action" and "this is state" — selection, agent activity, live
connections. A colour that means two things means neither. Green is now state
only, ink is the primary action, and brand orange belongs to the landing and
auth alone.

**5. No `prefers-reduced-motion` support.** Every transition and animation now
collapses to 1ms when the system asks.

**6. Focus was inconsistent.** Fields signalled focus by changing their border
colour alone — a hue change, which is the one signal a colour-blind user may
not get, and which several controls did not do at all. There is now one focus
treatment: an accent ring plus the outline that survives forced-colours mode.

**7. The layer tree was missing the gestures a tree has everywhere else.**
No right-click menu, no range selection, no rename command. Shift-click toggled
one row instead of taking the run. Now: right-click opens the same menu as the
canvas, shift takes the range, the platform modifier toggles one, Rename is in
the menu and on F2.

**8. Zoom shortcuts did not match the tools people come from.** `⇧1` and `⇧2`
now work alongside the bare digits.

**9. Nothing in the chrome expressed depth.** Rails, panels and the canvas were
one flat grey with borders between them. Rails are now a plate and panels are
cards on it, which is what says the rail is furniture and the panel is content.

**10. Icon-only controls relied on the browser's `title`.** A one-second delay,
no way to show a shortcut legibly, and a system-coloured box in the middle of
this. The toolbar and the rail tabs use the system's own tooltip pill.

**11. The dashboard and the landing had no register of their own.** Both were
the editor's chrome at a larger size. The dashboard is now roomier, on white
cards over grey, with the project rail as a floating card of pill rows; the
landing speaks in the campaign voice — orange field, heavy display type, a
black pill for the one action.

**12. ⌘+ and ⌘− zoomed the whole window, not the canvas.** The page tried to
claim them in the capture phase, which works in some browsers and not in
Chrome, where keyboard zoom never reaches the page at all. Canvas zoom is now
on unmodified `+` and `−` with `⇧0` for 100% — which is what Figma binds, for
this exact reason. The ⌘ handler stays as best-effort where it works.

**13. Keyboard zoom scaled about the canvas origin,** so whatever you were
looking at slid off while you held the key. Every zoom that is not a wheel
gesture now holds the centre of the stage.

**14. The layer tree could not be navigated by keyboard.** It is a real tree
widget now: `role="tree"` with a single roving tab stop, arrows to walk the
visible rows, right to open a group and step in, left to close one and step
out, Home/End, Enter to rename. Plain arrows nudge only on the canvas; ⌘-arrow
still reorders wherever you are, because that is about the document.

---

## Known and not fixed

Listed because an audit that only lists what was convenient to fix is not an
audit.

**The properties panel is one long scroll.** Sections collapse, but there is no
way to jump to a property by name, and no indication of which sections have
values set. Figma's inspector solves this with strict ordering and tight
grouping; ours is close but longer. Worth a pass of its own.

**No drag from the components panel onto the canvas.** Inserting works, selects
and reveals, but the gesture everyone tries first is a drag.

**No ⌥-drag to duplicate on the canvas.** ⌥ currently means measure-to, which is
also correct; the two need separating.

**`--fg-faint` on white is 3.4:1.** Fine for the incidental labels it is used
for, below AA for anything a person has to read. It should not spread further,
and a pass to move any real content off it is outstanding.

**Dark mode is refreshed, not redesigned.** All three references are light. The
dark palette has been rebuilt around the new structure and is coherent, but it
has not been designed against a reference of its own.

**Tooltips are only half migrated.** The toolbar and rail tabs use the system
pill; the rest of the interface still uses `title`. The remaining ones are on
controls that also have visible labels, which is why they were left.

**The meter primitives are specified and unused.** `.meter-ticks` and
`.ring-meter` are in the stylesheet because the reference's instrument language
depends on them, but nothing in the product currently has a real quantity to
put in one. They are deliberately not being used decoratively.
