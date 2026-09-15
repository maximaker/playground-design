# Playground — visual system

A reference derived from three sources, then reconciled into one system. It is
written to be *used*: every section ends in the tokens or the rule that carries
the idea into the stylesheet. Where the samples disagree with what a design tool
needs, the disagreement is named and settled rather than averaged away.

---

## 1. What the samples actually say

### 1.1 The instrument panel (schedule card) — the app

The defining move is **nesting by material, not by line**. A soft grey ground
holds a near-white plate; the plate holds a white panel; the panel holds white
rows. Each step is legible from radius, elevation and a shift of one or two
percent in surface brightness. Borders appear only at the innermost level, and
then as hairlines.

Read off the sample:

- Ground `#E9E9E9`-ish, cool-neutral, carrying a faint dot grid, occasional
  diagonal hatching, and circular "fastener" marks at grid intersections. The
  page is presented as a *technical surface*, which is exactly the claim this
  tool makes about itself.
- Plate: `#F4F4F4` → white, radius ~32px, a very wide and very faint drop
  shadow (large blur, ~6% black) plus a lighter top edge that reads as a
  highlight. No border.
- Panel: white, radius ~24px, hairline `#EFEFEF`.
- Rows: white, radius ~14px, hairline, a 1px contact shadow.
- Type: neutral grotesk. Section titles are **uppercase with wide tracking** at
  small sizes; content is sentence case; secondary text drops to a mid grey
  rather than to a lighter weight.
- Controls are **pills**: a segmented control (1D / 7D / 1M) on an inset grey
  track with the selected item as a white pill with a small shadow; `+ ADD` and
  `SEE ALL SCHEDULE` as white pills with hairline and shadow.
- Colour is rationed. Everything is grey and black **except state**: a green
  checkbox, green tick-bar meters, a mint `PRIORITY` chip, one green numeral.
  Nothing decorative is coloured.
- Two motifs worth stealing outright: the **tick-bar meter** (a value drawn as
  n discrete segments rather than a smooth bar) and the **fade-and-float**
  (a long list fades out under a floating pill that opens the rest).

### 1.2 The orange campaign (resarc) — landing and forms

- A saturated orange field (`#F0451F`, lifted toward `#FF6A3D` at the top-left
  by a soft radial) carrying wide, low-contrast concentric arcs. White type.
- Display type is heavy, tight-leading, sentence case; supporting text sits at
  ~65% white.
- White cards with large radius and generous padding sit on an off-white page.
- The call to action on white is a **black pill**, not an orange one. Orange is
  the field; black is the button. On orange, the button is white.
- Identity marks are squircles: an orange rounded-square with a single white
  glyph.

### 1.3 The profile shell (MultiOn) — the dashboard

- Light grey ground, white content surface, **very** generous whitespace and
  larger type than the app chrome uses.
- A **floating vertical pill rail**: white, fully rounded, soft shadow, holding
  circular icon buttons and, at the foot, an avatar wrapped in a **ring meter**
  whose colour carries a quantity (green → orange → red as credit runs out).
- Tooltips are dark grey pills, placed to the side, appearing on hover.
- Cards are white, hairline, barely shadowed, with large internal padding and
  thin separators between rows.

---

## 2. Reconciliation

The three samples are not one style, and pretending otherwise produces mush.
They divide cleanly by *audience*:

| Surface | Voice | Colour | Density |
| --- | --- | --- | --- |
| Editor | instrument | neutral + green state | dense (13px base) |
| Dashboard | calm workspace | neutral + green meters | roomy |
| Landing, auth, invites | campaign | orange field, black CTA | expressive |

Two rules hold across all three and make them one family:

1. **Elevation, radius and surface tone express hierarchy. Lines do not.**
   A hairline is allowed at the innermost level or as a separator inside a
   surface; it is never how you tell two levels apart.
2. **Colour means something.** Green is state and telemetry. Orange is brand.
   Black is the primary action. Grey is everything else. A colour used for
   decoration devalues the same colour used for meaning.

The deliberate departure from sample 1: **padding and radius do not scale up
with the sample.** A 32px radius and 24px padding are right for one card on a
marketing shot and wrong for a properties panel a designer reads for eight
hours. The material is adopted; the scale stays at the tool's density.

The deliberate departure from all three: **dark mode is not optional.** All the
samples are light. Every token below is defined in both themes, and dark is
built as its own thing — a dark tool is not a light tool with inverted
lightness — but light becomes the default, because that is what the samples ask
for and what the canvas (white artboards) sits in most comfortably.

---

## 3. Tokens

### 3.1 Surfaces

Four levels, named by role rather than by lightness, so dark mode inverts the
*ordering* and not the meaning.

| Token | Light | Dark | Where |
| --- | --- | --- | --- |
| `--bg-sunken` | `#E4E4E6` | `#08080B` | the canvas ground, inset tracks |
| `--bg` | `#EDEDEF` | `#0E0E13` | the app ground |
| `--bg-plate` | `#F7F7F8` | `#16161D` | rails, bars, plates |
| `--bg-raised` / `--bg-panel` | `#FFFFFF` | `#1B1B23` | panels and cards on a plate |
| `--bg-input` | `#FFFFFF` | `#22222C` | fields and inset controls |

