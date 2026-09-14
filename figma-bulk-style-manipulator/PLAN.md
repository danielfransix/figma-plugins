# Figma Bulk Style Manipulator — Implementation Plan

## 1. Overview

A Figma plugin for browsing, editing, and bulk-modifying all four local style types: Text, Color (Paint), Effect, and Grid. Every property configurable in Figma's own style editor is exposed here — including hidden/expandable sections. You can drill into a single style and edit every field, or select multiple styles and patch specific properties across all of them in one action.

Visual direction mirrors Figma's own inspector UI — dark theme, Inter font, compact rows, blue accent.

---

## 2. UX Strategy

### 2.1 The fundamental tension

This plugin exposes a lot: 35+ OpenType feature tags, 7 image filter sliders, 6 effect types, beta effects, gradient stop editors, variable bindings. If all of that is visible at once, a regular designer opening the plugin to rename a style or tweak a color will feel like they opened a cockpit.

The design principle is **progressive disclosure with a fast common path**. A designer who just wants to change a color should never have to scroll past blur settings or see the word "DNOM". A design system author who needs to audit whether all body styles have `KERN` disabled should not have to fight through a simplified UI to reach that control.

The solution is three distinct "layers" of the interface, each unlocked intentionally by the user:

```
Layer 1 — Browse          (everyone lands here)
  List of styles with previews. Clean, scannable.
  Inline swatch/preview is directly clickable for quick edits.

Layer 2 — Single Edit     (click a style name to open)
  Full property editor. Basics visible by default.
  Advanced sections collapsed with a summary.

Layer 3 — Bulk Edit       (select 2+ styles, then choose)
  Intent-first: "what do you want to change?" not "here are all fields".
```

---

### 2.2 Layer 1 — Browse: the fast common path

The list is the home screen. It must feel like a native Figma panel — not a data table, not a settings page.

**Inline quick-edit swatch (the most important UX decision):**

The most common single action on a color style is changing the color. The second most common on a text style is changing the font size or weight. Instead of requiring the user to open a full edit panel for these, the style row exposes a single direct-interaction target:

```
[☐]  [●]  color/primary                    #FF5533 · 100%  [···]
          ↑
          clicking the swatch opens a mini color picker
          right here in the list — no navigation required
```

