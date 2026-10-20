# Playground in the Tempo style: what changes, and why

Reference: `../tempo-bookings/STYLE-GUIDE.md`. Family precedent (all live): Studio
(`../studio-os/docs/design/TEMPO.md`), Notes (`../notes/docs/design/TEMPO.md`) and Artifactory
(`../ux-artifact-studio/docs/design/TEMPO.md`). Approved sample: `../playground-tempo-sample/`
(https://heymax-tempo-samples.vercel.app/playground/index.html).

Implementation: `packages/web/src/kit-tempo.css` (the shared kit layer, synced from `../kit/tempo/tempo.css` via kit.json),
`packages/web/src/tempo-playground.css` (Playground's own tokens and overrides, imported after it),
`packages/web/src/ui/SettingsPage.tsx` (/settings),
`packages/web/src/Home.tsx` (side nav shell), `packages/web/src/App.tsx` (editor dial removed),
`packages/web/src/ui/CommandPalette.tsx` (the dial's jobs), `packages/server/src/live.ts` (control and
answer pages, restyled in place). Kit files and `kit.json` are untouched: the layer re-maps kit tokens
with the same token and class names as the other apps (`--fog`, `--paper`, `--wash`, `--hair`,
`--action`, `--now`, `--hatch`, `.tempo-side`, `.tempo-nav`, `.tempo-bar` …) so it can later be
replaced by the shared kit file with no markup change.

## 1. The style, for a design tool

Calm control: soft white panels on a cool fog desk (`#E6E9EC`), one deep navy (`#13202E`) as the only
dark interactive surface, Inter only, page titles 34/700 −0.02em, left-aligned content, hatching for
"needs attention".

Playground differs from the other apps in one way that shapes everything: the **user's design is the
loudest thing on screen** and it carries its own colours. So the chrome must be quieter than in Studio
or Notes, and every colour the chrome keeps has to mean one thing only.

### Colour roles

| Role | Value | Where |
|---|---|---|
| Desk | fog `#E6E9EC` (dark `#0D131A`) | behind the library window and between editor panels |
| Panel | white (dark `#1E2026`) | library window, top bar, both rails, menus, dialogs |
| Canvas | pale fog `#EEF0F2` + 20px dot grid | the stage, in its own rounded panel |
| Interactive | navy `#13202E` (dark: `#DFE6EE` with navy text) | Publish, primary buttons, the active tool, switches, comment pins, focus ring, toasts |
| Wash | `#F4F5F6` | inputs, tab tracks, hover, current page row, menu highlight |
| Family / selection | blue `#3D6BFF` (soft `#E7EDFF`, text `#2848C8`) | brand dot, "Live" chips, **canvas selection** (outline, handles, size tag), selected layer row, bound token names, drop target |
| Live / agent activity | orange `#E2531E` on blush `#FBE4DC`, text rust `#9C3A16` | "Claude is editing" banner, the Live dot on Publish, open live questions |
| Attention | hatch | missing required answers on the phone, (future) agent-touched layer rows |

Blue is the one family colour that does real work here, unlike lime in Studio or orange in
Artifactory: a design tool needs a selection colour, and the family blue already was it. Keeping blue
for selection, and moving every *other* blue job (primary button, active tool, palette highlight,
active tab) to navy or wash, means blue on screen now always answers one question: *what is selected*.

Orange is reserved for things that are happening right now and not by your hand: an agent editing, a
question that is open to an audience. It never fills a button.

## 2. Library (home): dial → side nav

The kit dial (radial ring with a "Documents" panel) is replaced, in this app, by a permanent side nav
inside a 28px white window on the fog, as in Studio, Notes and Artifactory:

- **Brand**: navy tile with the blue dot, "Playground", the app switcher.
- **Library**: All documents, Unfiled — each with its live count.
- **Projects**: one row per project with its tint dot and count. Rows are **drop targets**: dragging a
  document card onto a project files it (the old sidebar's gesture, which the dial had lost; the card
  menu's "Move to" stays as the keyboard path). "New project" at the foot.
- **Make**: Blank page, Starting points, Import a bundle (what the dial ring offered).
- **You**: initials card at the foot → Settings.

The bar over the content holds the document search, the family dots, heymax search (⌘K) and the
account menu. The page header is left-aligned: 34/700 "Documents" (or the project name) over a 17px
count; "New" is the navy button. Cards are flat 1.5px hairline 18px cards; "Live" chips are blue.

Below 900px the nav is hidden and the existing "Show" select (all / unfiled / per project) does the
job; above 900px the select is hidden because it duplicates the nav. Gains: every scope and its count is
visible, standard and keyboard-friendly (`<nav>` of buttons with `aria-current`). Loss: 264px of width
(220px below 1200px).

## 3. Editor chrome

Full bleed, no window: the **top bar, left rail, canvas and right rail are four separate white rounded
panels (18px) on the fog with 10px gaps** (6px / 14px radius on phones). This is the sample's decision
and Artifactory's "the canvas is the editor" rule, adapted to a tool that needs both rails.

- **Top bar** (60px): logo, switcher, project / document name (wash on hover, navy focus ring), peers,
  Present, agent button, Share, **Publish in navy** (the one dark surface; when live it shows an orange
  live dot), overflow, panel toggles.
- **No dial in the editor.** The corner knob's jobs moved to the command palette: *All documents*
  (already there), *New blank page*, *Starting points*, *Import a bundle*. Search was already ⌘K.
- **Left rail — Pages / Layers / Components / Styles**: segmented tabs on a wash track, the active tab a
  paper pill. The inner "card in a rail" is gone: the rail *is* the panel. Section labels are 12px
  uppercase muted. The current page row is wash; the **selected layer row is blue-soft with blue text**,
  matching the canvas outline.
- **Right rail — Design / Spec / Comments / Check**: same tabs. Inputs are wash fields with no border;
  focus turns them paper with a navy ring. Segmented controls (Simple / All controls, alignment) follow
  the tab pattern.
- **Floating toolbar**: a paper capsule with the menu shadow; the **active tool is navy**, hover is wash.
- **Canvas**: pale fog with a 20px dot grid (`--canvas-dot`), inside its own rounded panel. Artboards
  render in iframes, so nothing in the layer can restyle a user's design.
- **Selection**: blue 1.5px outline, white handles with blue border, blue size tag and name tag.
- **Agent banner**: blush capsule with an orange pulse and rust text — "Claude is editing", Go there.

## 4. Menus, palette, token picker

- **Context menu / overflow / card menu**: paper, 14px radius, menu shadow, 30px rows; hover is wash
  (it used to be a solid blue bar, which competed with the selection). Delete is rust, its hover blush.
- **Command palette**: 20px sheet, 60px search row at 17px, uppercase group labels, 42px rows, the
  active row is wash with ink text.
- **Token picker**: wash field; a bound token shows its name in blue (the selected value); the menu is
  paper with a wash filter, wash highlight, the current token in blue.
- **Dialogs** (Share, Export, Connect agent, Shortcuts…): 24px radius on a 28% navy scrim; **toasts** are
  the navy capsule (errors blush/rust).

## 5. Presentation mode

The stage is deep navy-black `#0E151D`; the control bar is a paper capsule (16px radius) instead of a
smoked pill; icon buttons are muted, active (comments) is navy. All keys unchanged (←/→, F, C, Esc).

## 6. Comments

Pins are navy with a white ring (the sample's comment pins); an agent's thread is the inverse — paper
with a navy ring — so it still reads as the agent's without a new colour. Resolved pins stay grey.

## 7. Settings / agents

The Appearance popover takes the menu surface: 18px radius, uppercase group labels, segmented theme and
density, **navy switches**. Connect agent and agent links are dialogs and inherit the dialog/inputs
treatment. A full settings page with its own side nav (as in the sample) is deferred — see §12.

## 8. Live questions

- **Control page** (`/d/:id/live`, server-rendered): a white 28px window on the fog (full-bleed on
  phones), 34/700 title, hairline question cards, wash buttons, navy "Open" switch, and the open state as
  a blush pill with an orange dot — the only orange on that page.
- **Answer page** (`/q/:code`, the audience's phone): fog page, 24px white form card, wash fields, a
  navy 14px send button, choices as hairline 16px cards that turn navy when picked; a missing required
  field is **hatched** with a rust ring instead of a red box. Likes use rust.
- The **board** (`/q/:code/board`, embedded in the user's slide) is *not* restyled: it takes its look from
  the user's design (`BoardLook`), so it is user content.

## 9. Published pages

Published pages and share views of a design are the user's HTML/CSS and are not touched. Only the
read-only chrome of a share link (the editor shell with the "View only" badge) follows §3.

## 10. Dark mode

Same roles, inverted: fog `#0D131A`, panels `#1E2026`, wash `#262931`, canvas `#161A20` with a
`#2C3139` dot grid; the interactive colour flips to pale `#DFE6EE` with navy text (so "the one dark
surface" becomes "the one light surface"); blue moves to its 300 step for text (`#A9BCFF`), orange to
`#F08A5D`. The live pages follow `prefers-color-scheme` with the same values.

## 11. Accessibility

- Contrast: ink on paper 16:1; muted `#646A73` 5.2:1 on white and 4.8:1 on wash; blue text `#2848C8`
  6.6:1 on white and 5.6:1 on blue-soft; rust `#9C3A16` 6.4:1 on blush. `--fg-faint` (4.0:1) is used
  only for labels that also have a stronger cue.
- Focus: one navy 2px ring (pale in dark) on every control; the canvas selection stays blue so focus and
  selection never look the same.
- State is never colour alone: active tool and tab also change surface; Live has a dot *and* a word; a
  missing field has a ring *and* the hatch; the drop target is outlined.
- Every shortcut and interaction is unchanged; nav rows are buttons in labelled `<nav>`s with
  `aria-current`. Reduced motion is still honoured by the base stylesheet.

## 12. What stays, trade-offs, phases

**Stays**: all panels, tabs and their order; the property editors; rulers, guides, snapping; peer
cursors (in each person's own colour); the version picker; the first-run tips; the prompt-card yellow
(Notes yellow is a content colour on the canvas, not chrome); the kit topbar CSS and dial files (still
synced, the dial is just not mounted).

**Trade-offs**
- Blue keeps a working job (selection), so the family colour is more visible here than lime or orange
  in the sibling apps — deliberately, because selection needs a hue that no user design can claim.
- Four panels with gaps cost ~30px of canvas width and height versus edge-to-edge rails.
- The editor loses the dial's recent-documents list; the palette and the logo (→ library) replace it.
- Home loses 264px of width on laptops for the nav.

**Phases**
1. *Shipped*: tokens, library side nav, editor panels, canvas, selection, menus/palette/token picker,
   present bar, comments, settings popover, live control and answer pages, dark mode.
2. *Next*: a settings page with its own side nav (Appearance, Agents & links, Account); hatch on layer
   rows an agent touched in the last change set; the navy tile + blue dot as the editor logo.
3. *Done*: the shared layer comes from the kit (`kit-tempo.css`); the settings page (/settings), the
   navy tile + blue dot editor logo, and hatched layer rows for the agent's last change set have landed.
