# Figma Arrow Manager — Agent Build Guide

A self-contained spec for rebuilding this plugin from scratch. It assumes no prior context beyond a Figma Plugin API reference — read this file top to bottom and you can reproduce `manifest.json`, `code.js`, and `ui.html` exactly.

For deeper design-history context (why the plugin works the way it does, and the dead ends that led here), see [PLAN.md](PLAN.md). For the shared visual system this plugin follows, see [`../design-system/DESIGN_SYSTEM.md`](../design-system/DESIGN_SYSTEM.md).

---

## 1. What this plugin does

Two independent jobs in one panel, both operating on native Figma **`CONNECTOR`** nodes (the arrow/line object you draw with Figma's own Connector tool):

1. **Connect elements** — take a connector the user has already pasted onto the canvas and attach its two ends to two other selected elements.
2. **Manage connectors** — bulk-toggle visibility, recolor, reweight, or randomize the colors of every connector already on the current page.

### Why "connect" isn't "create"

The Plugin API cannot create a new `CONNECTOR` node (`figma.createConnector()` is FigJam-only) **and it cannot clone an existing one either** — `node.clone()` throws `"Cloning CONNECTOR nodes is not supported in the current editor"` when called on a `CONNECTOR`, even though cloning works on every other node type. This was discovered the hard way (see PLAN.md's changelog) after an earlier design assumed cloning would work.

The workaround this plugin is built around: **native copy-paste can duplicate a connector (with its exact styling) even though the Plugin API can't.** The user does this manually:

1. Style one connector the way they want (color, weight, arrowheads) — call it the source.
2. `Ctrl+C` it once.
3. `Ctrl+V` a fresh copy for every new connection needed (Figma keeps the last copy on the clipboard, so this is repeated pasting, no re-copying).
4. Select the pasted copy **plus** the two elements to connect (3 items total) and run this plugin.

The plugin's job is narrower than "create a connector" — it's "reassign an already-existing connector's two endpoints," which **is** allowed: mutating `connectorStart` / `connectorEnd` on an existing `CONNECTOR` is unrestricted.

---

## 2. Plugin identity & manifest

| Field | Value |
|---|---|
| Display name | **Figma Arrow Manager** |
| Description | Connect pasted native connectors and manage page-wide visibility, color, and stroke weight |
| Editor type | Figma Design only (`"figma"`) |
| Document access | `"dynamic-page"` |
| Relaunch action | `"Manage arrows"` |
| Panel width | 320px, fixed |
| Panel height | Auto-fits content via a resize message from the UI, clamped to **80–900px** |

```json
{
  "name": "Figma Arrow Manager",
  "id": "figma-arrow-manager-001",
  "api": "1.0.0",
  "main": "code.js",
  "documentAccess": "dynamic-page",
  "editorType": ["figma"],
  "relaunchButtons": [
    {
      "command": "figma-arrow-manager-001",
      "name": "Manage arrows"
    }
  ],
  "ui": "ui.html"
}
```

The `relaunchButtons` entry surfaces "Manage arrows" as a relaunch action on any node, so the user can jump back into the plugin from the canvas context menu without hunting through the plugins menu. The relaunch data is registered once, document-wide, via `figma.root.setRelaunchData({ [TOOL_ID]: RELAUNCH_LABEL })` at plugin start — not per-node. (Note: `isTool` is **not** a valid manifest field for a regular plugin — Figma rejects it with "Manifest has unexpected extra property: isTool" — do not add it.)

---

## 3. File structure

Plain JS, no build step, no `package.json` — matches every other plugin in this repo (`figma-selector`, `figma-relinker`, `figma-linter`, etc.):

```
figma-arrow-manager/
├── manifest.json
├── code.js                     — plugin backend (Figma Plugin API)
├── ui.html                     — single-file UI (inline CSS + JS)
├── PLAN.md                     — design history / feasibility findings
└── agent-build-instructions.md — this file
```

---

## 4. UI: plain HTML + CSS, aliased to Figma's real theme

> **Do not build this with Figma's `fig-*` tags** (`fig-content`, `fig-group`, `fig-button`, `fig-switch`, `fig-input-color`, `fig-slider`, `fig-footer` — sometimes called "PropsKit"). An earlier build of this exact plugin tried that and shipped broken: every `fig-*` tag rendered as a bare, unstyled anonymous element in a real installed plugin (no button, no switch, no divider, no slider), even though the underlying `postMessage` wiring worked fine. Those tags only render correctly inside Figma's own AI-plugin-generation preview surface, which is not where a normally-installed plugin runs. See [`DESIGN_SYSTEM.md` Section 0](../design-system/DESIGN_SYSTEM.md#0-dead-end-confirmed--do-not-use-figmas-fig--tags) for the full account. Build every control below as plain, real HTML (`<button>`, `<input type="checkbox">` styled as a switch, `<input type="color">`, `<input type="range">`) per [`DESIGN_SYSTEM.md` Section 4](../design-system/DESIGN_SYSTEM.md#4-component-catalog) and `components.css`.

### Global setup

- Load **Plus Jakarta Sans** (weights 400, 500, 600, 700) and **JetBrains Mono** (for the log) from Google Fonts.
- Alias every color to Figma's injected `--figma-color-*` variables (see [`DESIGN_SYSTEM.md` Section 1](../design-system/DESIGN_SYSTEM.md#1-core-rule-match-figmas-real-theme-not-a-guess)) — never a fixed palette.
- Preserve the `localStorage` compatibility shim at the very top of `<head>` (before any other script) — some Figma plugin iframe sandboxes reject real `localStorage` outright.
- A native `<input type="color">` opens the browser's own color picker (there is no way to reach Figma's internal fill-picker dialog from a plugin iframe) and a native `<input type="range">` needs a sibling element to mirror its numeric value — wire that with a plain `input` event listener.

### Section-by-section structure

All copy strings below are exact.

**1. "Connect elements"**
- Helper text: *"Paste one connector, then select it with the two elements you want to connect."*
- Dynamic selection status (`.status-box`):
  - `"Nothing selected"` when selection is empty
  - Otherwise: `"[count] selected — [comma-separated layer names]"`
- Full-width primary button (`.btn-primary.full-width`, disabled by default): *"Connect selected"*
  - Enabled only when exactly 3 layers are selected: 1 `CONNECTOR` node + 2 non-connector scene nodes.

*Divider.*

**2. "Show connector arrows"**
- Two-column row: label + toggle switch (`.switch`, backed by a real `<input type="checkbox">`)
- Dynamic label: *"Toggle visibility · N connector(s)"*
- Toggling it shows/hides every connector on the current page.

**3. "Connector colors"**
- Two-column row, label *"Set all to one color"*
- `<input type="color" class="color-input">`, default `#0D99FF`.

**4. "Thickness"**
- Two-column row, label *"Weight"*
- `<input type="range" class="weight-slider" min="0.5" max="10" step="0.5" value="2">` plus a small `<span>` mirroring its numeric value on every `input` event.

*Divider.*

**5. "Activity"**
- Scrollable log (`.log-list`, `max-height: 88px`), initial content: *"No activity yet."*
- Every backend operation appends a timestamped entry (`HH:MM:SS`); error-level entries render in Figma's danger text color (`--figma-color-text-danger` via `.log-entry.error`).
- Full-width "Copy log" button (`.btn-secondary.full-width`) copies all entries as plain text, one per line, formatted `[HH:MM:SS] LEVEL: Message`.

**Footer (pinned below the scrolling content, `border-top` separated)**
- Primary button: *"Apply"* — applies the selected color + weight to all connectors.
- Secondary button: *"Randomize colors"*.
- Both stay on one row without wrapping (`.footer { display: flex; }`, `white-space: nowrap` on the secondary button).

### Auto-resize

The UI has no fixed height. On load and on every `ResizeObserver` firing on the outermost wrapper element, measure its bounding-box height and `postMessage({ type: 'resize', height })` to the backend, debounced through a short `setTimeout` so rapid layout changes (e.g. several log entries arriving in a row) coalesce into one resize call.

---

## 5. Backend behavior (`code.js`)

### Startup

```js
await figma.currentPage.loadAsync();               // required under dynamic-page access
figma.root.setRelaunchData({ [TOOL_ID]: RELAUNCH_LABEL });
figma.showUI(__html__, { width: 320, height: 520, title: 'Figma Arrow Manager', themeColors: true });
sendSelectionStatus();
sendConnectorState();
figma.on('selectionchange', () => { sendSelectionStatus(); sendConnectorState(); });
```

`themeColors: true` injects real `--figma-color-*` CSS variables tracking the user's actual light/dark theme — this is what the UI's tokens alias to. Do not hand-pick a fixed palette.

### Message contract (UI → backend)

| `type` | Payload | Action |
|---|---|---|
| `connect` | — | Run "Connect selected" |
| `toggle-visibility` | `show: boolean` | Show/hide all connectors on the page |
| `apply-style` | `color: string, weight: number` | Apply color + weight to all connectors |
| `randomize-colors` | — | Assign each connector a distinct color |
| `resize` | `height: number` | `figma.ui.resize(320, clamp(80, 900, height))` |

### Message contract (backend → UI)

| `type` | Payload | When |
|---|---|---|
| `selection-status` | `count, names[], connectorCount, otherCount, canConnect` | On load and every `selectionchange` |
| `connector-state` | `shown: boolean, count: number` | On load, every `selectionchange`, and after any operation that changes connectors |
| `log` | `level: 'info'\|'error', message: string, time: 'HH:MM:SS'` | Every time `figma.notify()` fires |

### Connect selected

1. Require the current selection to be **exactly 3 nodes**: 1 `CONNECTOR` and 2 non-connector nodes. Otherwise: notify + log *"Select exactly one pasted connector and two elements to connect."* and stop.
2. Confirm all three share the same page (walk `.parent` to the nearest `PAGE` node for each and compare) — **the Plugin API does not enforce same-page attachment itself**, so this validation is the plugin's own responsibility. If they differ: *"All selected items must be on the current page."*
3. Clear any existing text label on the connector (pasted copies can carry over the source's label): if `connector.text.characters` is non-empty, `await figma.loadFontAsync(connector.text.fontName)` (skip if `fontName === figma.mixed`) then set `characters = ''`.
4. Attach `connectorStart` to the first non-connector node and `connectorEnd` to the second, both with `{ endpointNodeId, magnet: 'AUTO' }` — **do not** try to infer which node is logically "first"; Figma's selection order is not reliable, and there's no in-plugin fix needed since the user can flip the arrowhead manually via the native stroke panel afterward.
5. **Closest-connectable-parent fallback:** if attaching to a node throws (the only real failure mode is `"Invalid endpointNodeId"` for a node nested inside a component instance's overridden subtree), climb to `node.parent` and retry. Stop and throw a clear error if you reach `PAGE`/`DOCUMENT` without success. Climbing always succeeds by the time it reaches the instance root, since an `INSTANCE` itself is always a valid endpoint.
6. On success: select the connector (`figma.currentPage.selection = [connector]`), notify + log the result — mention by name any endpoint that had to climb to a parent (e.g. `Connected. "Icon" attached to "Card 3".`).
7. On failure: notify + log the thrown error's message, as an error-level entry.
8. Refresh `selection-status` and `connector-state` afterward either way.

### Toggle visibility

- `figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] })` for every connector on the page.
- If none exist: notify *"No connectors found on this page."* (info level, not an error).
- Otherwise set `.visible` on each to the requested value, counting how many actually changed (skip nodes already at the target state). Notify: *"Showing/Hiding N connector(s) (M changed)."* — omit the "(M changed)" clause if all of them changed.
- The switch itself should read **on** when there are zero connectors on the page, or when at least one visible connector exists — i.e. it never reads as "everything is hidden" by default on an empty page.

### Apply (color + weight)

- Validate the hex color; fall back to `#0D99FF` if it doesn't match `^#[0-9a-f]{6}$`.
- Clamp weight to `[0.5, 10]`, defaulting to `2` if not finite.
- For each connector: only write `.strokes` if the current solid stroke color doesn't already match (compare RGB channels with a `< 0.001` epsilon, not exact equality — floats), and only write `.strokeWeight` if it differs. This avoids spurious document mutations/undo-stack noise when re-applying the same values.
- Notify: *"Updated N connector(s) — #HEX, Wpx."*
- If no connectors exist, same "No connectors found on this page." notice as toggle-visibility.

### Randomize colors

- Pick one random starting hue (`Math.random() * 360`).
- Space each subsequent connector's hue by the **golden angle, 137.508°**, wrapping mod 360 — this maximizes visual distinctness across an arbitrary number of connectors without clustering.
- Vary saturation across `{0.7, 0.8, 0.9}` and lightness across `{0.45, 0.50, 0.55, 0.60}` by cycling `index % 3` / `index % 4`, so adjacent connectors don't share identical saturation/lightness even if hues are close after wraparound.
- Convert HSL → RGB (Figma's `SolidPaint.color` wants 0–1 floats per channel) and set `.strokes` on each connector.
- Notify: *"Randomized colors on N connector(s)."*

### Logging

Every `figma.notify(...)` call must also emit a `{ type: 'log', level, message, time }` message to the UI with matching text — the log is a complete, copyable history of everything the toast stream showed, not a separate narrower feed. Centralize this in one `notify(message, isError)` helper that does both.

---

## 6. Error messages (exact strings)

| Condition | Message |
|---|---|
| Selection isn't exactly 1 connector + 2 other nodes when clicking Connect | "Select exactly one pasted connector and two elements to connect." |
| The 3 selected items aren't all on the current page | "All selected items must be on the current page." |
| A target node and every ancestor up to the page reject attachment | `Couldn't attach to "<name>" or any of its parents.` |
| No connectors exist on the page (toggle/apply/randomize) | "No connectors found on this page." |

---

## 7. Known API constraints (verified live against the real Plugin API)

These are load-bearing facts this plugin's design depends on — don't relitigate them without re-testing against a real installed plugin (not just an MCP-mediated call, which can have different privileges):

| Operation | Result |
|---|---|
| `figma.createConnector()` | Blocked outside FigJam |
| `connectorNode.clone()` | **Always throws**, in Design files, under any manifest config — `"Cloning CONNECTOR nodes is not supported in the current editor"` |
| Mutating `connectorStart` / `connectorEnd` on an existing connector | Unrestricted — this is the operation the whole plugin is built on |
| Attaching to a plain node nested arbitrarily deep in frames/groups (no instance involved) | Works directly, no climbing needed |
| Attaching to a `COMPONENT` `INSTANCE` node itself | Works directly |
| Attaching to any node inside an instance's overridden subtree (a child of an instance, any depth) | **Always fails** with `"Invalid endpointNodeId"` — climb to the instance root, which always works |
| Attaching to the `PAGE` node itself | "Succeeds" with no thrown error, but is visually meaningless — the plugin treats reaching this boundary as a failure case rather than trying it |
| Attaching to a node on a different page than the connector | "Succeeds" with no thrown error — the API does **not** enforce same-page; the plugin must validate this itself |

---

## 8. Verification checklist

Manual, inside real Figma (not just via an MCP tool call — see the constraints table above for why that distinction matters):

1. Style one connector, `Ctrl+C` it, `Ctrl+V` a fresh copy, select the copy + two frames → Connect → new connector attaches to both, styled like the source, auto-selected afterward, stays attached when either frame moves.
2. Select a deeply-nested non-instance node + a top-level frame → Connect → attaches directly, no climb.
3. Select a node inside a component instance + another element → Connect → toast reports the climb to the instance root.
4. Select 1, 2, or 4+ items → Connect is disabled; if somehow triggered, correct error shown.
5. Toggle visibility with 0 connectors on the page → correct "No connectors found" notice, switch still reads on.
6. Apply a color/weight twice in a row → second Apply doesn't rewrite unchanged values (check via the log, or Figma's undo history staying flat).
7. Randomize colors on 5+ connectors → all visually distinct, no two adjacent hues near-identical.
8. Copy log → clipboard contains every entry as `[HH:MM:SS] LEVEL: Message`, one per line.
9. Resize the panel by adding enough log entries → panel grows smoothly, capped at 900px, no clipped content.
10. Toggle Figma's own light/dark theme while the plugin is open → panel re-themes without a reload.