For text styles the Aa preview is not tappable (there's no single "most important" text property), so text styles require entering the edit panel. But color styles support this one-click shortcut, which covers the majority of day-to-day color style edits with zero navigation.

The mini color picker is a compact popover (240px wide): hex input, RGB inputs, opacity, and a hue/saturation square — no gradient editors, no blend modes. Those live in the full panel. The popover has a "More options →" link that opens the full edit panel if needed.

**What the list row shows and does NOT show:**

```
Regular state (no hover):
[   ]  [preview]  group/name                    meta
        ↑ 20px      ↑ full path with group muted  ↑ compact 1-line summary

Hover state:
[☐ ]  [preview]  group/name                    meta  [···]

Checkbox-selected state:
[☑ ]  [preview]  group/name                    meta  [···]
── row has a blue-tinted background ──
```

The checkbox only appears on hover or when the panel is in selection mode (at least one style already selected). This keeps the list clean for users who never use bulk edit.

**What the meta column shows per type:**

| Type | Meta example |
|---|---|
| Text | `Inter · Bold · 16px` |
| Color (solid) | `#FF5533 · 80%` |
| Color (gradient) | `Linear gradient · 3 stops` |
| Color (image) | `Image fill` |
| Effect | `Drop shadow + Layer blur` |
| Grid | `Columns · 12 · 24px gutter` |

**Remote/library styles:**

Styles from a linked library are shown with a locked icon and grey italic name. Hovering them shows a tooltip: "From [Library Name] — read only". They cannot be edited or selected for bulk edit. They can still be browsed and searched, but the swatch is not clickable.

---

### 2.3 Layer 2 — Single Edit: progressive disclosure in the panel

Opening the full edit panel is triggered by clicking the style name or anywhere on the row that isn't the checkbox or the swatch.

**The panel is divided into tiers, not a flat field list:**

```
┌─────────────────────────────────────────────┐
│ ← Back to Text styles                       │
│                                             │
│ heading/h1                            [✎]   │  ← name (click to rename)
├─────────────────────────────────────────────┤
│ ▾ BASICS                              always open
│   Family   [Inter               ] ⬡        │
│   Style    [Bold                ]           │
│   Size     [64              ] px            │
│   Line H   [Auto ○ | 72 px | %]            │
│   Tracking [0               ] %             │
├─────────────────────────────────────────────┤
│ ▸ SPACING & LAYOUT                    collapsed by default
│   (paragraph spacing, indent, list spacing) │
├─────────────────────────────────────────────┤
│ ▸ DECORATION & CASE                   collapsed by default
│   (decoration, case, leading trim,          │
│    hanging punctuation, hanging list)       │
├─────────────────────────────────────────────┤
│ ▸ OPENTYPE & DETAILS           collapsed by default
│   LIGA · KERN                               │  ← summary chips when collapsed
│   (all 35+ feature toggles, grouped)        │
├─────────────────────────────────────────────┤
│                    [Cancel]  [Save Changes] │
└─────────────────────────────────────────────┘
```

**Rules for collapsed sections:**

- Collapsed sections show a one-line summary of what's set inside them
- If nothing non-default is set: "No overrides" in muted text
- If something is set: compact chip summary — `LIGA · KERN` or `Underline · TITLE CASE`
- This means regular users see "No overrides" and move on; power users see the summary and know what's been configured without opening

**The OpenType section specifically:**

This is the most dense part of the plugin. The section starts collapsed. When expanded, it uses its own sub-accordion — each OpenType category is its own collapsible group:

```
▾ OPENTYPE & DETAILS

  ▾ Ligatures
    Ligatures (LIGA)            [—] [✓]   ← currently on
    Rare ligatures (DLIG)       [—] [✓]
    Historical (HLIG)           [—] [✓]
    Required (RLIG)             [—] [✓]
    Contextual alt. (CALT)      [—] [✓]
    Contextual swash (CSWH)     [—] [✓]

  ▸ Numbers                    (2 active: LNUM, TNUM)
  ▸ Fractions                  (none)
  ▸ Capitals & Case            (none)
  ▸ Alternate Forms            (1 active: SALT)
  ▸ Horizontal Spacing         (1 active: KERN)
  ▸ More Features              (none)
  ▸ Stylistic Sets             (none)
```

Each sub-group is expanded by default if it has active features, collapsed if all are default. This means a style with only LIGA and KERN active will open with only "Ligatures" and "Horizontal Spacing" sub-groups expanded — everything else stays collapsed. A style with 12 active features will open with all relevant sub-groups expanded.

The OpenType tag codes (LIGA, KERN, etc.) are shown in muted text beside the label — always visible, not hidden — so power users can scan by code, while regular users read the plain-English label.

**Save model — explicit, not auto-save:**

Changes are applied only when Save Changes is clicked. This is intentional: these edits cascade through potentially hundreds of frames in real documents. Auto-save for something this consequential would cause accidents. The panel title gets a subtle `•` dot indicator if there are unsaved changes, to avoid surprises when navigating away.

---

### 2.4 Layer 3 — Bulk Edit: intent-first, not form-first

The conventional approach to bulk editing is a form with checkboxes next to every field: "check the ones you want to change". This fails for 30+ fields because the cognitive load of scanning everything is too high. You open it and think "where do I even start?"

Instead, the bulk panel uses an **intent-first model**: the user declares what they want to change before being shown a control.

```
┌─────────────────────────────────────────────────┐
│  ✕  8 text styles selected                      │
├─────────────────────────────────────────────────┤
│                                                 │
│  What do you want to change?                    │
│                                                 │
│  [+ Add a change ▾]                             │
│                                                 │
│  (dropdown shows grouped field names:           │
│    Font → Family, Style, Size                   │
│    Spacing → Line Height, Tracking, …           │
│    Decoration → Case, Decoration, …             │
│    OpenType → Ligatures, Kerning, …             │
│    …)                                           │
│                                                 │
├─────────────────────────────────────────────────┤
│  After adding changes:                          │
│                                                 │
│  ─────────────────────────────────────────────  │
│  ✕  Font Size           [16      ] px           │
│     Currently: 14px (5), 16px (2), 18px (1)    │
│  ─────────────────────────────────────────────  │
│  ✕  Ligatures (LIGA)    [─] [✓]                │
│     Currently: on (6), off (2)                  │
│  ─────────────────────────────────────────────  │
│  [+ Add another change]                         │
│                                                 │
│             [Cancel]   [Apply to 8 styles →]   │
└─────────────────────────────────────────────────┘
```

**Why this works better:**

- The user starts with an empty state and adds changes one at a time. There is no "wall of checkboxes" to scan.
- Each added change row shows the **current value distribution** beneath the control: "Currently: 14px (5), 16px (2), 18px (1)". This tells the user exactly what they're overriding — critical for auditing.
- Each change row has its own ✕ to remove it from the batch.
- "Add a change" grouped dropdown maps to friendly names ("Font Size") not API names — but shows the tag code for OpenType features since those users will know them.
- Power users can add 10 changes at once. Regular users add one.

**Confirmation before apply:**

Clicking "Apply to 8 styles →" opens a compact confirmation step:

```
Apply 2 changes to 8 styles?

  · Font Size → 16px  (affects 8)
  · Ligatures → On    (affects 8)

This cannot be undone with Ctrl+Z in some cases.

               [Cancel]   [Apply]
```

The warning about undo is accurate — Figma's plugin undo is limited. Giving the user this one clear moment of confirmation before a potentially document-wide change is more respectful than just doing it.

---

### 2.5 Search as primary navigation

For design systems with 100+ styles, search is how power users get around — not scrolling. The search input should be always visible, keyboard-focusable immediately, and fast.

**Behaviour:**
- The plugin opens with focus in the search input (so a power user can start typing immediately)
- Results appear as the user types (debounced 120ms)
- Matches highlight the matching characters in the name
- Arrow keys navigate results, Enter opens the focused style
- `Esc` clears search and returns to full list
- Searching across tabs: by default searches the current tab; a subtle "Search all types" option expands scope

**Search result anatomy:**

```
[preview]  group/name                            type tab
           matching characters underlined
```

For a search like "sm" that matches styles across types, an "All" tab could surface cross-type results — but this is a Phase 7 enhancement, not MVP.

---

### 2.6 Keyboard navigation map

| Key | Action |
|---|---|
| `/` or any letter (from list) | Focuses search |
| `↑` `↓` | Navigate style rows |
| `Enter` | Open selected style in edit panel |
| `Space` | Toggle checkbox on focused row |
| `Esc` | Close edit panel / clear search / deselect all |
| `Cmd/Ctrl + A` | Select all visible styles |
| `Cmd/Ctrl + Enter` | Save changes in edit panel |
| `Tab` | Move between fields in edit panel |

---

### 2.7 Density setting

Power users managing 300 styles need compact rows. Regular users benefit from breathing room. A small toggle in the plugin's settings (⚙ icon in the top right) controls row density:

- **Comfortable** — 32px rows, 12px font, default
- **Compact** — 24px rows, 11px font, increased styles visible per panel

Setting is stored in `localStorage` and persists between sessions.

---

### 2.8 Empty and edge states

| State | Treatment |
|---|---|
| No styles of this type in the file | Illustration + "No text styles yet" + "Styles appear here once created in Figma" |
| 0 search results | "No styles match '[query]'" + "Clear search" link |
| Style deleted externally while panel is open | Panel shows warning banner: "This style was deleted from the document" — Save is disabled |
| Library style (remote) | Greyed out, locked icon, "From [Library]" tooltip, no editing |
| Very large file (500+ styles) | Show count in toolbar "Showing 200 of 500 — use search to filter" — virtualised list handles rendering |
| Font not available | Font name shown in red, tooltip "This font is not installed", saving font changes blocked until font is loaded |

---

### 2.9 When to auto-update vs require Save

| Action | Model | Reason |
|---|---|---|
| Rename (from overflow menu or inline in list) | Immediate, no Save needed | Renaming is low-stakes and reversible within Figma |
| Inline color picker (mini, from list row) | Save on close of picker | The picker closing is a natural commit point |
| Full edit panel changes | Explicit Save button | Multiple fields may be mid-edit simultaneously |
| Bulk changes | Explicit Apply + confirmation step | Document-wide impact |
| Delete style | Confirm dialog "Delete '[name]'?" | Destructive — irreversible |

---

### 2.10 Summary: user journeys

**Regular designer (common tasks)**

| Task | Steps |
|---|---|
| Change a color swatch | Click swatch in list → pick color → done (2 clicks) |
| Rename a style | Hover row → ··· → Rename → type → Enter |
| Find a style | Type in search |

**Design system author (power tasks)**

| Task | Steps |
|---|---|
| Audit all text styles for active OpenType features | Browse text tab, styles list shows OT summary in meta |
| Disable KERN across all body styles | Select all body/* → Bulk → Add change → Kerning → Off → Apply |
| Update a complete shadow token | Click effect style → expand drop shadow → edit all fields → save |
| Find styles not bound to variables | Future: filter by "unbound" — Phase 7 enhancement |

---

### 2.1 Getters (all async)

```js
const textStyles   = await figma.getLocalTextStylesAsync();
const paintStyles  = await figma.getLocalPaintStylesAsync();
const effectStyles = await figma.getLocalEffectStylesAsync();
const gridStyles   = await figma.getLocalGridStylesAsync();
```

`"documentAccess": "dynamic-page"` must be set in `manifest.json` or these throw.

---

### 2.2 TextStyle — all writable properties

#### Top-level fields

| Property | Type | Notes |
|---|---|---|
| `name` | `string` | `/` = group separator |
| `description` | `string` | |
| `fontName` | `FontName` | `{ family, style }` — requires `loadFontAsync` first |
| `fontSize` | `number` | positive number |
| `lineHeight` | `LineHeight` | `{ unit: 'AUTO' }` or `{ value, unit: 'PIXELS'|'PERCENT' }` |
| `letterSpacing` | `LetterSpacing` | `{ value, unit: 'PIXELS'|'PERCENT' }` |
| `paragraphSpacing` | `number` | px between paragraphs |
| `paragraphIndent` | `number` | px first-line indent |
| `listSpacing` | `number` | px between list items |
| `textCase` | enum | `'ORIGINAL'|'UPPER'|'LOWER'|'TITLE'|'SMALL_CAPS'|'SMALL_CAPS_FORCED'` |
| `textDecoration` | enum | `'NONE'|'UNDERLINE'|'STRIKETHROUGH'` |
| `leadingTrim` | enum | `'NONE'|'CAP_HEIGHT'|'EX_HEIGHT'` |
| `hangingPunctuation` | `boolean` | |
| `hangingList` | `boolean` | |
| `openTypeFeatures` | `object` | keyed by OpenType tag — see full table below |

#### Variable-bindable fields on TextStyle

```js
style.setBoundVariable('fontFamily', variable)  // STRING variable
style.setBoundVariable('fontStyle',  variable)  // STRING variable
style.setBoundVariable('fontWeight', variable)  // FLOAT variable (e.g. wght axis 100–900)
style.setBoundVariable('fontSize',   variable)  // FLOAT variable
// Pass null to unbind: style.setBoundVariable('fontSize', null)
```

#### openTypeFeatures — complete tag reference

Write pattern (always merge, never replace wholesale):
```js
style.openTypeFeatures = Object.assign({}, style.openTypeFeatures, { LIGA: true });
```
`true` = on, `false` = off, omitted = font default.

**Ligatures**

| Tag | Figma UI Label | Description |
|---|---|---|
| `LIGA` | Ligatures | Standard ligatures (fi, fl, ff, ffi…) |
| `DLIG` | Rare ligatures | Discretionary / decorative ligatures |
| `HLIG` | Historic ligatures | Historical ligature forms |
| `RLIG` | Required ligatures | Ligatures required for correct rendering |
| `CALT` | Contextual alternates | Context-sensitive glyph substitutions |
| `CSWH` | Contextual swashes | Swashes that adapt to context |

**Swashes & Alternates**

| Tag | Figma UI Label | Description |
|---|---|---|
| `SWSH` | Swashes | Decorative flourishes |
| `SALT` | Stylistic alternates | Font-defined alternate glyph forms |
| `NALT` | Alternate annotations | Alternate annotation forms |
| `HIST` | Historical forms | Archaic/historical glyph forms |

**Capitals & Case**

| Tag | Figma UI Label | Description |
|---|---|---|
| `SMCP` | Small caps | Lowercase → small capitals |
| `C2SC` | Caps to small caps | Uppercase → small capitals |
| `PCAP` | Petite caps | Petite capitals (smaller than small caps) |
| `UNIC` | Unicase | Mixed-case single-height alphabet |
| `TITL` | Titling alternates | Letterforms optimised for large/title sizes |
| `CASE` | Case-sensitive forms | Punctuation repositioned for all-caps text |
| `CPSP` | Capital spacing | Extra letterspacing for all-caps settings |

**Number Figures — Style**

| Tag | Figma UI Label | Description |
|---|---|---|
| `LNUM` | Lining figures | Uniform-height numbers (match caps) |
| `ONUM` | Old-style figures | Varying-height numbers (with ascenders/descenders) |
| `TNUM` | Tabular figures | Fixed-width numbers (for aligning columns) |
| `PNUM` | Proportional figures | Proportionally spaced numbers |

**Number Figures — Position**

| Tag | Figma UI Label | Description |
|---|---|---|
| `SUPS` | Superscript | Raised figures (footnotes, exponents) |
| `SUBS` | Subscript | Lowered figures (chemical formulas) |
| `SINF` | Scientific inferiors | True scientific subscript figures |
| `ORDN` | Ordinals | 1st, 2nd, 3rd ordinal letterforms |

**Fractions**

| Tag | Figma UI Label | Description |
|---|---|---|
| `FRAC` | Fractions | Diagonal fractions (1/2 → ½) |
| `AFRC` | Alternative fractions | Stacked / vertical fractions |
| `NUMR` | Fraction numerators | Standalone numerator glyphs |
| `DNOM` | Fraction denominators | Standalone denominator glyphs |

**Miscellaneous**

| Tag | Figma UI Label | Description |
|---|---|---|
| `ZERO` | Slashed zero | 0 with diagonal slash |
| `MGRK` | Mathematical Greek | Mathematical Greek alternates |
| `EXPT` | Expert forms | Expert character set (dingbats etc.) |
| `TRAD` | Traditional forms | Traditional forms (vs simplified CJK) |
| `NLCK` | NLC kanji forms | NLC-compliant kanji alternates |
| `KERN` | Kerning pairs | Optical pair kerning |

**Stylistic sets**

| Tag | Figma UI Label | Description |
|---|---|---|
| `SS01` – `SS20` | Stylistic set 1–20 | Font-specific alternate glyph sets |

---

### 2.3 PaintStyle — all writable properties

`style.paints` is `ReadonlyArray<Paint>`. Pattern: clone → mutate → reassign.

```js
const newPaints = style.paints.map((p, i) => i === idx ? { ...p, opacity: 0.5 } : p);
style.paints = newPaints;
```

#### SolidPaint

```js
{
  type: 'SOLID',
  color: { r: 0–1, g: 0–1, b: 0–1 },   // RGB, no alpha here
  opacity: 0–1,                          // paint-level opacity
  blendMode: BlendMode,
  visible: boolean,
  boundVariables: { color?: VariableAlias }  // COLOR variable
}
```

Variable binding:
```js
const newPaint = figma.variables.setBoundVariableForPaint(paint, 'color', colorVar);
// returns new paint object — must reassign array
```

#### GradientPaint (LINEAR · RADIAL · ANGULAR · DIAMOND)

```js
{
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND',
  gradientTransform: [[n,n,n],[n,n,n]],  // 2×3 transform matrix
  gradientStops: [
    {
      position: 0–1,                     // position along gradient
      color: { r, g, b, a: 0–1 },       // RGBA — 'a' is per-stop opacity
      boundVariables: { color?: VariableAlias }
    }
  ],
  opacity: 0–1,
  blendMode: BlendMode,
  visible: boolean
}
```

#### ImagePaint

```js
{
  type: 'IMAGE',
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE',
  imageHash: string | null,
  imageTransform: [[n,n,n],[n,n,n]],  // CROP mode only — controls crop rect
  scalingFactor: number,               // TILE mode only — tile scale multiplier
  rotation: number,                    // degrees 0–360 (FILL/FIT/TILE)
  filters: {
    exposure:    -1 to +1,
    contrast:    -1 to +1,
    saturation:  -1 to +1,
    temperature: -1 to +1,
    tint:        -1 to +1,
    highlights:  -1 to +1,
    shadows:     -1 to +1
  },
  opacity: 0–1,
  blendMode: BlendMode,
  visible: boolean
}
```

#### VideoPaint (same shape as ImagePaint)

```js
{
  type: 'VIDEO',
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE',
  videoHash: string | null,
  // all same properties as ImagePaint (imageTransform, scalingFactor, rotation, filters, opacity, blendMode, visible)
}
```

#### PatternPaint

```js
{
  type: 'PATTERN',
  sourceNodeId: string,
  tileType: 'RECTANGULAR' | 'HORIZONTAL_HEXAGONAL' | 'VERTICAL_HEXAGONAL',
  scalingFactor: number,
  spacing: { x: number, y: number },
  horizontalAlignment: 'START' | 'CENTER' | 'END',
  opacity: 0–1,
  blendMode: BlendMode,
  visible: boolean
}
```

#### BlendMode enum (all values)

```
NORMAL · PASS_THROUGH
DARKEN · MULTIPLY · LINEAR_BURN · COLOR_BURN
LIGHTEN · SCREEN · LINEAR_DODGE · COLOR_DODGE
OVERLAY · SOFT_LIGHT · HARD_LIGHT
DIFFERENCE · EXCLUSION
HUE · SATURATION · COLOR · LUMINOSITY
```

(`PASS_THROUGH` is only valid on group/frame nodes, not on paint layers — include it in the dropdown but note it only applies in certain contexts.)

---

### 2.4 EffectStyle — all writable properties

`style.effects` is `ReadonlyArray<Effect>`. Clone-and-replace pattern.

#### DropShadowEffect

```js
{
  type: 'DROP_SHADOW',
  color: { r, g, b, a: 0–1 },   // RGBA (a = shadow opacity)
  offset: { x: number, y: number },
  radius: number,                 // blur radius ≥ 0
  spread: number,                 // positive expands, negative contracts
  visible: boolean,
  blendMode: BlendMode,
  showShadowBehindNode: boolean,  // "Show behind transparent areas"
  boundVariables: {
    color?:   VariableAlias,      // COLOR variable
    radius?:  VariableAlias,      // FLOAT variable
    spread?:  VariableAlias,      // FLOAT variable
    offsetX?: VariableAlias,      // FLOAT variable
    offsetY?: VariableAlias       // FLOAT variable
  }
}
```

#### InnerShadowEffect

```js
{
  type: 'INNER_SHADOW',
  color: { r, g, b, a: 0–1 },
  offset: { x: number, y: number },
  radius: number,
  spread: number,
  visible: boolean,
  blendMode: BlendMode,
  // no showShadowBehindNode
  boundVariables: { color?, radius?, spread?, offsetX?, offsetY? }
}
```

#### BlurEffect — Layer Blur & Background Blur

```js
{
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR',
  radius: number,
  visible: boolean,
  blurType: 'NORMAL' | 'PROGRESSIVE',
  boundVariables: { radius?: VariableAlias },

  // When blurType === 'PROGRESSIVE' only:
  startRadius: number,
  startOffset: { x: number, y: number },  // start point in normalised object space
  endOffset:   { x: number, y: number }   // end point in normalised object space
}
```

#### NoiseEffect (beta)

```js
{
  type: 'NOISE',
  visible: boolean,
  blendMode: BlendMode,
  noiseSize: number,
  noiseSizeVector?: { x: number, y: number },  // non-uniform size
  density: number,                              // 0–1
  noiseType: 'MONOTONE' | 'DUOTONE' | 'MULTITONE',
  color: { r, g, b, a: 0–1 },
  secondaryColor?: { r, g, b, a: 0–1 },        // DUOTONE only
  opacity?: number                              // MULTITONE only
}
```

#### TextureEffect (beta)

```js
{
  type: 'TEXTURE',
  visible: boolean,
  noiseSize: number,
  noiseSizeVector?: { x: number, y: number },
  radius: number,
  clipToShape: boolean
}
```

#### GlassEffect (beta)

```js
{
  type: 'GLASS',
  visible: boolean,
  lightIntensity: number,   // 0–1
  lightAngle: number,       // degrees
  refraction: number,       // 0–1
  depth: number,            // ≥ 1
  dispersion: number,       // 0–1
  radius: number            // frost/blur amount
}
```

Variable binding for effects:
```js
const newEffect = figma.variables.setBoundVariableForEffect(effect, 'radius', floatVar);
```
Bindable: `color` (COLOR var), `radius`, `spread`, `offsetX`, `offsetY` (FLOAT vars).

---

### 2.5 GridStyle — all writable properties

`style.layoutGrids` is `ReadonlyArray<LayoutGrid>`. Clone-and-replace pattern.

#### RowsColsLayoutGrid

```js
{
  pattern: 'ROWS' | 'COLUMNS',
  alignment: 'MIN' | 'MAX' | 'STRETCH' | 'CENTER',
  gutterSize: number,
  count: number,              // number of tracks; can be Infinity for auto
  sectionSize: number,        // height (rows) or width (cols) of each track
  offset: number,             // margin from frame edge
  visible: boolean,
  color: { r, g, b, a: 0–1 },
  boundVariables: {
    gutterSize?:   VariableAlias,   // FLOAT
    sectionSize?:  VariableAlias,   // FLOAT
    offset?:       VariableAlias,   // FLOAT
    count?:        VariableAlias    // FLOAT
  }
}
```

#### GridLayoutGrid

```js
{
  pattern: 'GRID',
  sectionSize: number,        // uniform cell size
  visible: boolean,
  color: { r, g, b, a: 0–1 },
  boundVariables: {
    sectionSize?: VariableAlias   // FLOAT
  }
}
```

Variable binding:
```js
const newGrid = figma.variables.setBoundVariableForLayoutGrid(grid, 'gutterSize', floatVar);
```

---

## 3. UX Design

### 3.1 Visual direction — Figma-native dark theme

Sourced directly from Figma's official UI3 UI Kit (Community) — `dark/` semantic tokens and measured component specs.

#### Color tokens

| Token | Value | Source |
|---|---|---|
| Canvas bg | `#1E1E1E` | darkest layer, beneath panels |
| Panel surface | `#2C2C2C` | `dark/bg/default/default` |
| Input bg | `#3C3C3C` | one step lighter than surface |
| Row hover | `#383838` | mid between surface and input |
| Row selected bg | `rgba(13,153,255,0.15)` | `#0D99FF` at 15% |
| Border default | `#444444` | `dark/border/default/default` |
| Border subtle | `rgba(255,255,255,0.1)` | inset highlight on dark elevation |
| Text primary | `#FFFFFF` | `dark/text/default/default` |
| Text secondary | `rgba(255,255,255,0.7)` | `dark/_text/text-secondary` |
| Text muted | `rgba(255,255,255,0.4)` | placeholder / disabled |
| Text disabled | `rgba(255,255,255,0.25)` | non-interactive labels |
| Accent blue | `#0D99FF` | `dark/_bg/bg-brand` |
| Accent hover | `#0C8CE9` | pressed/hover state of brand |
| Destructive | `#F24822` | `light/bg/measure/default` (same in dark) |
| Success | `#14AE5C` | |
| Warning | `#FFA629` | `light/orange/500` |

#### Typography scale

All text uses **Inter** only. No system font fallback — Figma plugins always have Inter available.

| Role | Size | Weight | Line-height | Letter-spacing | Figma style name |
|---|---|---|---|---|---|
| Section label | `11px` | 550 (semibold) | `16px` | `+0.005em` | `body/body.medium.strong` |
| Row text / labels | `11px` | 450 (regular) | `16px` | `+0.005em` | `body/body.medium` |
| Primary content | `13px` | 450 (regular) | `22px` | `-0.0025em` | `body/body.large` |
| Primary content strong | `13px` | 550 (semibold) | `22px` | `-0.0025em` | `body/body.large.strong` |
| Small / meta | `9px` | 450 (regular) | `14px` | `+0.005em` | `body/body.small` |
| Small strong | `9px` | 550 (semibold) | `14px` | `+0.005em` | `body/body.small.strong` |
| Panel heading | `13px` | 550 (semibold) | `22px` | `-0.0025em` | `heading/heading.small` |

> **Our font:** all rules above apply, but substitute Inter for whatever our target font is once confirmed. The weight numbers (450, 550) are variable-font axis values — use `font-weight: 450` etc.

#### Component dimensions & states (from UI3 source)

**Buttons**

| Variant | Height | Padding | Radius | BG (dark/default) | Text | Active BG |
|---|---|---|---|---|---|---|
| Primary small | `24px` | `4px 8px` | `5px` | `#0D99FF` | `#FFFFFF` | `#007BE5` |
| Primary large | `32px` | `4px 12px` | `5px` | `#0D99FF` | `#FFFFFF` | `#007BE5` |
| Secondary small | `24px` | `4px 8px` | `5px` | transparent + `rgba(0,0,0,0.1)` 1px stroke | `rgba(0,0,0,0.9)` | `#F5F5F5` |
| Secondary large | `32px` | `4px 12px` | `5px` | same | same | same |
| Destructive small | `24px` | `4px 8px` | `5px` | `#F24822` | `#FFFFFF` | `#DC3412` |
| Destructive large | `32px` | `4px 12px` | `5px` | `#F24822` | `#FFFFFF` | `#DC3412` |
| Ghost (wide) | `24px` | `4px 0` | `5px` | transparent | `rgba(0,0,0,0.9)` | `rgba(0,0,0,0.1)` |
| Disabled (any) | same | same | `5px` | `#D9D9D9` | `#FFFFFF` | — |

Focus ring for all buttons: `outline: 2px solid #0D99FF; outline-offset: -2px` with inner white ring `box-shadow: inset 0 0 0 2px #FFFFFF`.

Icon size within buttons: `16×16px`. Gap between icon and label: `4px`.

**Inputs**

| State | BG | Border | Text |
|---|---|---|---|
| Default (dark) | `#2C2C2C` | `#444444` 1px | `#FFFFFF` |
| Placeholder (dark) | `#2C2C2C` | `#444444` 1px | `rgba(255,255,255,0.4)` |
| Focus (dark) | `#2C2C2C` | `#0C8CE9` 1px | `#FFFFFF` |
| Disabled (dark) | `#2C2C2C` | `#444444` 1px | `rgba(255,255,255,0.25)` |

- Height: `32px`, padding: `0 8px`, border radius: `5px`
- Font: Inter 11px weight 450, line-height `16px`, letter-spacing `0.005em`

**Tabs** (type-selector row: Text / Color / Effect / Grid)

| State | BG | Text | Weight |
|---|---|---|---|
| Active (dark) | `#383838` | `#FFFFFF` | `550` |
| Inactive (dark) | transparent | `rgba(255,255,255,0.7)` | `450` |
| Focus | transparent | same | same | + `#0C8CE9` 1px outline |

- Tab height: `24px`, padding: `0 8px`, border radius: `5px`, gap between tabs: `4px`
- Font: Inter 11px, line-height `16px`, letter-spacing `0.005em`
- Divider below tab bar: `#444444` 1px bottom border
- Tab count badge: `#4A5878` bg, `16px` height, `0 4px` padding, `5px` radius, Inter 11px

**Segmented controls** (used for e.g. text case, decoration, line height unit)

| State | BG | Border | Text |
|---|---|---|---|
| Active (dark) | `#2C2C2C` | `#0C8CE9` 1px | `#FFFFFF` |
| Inactive (dark) | `#383838` | none | `rgba(255,255,255,0.7)` |
| Focus | same | `#0D99FF` 1px | same |
| Disabled | same | none | `rgba(255,255,255,0.25)` |

- Height: `24px`, padding: `4px 8px`, border radius: `5px`, gap: `4px`
- Font: Inter 11px weight 500, letter-spacing `0.005em`

**Checkboxes**

| State | Box BG | Box border | Checkmark |
|---|---|---|---|
| Unchecked (dark) | `#383838` | `rgba(255,255,255,0.7)` 1px | — |
| Checked (dark) | `#0D99FF` | none | `#FFFFFF` icon |
| Indeterminate | `#0D99FF` | none | `#FFFFFF` dash |
| Disabled unchecked | `rgba(255,255,255,0.1)` | `rgba(255,255,255,0.25)` 1px | — |
| Focus | any | `#0D99FF` 1px | — |

- Box: `16×16px`, border radius: `2px`
- Label gap: `8px`, font: Inter 11px weight 450, color `#FFFFFF` (disabled: `rgba(255,255,255,0.4)`)

**Other elements**

| Component | Height | Padding | Radius |
|---|---|---|---|
| Row / list item | `32px` | `0 8px` | `0` |
| Row compact | `24px` | `0 8px` | `0` |
| Chip / tag | `20px` | `2px 4px` | `2px` |
| Icon (UI actions) | `16×16px` | — | — |
| Section label row | `24px` | `8px 8px` | `0` |
| Dropdown menu | auto | `4px 0` vertical | `5px` |
| Menu item row | `32px` | `0 8px` | `0` |
| Modal / dialog | `360–400px` wide | `16px` | `8px` |
| Tooltip | auto | `4px 8px` | `5px` |
| Accordion panel | auto | `8px` inner | `5px` |
| Color swatch | `24×24px` | — | `2px` |

#### Spacing

Base unit is **4px**. Standard gaps/paddings follow the 4px grid:

`4px · 8px · 12px · 16px · 24px · 32px`

Avoid 5px, 6px, 10px, 14px — these are off-grid for Figma's UI.

#### Elevation & shadows (dark theme)

| Level | Usage | Shadow value |
|---|---|---|
| 100 | Cards, panels flush to surface | `0px 1px 3px rgba(0,0,0,0.4), 0px 0px 0.5px rgba(0,0,0,0.5), inset 0px 0px 0.5px rgba(255,255,255,0.3), inset 0px 0.5px 0px rgba(255,255,255,0.1)` |
| 200 | Floating panels, inline popups | `0px 1px 3px rgba(0,0,0,0.5), 0px 3px 8px rgba(0,0,0,0.35), inset 0px 0px 0.5px rgba(255,255,255,0.3), inset 0px 0.5px 0px rgba(255,255,255,0.08)` |
| 300 | Tooltips | `0px 1px 3px rgba(0,0,0,0.5), 0px 5px 12px rgba(0,0,0,0.35), inset 0px 0px 0.5px rgba(255,255,255,0.3), inset 0px 0.5px 0px rgba(255,255,255,0.08)` |
| 400 | Menus, dropdowns | `0px 2px 5px rgba(0,0,0,0.35), 0px 10px 16px rgba(0,0,0,0.35), inset 0px 0px 0.5px rgba(255,255,255,0.35), inset 0px 0.5px 0px rgba(255,255,255,0.08)` |
| 500 | Modals, dialogs | `0px 3px 5px rgba(0,0,0,0.35), 0px 10px 24px rgba(0,0,0,0.45), inset 0px 0px 0.5px rgba(255,255,255,0.35), inset 0px 0.5px 0px rgba(255,255,255,0.08)` |

The `inset` layers on dark shadows are critical — they simulate the inner edge highlight that gives dark surfaces their physical depth in Figma's UI. Do not omit them.

### 3.2 Plugin window

- **Width:** 480px initial, resizable 340–800px
- **Height:** Auto-resize via ResizeObserver, max 680px with internal scroll

### 3.3 Navigation states

```
LOADING
  └─► BROWSE (tab bar + style list)
        ├─► SINGLE_EDIT  (click row text/name → slides right)
        └─► BULK_EDIT    (≥2 checkboxes → panel slides up)
```

### 3.4 Browse state layout

```
┌─────────────────────────────────────────────────────┐
│  Text   Color   Effect   Grid            [search] ⚙ │  ← tab bar
├─────────────────────────────────────────────────────┤
│  ☐ Select all      24 styles    [  Filter...  ]     │  ← toolbar
├─────────────────────────────────────────────────────┤
│  ▾  heading/                                    (3) │  ← group row
│     ☐  Aa  heading/h1       Inter · Bold · 64px    │  ← style row
│     ☐  Aa  heading/h2       Inter · SemiBold · 48  │
│  ▸  body/                                       (6) │
│  ▸  label/                                      (4) │
│  (ungrouped)                                        │
│     ☐  Aa  display          Clash · Black · 96px   │
│     ...                                             │
└─────────────────────────────────────────────────────┘
```

### 3.5 Style row anatomy

```
[☐] [preview] [group/]name                   meta  [···]
```
- **Checkbox:** 16×16, visible on hover or when any selection exists
- **Preview:** 20×20 — Aa for text; filled swatch for solid color; gradient thumbnail for gradients; image thumbnail for image; shadow/blur icon for effects; column icon for grid
- **Group prefix:** muted color — everything before last `/`
- **Name:** last path segment, bold on hover
- **Meta:** compact summary — e.g. `Inter Bold 16px`, `#FF5533 · 80%`, `Drop shadow · 4px`, `Columns · 12`
- **`···` overflow menu:** Rename (inline edit), Duplicate, Delete

### 3.6 Group rows

Clicking the `▶/▼` chevron collapses/expands the group. State stored in `sessionStorage`. Count badge shows number of styles in group. Nested groups (multi-level paths) are supported.

### 3.7 Search

Real-time, debounced 120ms. Fuzzy: each word in the query must appear somewhere in the style name (case-insensitive). Groups with zero matches are hidden. Match characters are highlighted.

---

## 4. Single Edit Panel

Slides in from the right (CSS `translateX` transition 200ms ease-out), covering the list. Contains:

- **Back button** — ← Back to [Tab] styles
- **Name field** — full path editable, with rename warning if other styles share the group
- **Description field**
- **Type-specific form** (see §4.1–4.4)
- **Action bar** — Cancel / Save Changes (sticky at bottom)

Unsaved changes trigger a "Discard changes?" confirm if Back is clicked.

---

### 4.1 Text style form

Organised into four collapsible sections, mirroring Figma's own Basics / Details layout.

#### Section A — Font

| Control | Description |
|---|---|
| Font Family | Text input + dropdown autocomplete (data from `figma.listAvailableFontsAsync`) |
| Font Style | Dropdown filtered to styles available for selected family |
| Variable weight | If fontWeight is variable-bound: shows variable name chip + unlink icon; else hidden |
| Font Size | Number scrubber (px) |

#### Section B — Spacing & Layout

| Control | Description |
|---|---|
| Line Height | 3-way toggle (Auto / px / %) + number input |
| Letter Spacing | Number input + unit toggle (px / %) |
| Paragraph Spacing | Number scrubber (px) |
| Paragraph Indent | Number scrubber (px) |
| List Spacing | Number scrubber (px) |

#### Section C — Decoration & Case

| Property | Control |
|---|---|
| Text Decoration | Segmented icon buttons: `—` (none) · `U` (underline) · `S̶` (strikethrough) |
| Text Case | Segmented icon buttons: `—` (original) · `AG` (upper) · `ag` (lower) · `Ag` (title) · `Aɢ` (small caps) · `Aɢ*` (small caps forced) |
| Leading Trim | Segmented: None · Cap Height · Ex Height |
| Hanging Punctuation | Toggle row (— / ✓) |
| Hanging List | Toggle row (— / ✓) |

#### Section D — OpenType Features (Details)

Rendered exactly as Figma's Details tab, with subsections:

**Indentation**

| Label | Tag | Control |
|---|---|---|
| Hanging punctuation | — | Toggle row |
| Hanging lists | — | Toggle row |
| Paragraph indent | — | Number scrubber |

**Numbers — Style**
Segmented: Default (no LNUM/ONUM) · Lining `LNUM` · Old-style `ONUM`
Plus: Tabular `TNUM` toggle · Proportional `PNUM` toggle (secondary row)

**Numbers — Position**
Segmented: Normal · Superscript `SUPS` · Subscript `SUBS`
Plus: Scientific inferiors `SINF` toggle (separate row)
Plus: Ordinals `ORDN` toggle

**Fractions**
Toggle row: Diagonal fractions `FRAC`
Toggle row: Stacked fractions `AFRC`
Toggle row: Numerators `NUMR`
Toggle row: Denominators `DNOM`

**Ligatures**

| Label | Tag | Control |
|---|---|---|
| Ligatures | `LIGA` | Toggle row |
| Rare ligatures | `DLIG` | Toggle row |
| Historical ligatures | `HLIG` | Toggle row |
| Required ligatures | `RLIG` | Toggle row |
| Contextual alternates | `CALT` | Toggle row |
| Contextual swashes | `CSWH` | Toggle row |

**Alternates & Forms**

| Label | Tag | Control |
|---|---|---|
| Stylistic alternates | `SALT` | Toggle row |
| Swashes | `SWSH` | Toggle row |
| Historical forms | `HIST` | Toggle row |
| Alternate annotations | `NALT` | Toggle row |
| Expert forms | `EXPT` | Toggle row |
| Traditional forms | `TRAD` | Toggle row |
| NLC kanji | `NLCK` | Toggle row |

**Capitals & Case**

| Label | Tag | Control |
|---|---|---|
| Small caps | `SMCP` | Toggle row |
| Caps to small caps | `C2SC` | Toggle row |
| Petite caps | `PCAP` | Toggle row |
| Unicase | `UNIC` | Toggle row |
| Titling alternates | `TITL` | Toggle row |
| Case-sensitive forms | `CASE` | Toggle row |
| Capital spacing | `CPSP` | Toggle row |

**Horizontal Spacing**

| Label | Tag | Control |
|---|---|---|
| Kerning pairs | `KERN` | Toggle row |

**More Features**

| Label | Tag | Control |
|---|---|---|
| Slashed zero | `ZERO` | Toggle row |
| Mathematical Greek | `MGRK` | Toggle row |

**Stylistic Sets**

SS01 – SS20, shown as toggle rows. Hidden if all are absent from the font (detected by reading font metrics — if font doesn't respond to a set, omit it from the UI or grey it out with a tooltip).

---

### 4.2 Color style form

A stackable list of paint layers (multiple fills are supported). Each layer:

```
[≡ drag] [👁 visible] [swatch] Type   [opacity] [blend] [🗑]
```

Clicking the swatch or type label expands inline details.

**Shared controls (per layer)**
- **Visibility toggle** (eye icon)
- **Blend mode dropdown** — all 18 BlendMode values
- **Opacity** — number input 0–100% (maps to 0–1)
- **Delete layer** button
- **Drag handle** to reorder

**Solid paint controls (expanded)**
- Color swatch → opens color picker popover (see §4.5)

**Gradient paint controls (expanded)**
- Gradient type: Linear · Radial · Angular · Diamond (segmented)
- Gradient bar: visual stops editor — click to add stop, drag to reposition, click stop → color picker, delete selected stop (trash icon)
- Each stop: position input (0–100%), color swatch + picker, opacity

**Image paint controls (expanded)**
- Scale mode: Fill · Fit · Crop · Tile (segmented)
- Rotation: number input (degrees) — Fill/Fit/Tile only
- Scaling factor: number input — Tile only
- **Filters** (collapsible row "Adjustments"):
  - Exposure: slider -100 to +100 (maps to -1/+1)
  - Contrast: slider -100 to +100
  - Saturation: slider -100 to +100
  - Temperature: slider -100 to +100
  - Tint: slider -100 to +100
  - Highlights: slider -100 to +100
  - Shadows: slider -100 to +100
- Image source: read-only hash display + "Replace" button (opens file picker via `figma.createImageAsync`)

**Video paint controls (expanded)**
- Same as Image paint but for video hash
- Scale mode, rotation, filters identical

**Pattern paint controls (expanded)**
- Source node ID: read-only with "Pick from canvas" action
- Tile type: Rectangular · Horizontal hex · Vertical hex (segmented)
- Scaling factor: number input
- Spacing: X and Y number inputs
- Horizontal alignment: Start · Center · End (segmented)

**+ Add layer** button at bottom of stack, with dropdown: Solid / Gradient / Pattern

---

### 4.3 Effect style form

A stackable list of effects. Each effect row:

```
[≡ drag] [👁 visible] [icon] Effect type ▾   [🗑]
         [expanded props]
```

Clicking the row expands its properties inline.

**Drop Shadow controls (expanded)**

| Control | Description |
|---|---|
| Color swatch | Opens color picker (RGBA — alpha = shadow opacity) |
| X offset | Number scrubber (px) |
| Y offset | Number scrubber (px) |
| Blur radius | Number scrubber (px ≥ 0) |
| Spread | Number scrubber (px, negative allowed) |
| Blend mode | Dropdown |
| Behind node | Toggle row — "Show behind transparent areas" |

**Inner Shadow controls (expanded)**

Same as Drop Shadow minus "Behind node" toggle.

**Layer Blur controls (expanded)**

| Control | Description |
|---|---|
| Blur type | Segmented: Normal · Progressive |
| Blur radius | Number scrubber |
| — if Progressive — | |
| Start radius | Number scrubber |
| Start offset X | Number scrubber (normalised 0–1) |
| Start offset Y | Number scrubber |
| End offset X | Number scrubber |
| End offset Y | Number scrubber |

**Background Blur controls (expanded)**

Same as Layer Blur.

**Noise controls (expanded)**  *(beta — show with "β" badge)*

| Control | Description |
|---|---|
| Noise type | Segmented: Monotone · Duotone · Multitone |
| Color | Color swatch (RGBA) |
| Secondary color | Color swatch (RGBA) — Duotone only |
| Opacity | Number 0–100% — Multitone only |
| Noise size | Number scrubber |
| Non-uniform size | Toggle + X/Y number inputs when on |
| Density | Slider 0–100% |
| Blend mode | Dropdown |

**Texture controls (expanded)**  *(beta — show with "β" badge)*

| Control | Description |
|---|---|
| Noise size | Number scrubber |
| Non-uniform size | Toggle + X/Y number inputs |
| Radius | Number scrubber |
| Clip to shape | Toggle row |

**Glass controls (expanded)**  *(beta — show with "β" badge)*

| Control | Description |
|---|---|
| Refraction | Slider 0–100% |
| Depth | Number scrubber |
| Dispersion | Slider 0–100% |
| Light intensity | Slider 0–100% |
| Light angle | Number scrubber (degrees) |
| Radius (frost) | Number scrubber |

**+ Add effect** button at bottom, with dropdown: Drop Shadow · Inner Shadow · Layer Blur · Background Blur · Noise β · Texture β · Glass β

---

### 4.4 Grid style form

A stackable list of layout grids.

```
[≡ drag] [👁 visible] [grid icon] Pattern type ▾   [🗑]
         [expanded props]
```

**Grid (uniform) controls (expanded)**

| Control | Description |
|---|---|
| Cell size | Number scrubber (px) |
| Color swatch | RGBA color picker |

**Rows / Columns controls (expanded)**

| Control | Description |
|---|---|
| Alignment | Segmented: Stretch · Center · Min · Max |
| Count | Number scrubber (or "Auto" toggle for ∞) |
| Height / Width | Number scrubber (track size, px) |
| Gutter | Number scrubber (px) |
| Offset | Number scrubber (px from edge) |
| Color swatch | RGBA color picker |

**+ Add grid** button with dropdown: Grid · Rows · Columns

---

### 4.5 Color picker popover

Appears anchored to the triggering swatch. Contains:

- **Saturation/brightness square** — canvas-drawn HSV gradient; draggable crosshair
- **Hue slider** — horizontal rainbow strip
- **Opacity slider** — chequered background + color fade strip (shown only for RGBA contexts)
- **Input row** — toggles between: Hex (#RRGGBB / #RRGGBBAA), RGB (0–255 per channel), HSL

The picker distinguishes RGB+opacity (SolidPaint, where `color` has no alpha) from RGBA (shadow/grid colors, where `color.a` is the opacity). Rendering and output differ accordingly.

---

### 4.6 Number scrubber inputs

- Click to type raw value; Enter or blur commits; Escape reverts
- Drag left/right on label to scrub (1 unit/px, Shift×10, Alt×0.1)
- Scroll wheel to increment (same modifier multipliers)
- Displays `—` in bulk mode when values differ across selection

---

## 5. Bulk Edit Panel

Triggered when ≥2 styles of the same type are checked. Slides up from the bottom (CSS `translateY`), overlaying the lower ~60% of the panel. The style list above remains visible (scrollable).

Header: `✕  5 text styles selected`

Each editable field is a row:

```
[☐ apply] Label         (mixed)   →  [new value control]
```

- **Apply checkbox** (unchecked = skip this field)
- **Label** — property name
- **Current state pill** — "mixed" if values differ; actual value if all same
- **New value control** — same control as single edit (enabled only when apply is checked)

On **Apply to N**: collect all checked fields + new values → build one `applyChanges` message with an entry per selected style → show progress bar → toast "Applied to 5 styles" on completion.

**Bulk field availability per type:**

Text: fontFamily, fontStyle, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, listSpacing, textCase, textDecoration, leadingTrim, hangingPunctuation, hangingList, ALL openTypeFeatures tags individually

Color: first solid paint's color and opacity only; blend mode of first layer; visibility of first layer

Effect: for each unique effect type present in all selected styles — patch the first matching effect of each type; radius, spread, X, Y, visible, color of matched shadow; radius/type of matched blur

Grid: gutter, count, track size, offset, alignment for first grid; cell size for first grid-type grid

---

## 6. Data Model (UI side)

All Figma API objects are serialised to plain JS before postMessage (API references can't cross the sandbox boundary).

```js
// textStyle serialised shape
{
  id: 'S:abc...',
  type: 'TEXT',
  name: 'heading/h1',
  description: '',
  fontFamily: 'Inter',
  fontStyle: 'Bold',
  fontSize: 64,
  lineHeight: { unit: 'AUTO' },
  letterSpacing: { value: 0, unit: 'PERCENT' },
  paragraphSpacing: 0,
  paragraphIndent: 0,
  listSpacing: 0,
  textCase: 'ORIGINAL',
  textDecoration: 'NONE',
  leadingTrim: 'NONE',
  hangingPunctuation: false,
  hangingList: false,
  openTypeFeatures: {
    LIGA: true,  DLIG: false, HLIG: false, RLIG: false,
    CALT: false, CSWH: false, SWSH: false, KERN: true,
    SMCP: false, C2SC: false, PCAP: false, UNIC: false,
    TITL: false, SALT: false, NALT: false, MGRK: false,
    HIST: false, EXPT: false, TRAD: false, NLCK: false,
    CASE: false, CPSP: false, ZERO: false, ORDN: false,
    LNUM: false, ONUM: false, TNUM: false, PNUM: false,
    FRAC: false, AFRC: false, SUPS: false, SUBS: false,
    SINF: false, NUMR: false, DNOM: false,
    SS01: false, SS02: false, /* ... */ SS20: false
  },
  boundVariables: { fontFamily: null, fontStyle: null, fontWeight: null, fontSize: null }
}

