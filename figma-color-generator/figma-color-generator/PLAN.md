# Plan: Figma Color Generator Plugin

## 1. Purpose

A Figma plugin that accepts one or more base colors (each becoming the **500 shade**),
generates a full 11-step palette (50–950) using a Tailwind-style relative lightness
algorithm, creates Figma color **variables** organized into named folders inside a
user-selected collection, and renders **visual swatch frames** on the current page —
one vertical stack per color entry.

---

## 2. File Structure

Matches the `instance-resetter` pattern — no build step, no dependencies, plain
JavaScript.

```
figma-color-generator/
├── manifest.json
├── code.js        (all plugin / Figma API logic)
└── ui.html        (UI + inline CSS + inline JS)
```

---

## 3. Color Generation Algorithm

### 3.1 Input parsing

- Accept hex strings with or without `#` prefix.
- Support both 3-digit (`#FFF`) and 6-digit (`#FFFFFF`) hex.
- Convert to RGB (0–255), then to HSL (H: 0–360, S: 0–100, L: 0–100).

### 3.2 Generating the 11 lightness values

Hue (H) and saturation (S) are held constant across all shades. Lightness is derived
using relative ratios that were reverse-engineered from the Tailwind CSS Color
Generator tool to match its output exactly:

```
room_up   = 100 − L₅₀₀       // headroom above the 500 shade
room_down = L₅₀₀              // headroom below the 500 shade

L₅₀   = L₅₀₀ + room_up   × 0.912
L₁₀₀  = L₅₀₀ + room_up   × 0.853
L₂₀₀  = L₅₀₀ + room_up   × 0.735
L₃₀₀  = L₅₀₀ + room_up   × 0.559
L₄₀₀  = L₅₀₀ + room_up   × 0.294
L₅₀₀  = L₅₀₀               (anchor — the input color)
L₆₀₀  = L₅₀₀ − room_down × 0.136
L₇₀₀  = L₅₀₀ − room_down × 0.227
L₈₀₀  = L₅₀₀ − room_down × 0.364
L₉₀₀  = L₅₀₀ − room_down × 0.470
L₉₅₀  = L₅₀₀ − room_down × 0.652
```

Verification against the screenshot (input: H=252, S=98, L=66):

| Shade | Result | Screenshot |
|-------|--------|------------|
| 50    | 97     | 97         |
| 100   | 95     | 95         |
| 200   | 91     | 91         |
| 300   | 85     | 85         |
| 400   | 76     | 76         |
| 500   | 66     | 66         |
| 600   | 57     | 57         |
| 700   | 51     | 51         |
| 800   | 42     | 42         |
| 900   | 35     | 35         |
| 950   | 23     | 23         |

All values match exactly.

Saturation is clamped to `min(S, 100)` and held constant. Lightness values are
clamped to `[0, 100]` to handle extreme inputs (very dark or very light base colors).

### 3.3 HSL → RGB conversion

Standard HSL-to-RGB formula. Output is 0–1 floats for the Figma Variables API.

---

## 4. Figma Variables Integration

### 4.1 Collection selection

On plugin open, the plugin reads all existing variable collections from the document
via `figma.variables.getLocalVariableCollections()` and sends the list to the UI.

The UI shows a **dropdown** with:
- All existing collection names
- A special **"+ Create new collection"** option at the top

If "Create new collection" is selected, a text input appears for the new collection
name (required, must be non-empty).

### 4.2 Folder structure via `/` naming

Figma's native folder convention — a `/` in a variable name creates a folder. No
special API calls are needed.

For a color entry named `"Fuchsia Blue"`, the plugin creates:

```
Fuchsia Blue/50
Fuchsia Blue/100
Fuchsia Blue/200
Fuchsia Blue/300
Fuchsia Blue/400
Fuchsia Blue/500
Fuchsia Blue/600
Fuchsia Blue/700
Fuchsia Blue/800
Fuchsia Blue/900
Fuchsia Blue/950
```

### 4.3 Duplicate folder guard

Before creating any variables, the plugin checks every existing variable in the
target collection. If a variable whose name starts with `"{folderName}/"` already
exists, the run is **aborted** and a clear error is returned to the UI:

> `"Folder 'Fuchsia Blue' already exists in this collection. Choose a different name or delete the existing folder first."`

This check runs for all entries before any variables are created, so no partial
writes occur.

### 4.4 Variable type

`COLOR`, set on the collection's **default mode** only.

---

## 5. Visual Swatch Frames

### 5.1 Layout

For each color entry, one frame is created on the current page:

| Property        | Value                                  |
|-----------------|----------------------------------------|
| Frame name      | The folder name (e.g. `"Fuchsia Blue"`) |
| Layout mode     | Vertical auto-layout                   |
| Item spacing    | 8px                                    |
| Padding         | 0                                      |
| Sizing          | Hug contents on both axes              |