Hairlines: `--border` `#E8E8EC`, `--border-strong` `#D6D6DC`. In dark,
`#262630` / `#38384A`.

### 3.2 Elevation

Shadows are wide, soft and weak. Two-part: a broad ambient shadow plus a 1px
contact shadow, which is what makes a surface look *placed* rather than
airbrushed.

```
--shadow-sm:   0 1px 2px rgba(17,17,20,.06)
--shadow:      0 1px 2px rgba(17,17,20,.05), 0 8px 24px rgba(17,17,20,.07)
--shadow-lg:   0 1px 3px rgba(17,17,20,.06), 0 24px 56px rgba(17,17,20,.11)
--shadow-pill: 0 1px 2px rgba(17,17,20,.07), 0 2px 8px rgba(17,17,20,.05)
--shadow-inset: inset 0 1px 0 rgba(255,255,255,.7)   /* the plate highlight */
```

In dark the same structure with black at 3–4× the alpha and no white inset.

### 3.3 Radius

```
--radius-xs: 0.3rem    chips, swatches
--radius-sm: 0.45rem   rows, small controls
--radius:    0.65rem   buttons, inputs, menu items
--radius-lg: 0.95rem   panels, cards
--radius-xl: 1.4rem    plates, modals, dashboard cards
--radius-pill: 999px   segmented controls, floating rails, tags, meters
```

Rule: a child's radius is at most the parent's minus its own padding, so
corners stay concentric instead of drifting.

### 3.4 Colour with meaning

```
--accent:  #1E9E62 (light) / #35C48B (dark)   state, selection, agents, live
--accent-soft: 12% tint          chips, selected rows
--brand:   #F0451F                            landing, auth, identity only
--warning: #B4690E   --danger: #B3261E   --info: #0B6FB8
```

Selection chrome on the canvas stays the accent green; the *canvas itself*
never takes brand orange, which would compete with the user's own design.

### 3.5 Type

One family (Inter), four roles:

- **Display** — landing only. 600/700, tracking `-0.02em`, leading 1.05.
- **Title** — panel and card headings. 600, size 1rem–1.15rem.
- **Label** — section headers in the chrome: `0.68rem`, 600, `letter-spacing:
  0.08em`, uppercase, `--fg-faint`. This is the sample's most characteristic
  type move and it is what makes a dense panel scannable.
- **Body** — 0.8rem–0.9rem in chrome, 0.95rem in the dashboard.

Numerals in any meter, size field or coordinate use `font-variant-numeric:
tabular-nums`, so values stop jittering as they change.

### 3.6 Motion

```
--transition: 120ms cubic-bezier(.2,0,0,1)   /* state: hover, press, open */
--transition-slow: 220ms cubic-bezier(.2,0,0,1)  /* layout: panels, sheets */
```

Nothing animates position on the canvas except the viewport. Everything honours
`prefers-reduced-motion: reduce` by collapsing to `1ms`.

---

## 4. Component recipes

**Button.** Radius `--radius`, height `--row`, hairline border, `--bg-panel`
fill, `--shadow-pill`. Hover raises the fill, never the shadow (a button that
levitates on hover reads as a card). Press flattens to `--shadow-sm` and
translates 0.5px down. `.primary` is solid `--fg` with `--bg` text — the black
pill from the campaign sample — not the accent, which is reserved for state.

**Segmented control.** An inset track (`--bg-sunken`, radius `--radius-pill`,
2px padding); the selected item is a `--bg-panel` pill with `--shadow-pill`.
Used for the code tabs, the view switcher, and the 1D/7D/1M-style ranges.

**Panel.** `--bg-panel`, radius `--radius-lg`, hairline, `--shadow-sm`; a
`Label` header; rows separated by hairlines rather than gaps.

**Row.** `--row` tall, radius `--radius-sm`, transparent until hover
(`--bg-hover`); selected rows take `--accent-soft` with a 2px accent bar at the
leading edge rather than a full fill, so the text keeps its contrast.

**Meter.** Two forms, both from the samples: the **tick bar** (n segments,
filled ones in `--accent`, empty in `--border`) for discrete counts, and the
**ring** (conic gradient, 3px stroke) for a proportion of a whole. Colour
follows the value: accent, then `--warning` under 25%, then `--danger` under
10%.

**Tooltip.** Dark grey pill (`--fg` at 92%, `--bg` text), radius
`--radius-pill`, 150ms delay, placed outside the rail.

**Field.** `--bg-input`, hairline, radius `--radius`, focus adds
`--focus-ring` (2px `--accent` at 35%) and a `--border-strong` edge — never a
glow, and never a colour change alone.

**Floating rail (dashboard).** `--bg-panel`, `--radius-pill`, `--shadow`,
circular icon buttons, avatar with ring meter at the foot.

---

## 5. Canvas-specific rules

The canvas is not part of this system — it shows the user's design, and the
chrome must not tint it. Therefore:

- The canvas ground is `--bg-sunken` and takes no gradient, no brand colour.
- Overlay chrome (selection, hover, snap guides, measure) uses pure accent and
  1px strokes at any zoom; it never uses shadow, which would read as part of
  the design being edited.
- Artboards keep a single soft shadow and a hairline, matching the "plate"
  material, so a frame reads as a physical sheet on the ground.