// paintStyle serialised shape
{
  id: 'S:xyz...',
  type: 'PAINT',
  name: 'color/primary',
  description: '',
  paints: [
    {
      type: 'SOLID',
      color: { r: 1, g: 0.33, b: 0.2 },
      opacity: 1,
      blendMode: 'NORMAL',
      visible: true,
      boundVariables: {}
    }
  ]
}

// effectStyle serialised shape
{
  id: 'S:efg...',
  type: 'EFFECT',
  name: 'shadow/sm',
  description: '',
  effects: [
    {
      type: 'DROP_SHADOW',
      color: { r: 0, g: 0, b: 0, a: 0.15 },
      offset: { x: 0, y: 2 },
      radius: 4,
      spread: 0,
      visible: true,
      blendMode: 'NORMAL',
      showShadowBehindNode: false,
      boundVariables: {}
    }
  ]
}

// gridStyle serialised shape
{
  id: 'S:hij...',
  type: 'GRID',
  name: 'grid/lg',
  description: '',
  layoutGrids: [
    {
      pattern: 'COLUMNS',
      alignment: 'CENTER',
      gutterSize: 24,
      count: 12,
      sectionSize: 72,
      offset: 0,
      visible: true,
      color: { r: 1, g: 0, b: 0, a: 0.1 },
      boundVariables: {}
    }
  ]
}
```

---

## 7. Plugin Architecture

### 7.1 File structure

```
figma-bulk-style-manipulator/
├── manifest.json
├── code.js       (~900 lines) — plugin sandbox logic
└── ui.html       (~2500 lines) — all UI (HTML + CSS + JS)
```

No build step. Pure vanilla JS, `var` throughout.

### 7.2 Message protocol

**code.js → ui.html:**
```js
{ type: 'init', textStyles, paintStyles, effectStyles, gridStyles }
{ type: 'applyDone', count: N, errors: [] }
{ type: 'applyError', message: string }
{ type: 'availableFonts', fonts: [{ family, style }] }
```

**ui.html → code.js:**
```js
{ type: 'ready' }
{ type: 'applyChanges', changes: [{ id, styleType, patches }] }
{ type: 'deleteStyle', id, styleType }
{ type: 'getFonts' }
{ type: 'resize', width, height }
```

### 7.3 code.js — patch application

```js
async function applyChange(change) {
  var style = figma.getStyleById(change.id);
  if (!style) return;
  var p = change.patches;

  if (change.styleType === 'TEXT') {
    // Determine target font (may be changed by this patch)
    var family = p.fontFamily !== undefined ? p.fontFamily : style.fontName.family;
    var weight = p.fontStyle  !== undefined ? p.fontStyle  : style.fontName.style;
    await figma.loadFontAsync({ family: family, style: weight });

    if (p.fontFamily !== undefined || p.fontStyle !== undefined) style.fontName = { family: family, style: weight };
    if (p.fontSize          !== undefined) style.fontSize          = p.fontSize;
    if (p.lineHeight        !== undefined) style.lineHeight        = p.lineHeight;
    if (p.letterSpacing     !== undefined) style.letterSpacing     = p.letterSpacing;
    if (p.paragraphSpacing  !== undefined) style.paragraphSpacing  = p.paragraphSpacing;
    if (p.paragraphIndent   !== undefined) style.paragraphIndent   = p.paragraphIndent;
    if (p.listSpacing       !== undefined) style.listSpacing       = p.listSpacing;
    if (p.textCase          !== undefined) style.textCase          = p.textCase;
    if (p.textDecoration    !== undefined) style.textDecoration    = p.textDecoration;
    if (p.leadingTrim       !== undefined) style.leadingTrim       = p.leadingTrim;
    if (p.hangingPunctuation !== undefined) style.hangingPunctuation = p.hangingPunctuation;
    if (p.hangingList       !== undefined) style.hangingList       = p.hangingList;
    if (p.openTypeFeatures  !== undefined) {
      // Merge — only override the keys present in the patch
      style.openTypeFeatures = Object.assign({}, style.openTypeFeatures, p.openTypeFeatures);
    }
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }

  if (change.styleType === 'PAINT') {
    if (p.paints      !== undefined) style.paints      = p.paints;
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }

  if (change.styleType === 'EFFECT') {
    if (p.effects     !== undefined) style.effects     = p.effects;
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }

  if (change.styleType === 'GRID') {
    if (p.layoutGrids !== undefined) style.layoutGrids = p.layoutGrids;
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }
}
```

Bulk font loading (before iterating bulk changes):
```js
// Collect unique fonts needed across all TEXT changes in the batch
var fontSet = Object.create(null);
changes.forEach(function(c) {
  if (c.styleType !== 'TEXT') return;
  var style = figma.getStyleById(c.id);
  if (!style) return;
  var family = c.patches.fontFamily || style.fontName.family;
  var weight = c.patches.fontStyle  || style.fontName.style;
  fontSet[family + ':' + weight] = { family: family, style: weight };
});
await Promise.all(Object.values(fontSet).map(function(f) { return figma.loadFontAsync(f); }));
```

---

## 8. Manifest

```json
{
  "name": "Bulk Style Editor",
  "id": "bulk-style-editor",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "documentAccess": "dynamic-page"
}
```

---

## 9. Implementation Phases

### Phase 1 — Scaffold + Data Loading
- [ ] `manifest.json`
- [ ] `code.js`: init handler, load all 4 style arrays, serialise all fields to plain objects, postMessage `init`
- [ ] `ui.html`: base layout, tab bar, loading spinner, receive init → store state
- [ ] `code.js`: `applyChanges` stub (logs received patches)

### Phase 2 — Browse + Search
- [ ] Style list render (flat first, no virtualisation)
- [ ] Group parsing + collapsible group rows
- [ ] Style row previews per type
- [ ] Search filter (debounced, fuzzy)
- [ ] Overflow menu: rename inline, delete with confirm

### Phase 3 — Single Edit: Text
- [ ] Slide-in panel + Back button
- [ ] Section A: font family/style/size controls
- [ ] Section B: spacing controls (all 5 fields)
- [ ] Section C: decoration/case/trim/hanging toggles
- [ ] Section D: all OpenType feature toggle rows (all tags)
- [ ] Save → applyChanges → applyDone handler

### Phase 4 — Single Edit: Color
- [ ] Paint stack with drag-to-reorder
- [ ] Per-paint: visibility, blend mode, opacity
- [ ] Solid paint editor + color picker popover
- [ ] Gradient editor (stop bar, per-stop controls)
- [ ] Image paint editor (scale mode, rotation, all 7 filter sliders)
- [ ] Video paint editor
- [ ] Pattern paint editor
- [ ] Add/remove paint layers

### Phase 5 — Single Edit: Effect + Grid
- [ ] Effect stack with drag-to-reorder
- [ ] Drop shadow + inner shadow editors (all fields)
- [ ] Layer + background blur (normal + progressive mode fields)
- [ ] Noise editor (beta) with all fields
- [ ] Texture editor (beta)
- [ ] Glass editor (beta)
- [ ] Add/remove effects
- [ ] Grid stack with drag-to-reorder
- [ ] Rows/Columns editor (all fields, Auto toggle for count)
- [ ] Grid editor
- [ ] Add/remove grids

### Phase 6 — Bulk Edit
- [ ] Multi-select: checkbox, shift-click range, select all
- [ ] Bulk panel slide-up
- [ ] Mixed value detection per field
- [ ] BulkFieldRow (apply checkbox + mixed indicator + control)
- [ ] Bulk apply with progress bar + toast

### Phase 7 — Polish
- [ ] List virtualisation (for 100+ styles)
- [ ] ResizeObserver auto-height
- [ ] Font autocomplete in family input
- [ ] All transition animations (CSS only)
- [ ] Error states (font not found, invalid value, style deleted externally)
- [ ] Keyboard nav (arrows, Enter to edit, Escape to cancel)
- [ ] Toast system (success / warning / error)
- [ ] Empty states (no styles of this type)

---

## 10. Key Engineering Constraints

**No cross-boundary references:** Figma API objects cannot pass through `postMessage`. Serialise everything to plain objects before sending to UI; reconstruct on the way back in code.js.

**Font loading is not optional:** Any `fontName` mutation without a prior `loadFontAsync` call throws. In bulk operations, collect all unique `{ family, style }` pairs and `Promise.all` before the iteration loop.

**ReadonlyArray clone-and-replace:** `paints`, `effects`, `layoutGrids` — never mutate in place. Always `[...arr]`, modify, then reassign.

**RGBA vs RGB+opacity:**
- `SolidPaint.color` → `{ r, g, b }` only. Opacity is the separate `opacity` field.
- `DropShadowEffect.color`, `InnerShadowEffect.color`, grid `color` → full `{ r, g, b, a }`. The `a` channel carries the opacity for these.
- Gradient stop `color` → `{ r, g, b, a }`. The `a` is per-stop opacity.

**openTypeFeatures merge pattern:** Always `Object.assign({}, existing, patch)`. Never replace wholesale — doing so loses features the user didn't intend to reset.

**`documentAccess: dynamic-page` is required** in manifest for async style getters.

**`figma.getStyleById` works for all types** — no need to iterate the full arrays to find by id in code.js after receiving a patch.