### 5.2 Child rectangles

Each frame contains 11 rectangles in order from 50 (top) to 950 (bottom):

| Property     | Value                            |
|--------------|----------------------------------|
| Node name    | The shade number (`"50"`, `"100"`, …, `"950"`) |
| Width        | 100px                            |
| Height       | 100px                            |
| Fill         | Solid — the computed RGB for that shade |
| Stroke       | None                             |

No text or labels are added to the rectangles.

### 5.3 Placement

All swatch frames are placed on the current page. The first frame is at **(0, 0)**.
Subsequent frames are placed to the right of the previous one with a **40px gap**:

```
x₀ = 0
xₙ = xₙ₋₁ + 100 + 40      // 100px frame width + 40px gap
y  = 0 for all frames
```

---

## 6. UI Design

Dark theme, matching `instance-resetter`. Window size: **480 × auto** (height
adjusts as rows are added via the ResizeObserver pattern from the reference plugin).

```
┌──────────────────────────────────────────────┐
│  Color Generator                             │
├──────────────────────────────────────────────┤
│  Collection                                  │
│  [ ▾ Select or create collection           ] │
│  (if "create new" selected:)                 │
│  [ New collection name...                  ] │
├──────────────────────────────────────────────┤
│  Colors                                      │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ [■] #7655FD    Fuchsia Blue       [×]  │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ [■] #2ECC71    Emerald            [×]  │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  [+ Add color]                               │
│                                              │
│  ● Ready                                     │
│  [          Generate          ]              │
└──────────────────────────────────────────────┘
```

**Color row details:**
- Small **live color preview swatch** (16×16px square, updates as hex is typed).
- **Hex input** — `#` prefix shown, user types the rest. Turns red border on invalid
  value.
- **Folder name input** — plain text, required. Turns red border if empty on submit.
- **Remove button (×)** — hidden when only one row is present.

**"+ Add color"** appends a new empty row.

**"Generate" button** is disabled when:
- No collection is selected / new collection name is empty.
- Any row has an invalid hex value.
- Any row has an empty folder name.

**Status area** shows:
- `● Ready` (idle)
- `● Generating… (2 / 5)` (in progress)
- `● Done — 22 variables created, 2 swatch frames added.` (success)
- `● Error: <message>` (failure, red dot)

---

## 7. Plugin Communication Protocol

```
UI → Plugin:
  {
    type: 'generate',
    collectionId: string | null,    // null = create new
    collectionName: string,         // used when collectionId is null
    entries: [{ hex: string, name: string }]
  }
  { type: 'resize', height: number }

Plugin → UI (on open):
  {
    type: 'collections',
    collections: [{ id: string, name: string }]
  }

Plugin → UI (during run):
  { type: 'progress', message: string, current: number, total: number }

Plugin → UI (on completion):
  { type: 'done', variableCount: number, frameCount: number }

Plugin → UI (on error):
  { type: 'error', message: string }
```

---

## 8. Error Handling & Validation

| Scenario | Handling |
|----------|----------|
| Invalid hex format | Red border on input; Generate button blocked |
| Empty folder name | Red border on input; Generate button blocked |
| Empty collection name (new) | Red border; Generate blocked |
| Duplicate folder names within one run | Error shown before any changes: `"Duplicate folder name: 'X'. Each entry must have a unique name."` |
| Folder already exists in target collection | Error shown before any changes: `"Folder 'X' already exists in collection 'Y'. Remove it first or choose a different name."` |
| Very dark input (L < 10%) | Lighter shade L values clamped to 100; still runs |
| Very light input (L > 90%) | Darker shade L values clamped to 0; still runs |
| Figma API error during variable creation | Caught; error reported to UI; partial state may exist (noted in error message) |

Pre-flight validation checks all entries before touching the document so that either
everything succeeds or nothing is written.

---

## 9. Performance

- The Variables API is synchronous — 11 variable creations per entry takes < 1ms.
- Rectangle creation is synchronous.
- With even 20 color entries (220 variables + 220 rectangles) the run completes in
  well under a second. No yielding or progress throttling is needed.
- All document mutations land in a single undo step automatically.
- Collection list is fetched once on plugin open, not on every run.

---

## 10. Out of Scope

- Exporting palettes as CSS, JSON, or Tailwind config.
- Editing or deleting existing palettes / variables.
- Multi-mode variable support (always writes to default mode only).
- FigJam support.
- Shade labels / text nodes inside swatch frames.

---

## 11. Decisions Confirmed

| Question | Decision |
|----------|----------|
| Shade labels on rectangles? | No — rectangles are named with the shade number only |
| Existing folder conflict? | Abort with a clear error; never overwrite |
| Collection selector? | User picks from existing collections or creates a new one |
| Swatch frame placement? | First frame at (0, 0); subsequent frames spaced right by 140px |
