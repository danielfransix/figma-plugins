# Instance Property Resetter

A Figma plugin that bulk-resets component instance overrides — so your instances stay in sync with their master components, no matter how many there are.

Built by **Daniel Fransix** · [x.com/danielfransix](https://x.com/danielfransix)

---

## The problem it solves

You're working with component instances in Figma. Over time, they drift — someone changed a fill colour here, resized a text layer there, tweaked some padding somewhere else. Now a hundred instances across your file no longer look like the master component.

Fixing these overrides one by one is painful. **Instance Property Resetter** does it all at once — and you control exactly what gets reset.

---

## What you need

- **Figma desktop app** — local plugins only work in the desktop app (Windows or Mac), not in the browser.  
  Download it free at [figma.com/downloads](https://www.figma.com/downloads/).
- The files from this repository — download or clone them to your computer.

---

## How to install

1. Open the **Figma desktop app** and open any design file (or create a new one).
2. In the top menu bar, click the **Figma logo** (the main menu) → **Plugins** → **Development** → **Import plugin from manifest…**
3. A file picker window will open. Navigate to the `instance-resetter` folder (the one containing `manifest.json`), select **`manifest.json`**, and click **Open**.
4. That's it — the plugin is now installed on your machine.

> The plugin is installed **locally only**. It won't appear for teammates or in the browser version of Figma.

To run it after installing: **Figma logo → Plugins → Development → Instance Property Resetter**

---

## How to use

1. Open the plugin from **Figma logo → Plugins → Development → Instance Property Resetter**
2. Choose a **scope** — where should the plugin look for instances?
3. Optionally enable the **width filter** to restrict which instances are processed by width
4. Tick the **properties** you want to reset
5. Click **Run Reset**
6. Watch the live progress indicator at the bottom of the plugin window — it shows the current frame name and how many instances have been processed
7. When it finishes, the status bar tells you how many instances were reset and how many layers were renamed

**Tip:** If you're working with a large file, test on a small **Selection** first. If anything looks off, a single **Ctrl+Z** (Windows) or **Cmd+Z** (Mac) undoes the entire run.

**Performance tip:** When every property is ticked, the plugin uses Figma's native `resetOverrides()` call under the hood — the fastest possible path. For partial resets, it walks the layer tree and only writes values that actually differ.

---

## Scope

This determines which part of your file the plugin scans for instances.

| Scope | What it affects |
|---|---|
| **This Page** | Every instance on the current page |
| **All Pages** | Every instance across every page in the file |
| **Selection** | Only instances inside whatever you currently have selected (including nested ones) |

---

## Width Filter

An optional filter that restricts which instances get processed based on their width.

When enabled, two inputs appear — **Min** and **Max** (in pixels). Instances narrower than Min or wider than Max are skipped entirely. Leave either field blank to leave that end of the range open.

Useful when your file mixes components of very different sizes and you only want to touch ones in a specific width bracket (for example, resetting only full-width banner instances while leaving small icon instances alone).

---

## Properties you can reset

Tick only the properties you care about. Anything left unticked stays exactly as it is.

### Instance properties

These reset visual and layout properties on every layer inside every instance.

| Property | What gets reset |
|---|---|
| **Size** | Width and height of the instance, matched to the main component |
| **Fill** | Fill colours and gradients on every layer |
| **Stroke** | Stroke colours, weights, and styles on every layer |
| **Corner Radius** | Corner rounding — handles both uniform and individual per-corner values |
| **Effects** | Drop shadows, inner shadows, layer blurs, and background blurs |
| **Opacity** | Opacity value on every layer inside the instance |
| **Clip Content** | Whether content is clipped to the layer's bounds |
| **Auto Layout** | Direction, alignment, sizing modes, wrapping, and child positioning (layoutAlign, layoutGrow, layoutPositioning) |
| **Padding** | Left, right, top, and bottom padding values |
| **Spacing** | Gap between auto-layout items and cross-axis spacing |

### Text properties

These only affect text layers found inside instances.

| Property | What gets reset |
|---|---|
| **Text Style** | Font family, weight, size, line height, letter spacing, text case, paragraph spacing, and decoration — applies by style ID if one is set on the main component, or resets each attribute individually |
| **Text Fill** | Text colour, matched to the main component |
| **Text Stroke** | Text stroke colour and weight |
| **Text Content** | The actual text characters — replaced with whatever the main component's text says |

### Layer Names

| Property | What gets reset |
|---|---|
| **Layer Name** | Renames each layer to its Figma node type (see table below) |

When **Layer Name** is ticked, two extra options appear:

| Sub-option | What it does |
|---|---|
| **Include master components** | Component and component set layers are skipped by default — they're usually named intentionally. Turn this on to rename them too. |
| **Include instances** | When on, instances are renamed to their main component's name instead of the generic "Instance" label. When off, instances are left untouched. |

**Node type → default name mapping:**

| Node type | Name assigned |
|---|---|
| Frame | Frame |
| Group | Group |
| Section | Section |
| Component | Component |
| Component Set | Component Set |
| Instance | Instance (or main component name if "Include instances" is on) |
| Text | Text |
| Rectangle | Rectangle |
| Ellipse | Ellipse |
| Polygon | Polygon |
| Star | Star |
| Line | Line |
| Vector | Vector |
| Boolean — Union | Union |
| Boolean — Subtract | Subtract |
| Boolean — Intersect | Intersect |
| Boolean — Exclude | Exclude |
| Slice | Slice |
| Connector | Connector |
| Shape with text | Shape |
| Sticky | Sticky |
| Stamp | Stamp |
| Widget | Widget |
| Embed | Embed |
| Link | Link |
| Media | Media |
| Highlight | Highlight |
| Washi Tape | Washi Tape |
| Code Block | Code Block |
| Table | Table |
| Table Cell | Cell |

---

## How it works (under the hood)

1. The plugin scans your chosen scope and collects every component instance.
2. **Fast path:** if every supported property is ticked, it calls Figma's native `instance.resetOverrides()` directly — fastest possible and perfectly accurate.
3. **Selective path:** for partial resets, it walks each instance's layer tree side-by-side with the main component's layer tree. For every matching layer pair, it only writes values that actually differ — so no unnecessary overrides get created.
4. All required text fonts are loaded automatically (in batches of 5) before any text changes are made.
5. The entire run is grouped into a single undo step — **Ctrl+Z / Cmd+Z** undoes everything in one go.

**What keeps it snappy:**

- Instances are processed one top-level frame at a time to keep memory usage bounded.
- A main-component cache (capped at 1,000 entries) prevents redundant fetching.
- Fonts are loaded in batches of 5 to avoid hitting Figma's API limits.
- The event loop is yielded periodically so Figma stays responsive during long runs.
- Deduplication ensures no instance is processed twice, even if it appears in nested selections.
- Only the current page is loaded by default; other pages are loaded on demand when "All Pages" is selected.

---

## Troubleshooting

- **"Nothing selected"** — If using the Selection scope, make sure you have at least one layer selected before running.
- **"No instances found"** — Make sure your selection or page actually contains component instances (not just regular frames or groups).
- **Instance skipped silently** — This happens when the instance's main component has been deleted, is in a disconnected library, or can't be loaded. The plugin skips these gracefully rather than throwing an error. The final status bar shows a count of skipped instances.
- **Plugin feels slow on a huge file** — It's processing thousands of layers. Use the **Selection** scope to narrow the work area, or tick all properties to use the fast path. The progress indicator will keep you updated.

---

## Files in this project

```
property-resetter-plugin-for-figma/
├── README.md                      ← This file
└── instance-resetter/
    ├── manifest.json              ← Tells Figma the plugin name and entry point
    ├── code.js                    ← Main logic — scanning, tree walking, property resetting
    └── ui.html                    ← Plugin window — scope picker, checkboxes, status bar
```

---

## Support

If this plugin saves you time, you can [buy me a coffee](https://danielfransix.short.gy/buy-coffee) — there's also a link in the plugin footer.

---

*Made with care by Daniel Fransix*
