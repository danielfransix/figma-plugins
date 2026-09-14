# Figma Linter — Plugin Plan

**Working title:** Figma Linter by Daniel Fransix  
**Target folder:** `C:\Github Repos\figma-plugins\figma-linter\`  
**Tech stack:** Pure vanilla JS (no build step), `var` throughout, Cal Sans + DM Sans via Google Fonts CDN, Lucide icons via unpkg CDN  
**Architecture pattern:** Single `code.js` + `ui.html`, ResizeObserver auto-height, fixed-width panel (500px)

---

## 1. Goals & Differentiators

Design-lint (https://github.com/destefanis/design-lint) is the reference plugin. It is ~4 years old, React/TypeScript, and has meaningful gaps. This plugin replicates everything it does well and extends it significantly in three directions:

1. **Variable application** — Not just flag missing styles; also detect when a raw value matches a known variable and offer one-click apply. Strokes and effects get the same variable-skip treatment as fills.
2. **Usage report** — After a scan, a dedicated Report tab shows every style and variable actively used in the scanned scope, ranked by usage count, with a per-element-type breakdown.
3. **Expanded lint rules** — Spacing/gap/padding tokens, opacity tokens, hidden layer clutter, and naming conventions are all out of scope for design-lint but in scope here.

---

## 2. Scan Architecture

### Scope selector
Two modes toggled at the top of the UI:
- **Selection** — scans `figma.currentPage.selection` (and its full subtrees)
- **Page** — scans all children of `figma.currentPage`

### Traversal
Async depth-first walk using a recursive async function with a `yieldIfNeeded()` guard (same pattern as Property Resetter — `Date.now() - lastYield > 16ms → await new Promise(r => setTimeout(r, 0))`). No React/generator needed — vanilla async/await works cleanly.

Traversal skips:
- `node.locked === true`
- `node.type === 'SLICE'`
- `node.type === 'GROUP'` for most rules (groups have no own fills/strokes)
- VECTOR and BOOLEAN_OPERATION nodes unless "Lint Vectors" toggle is on (stored in `figma.clientStorage`)

### Change detection
`figma.on('documentchange', ...)` re-triggers a debounced re-scan (300ms debounce) so errors update live as the user fixes them.

### Cancel token
Increment a `_scanToken` integer at the start of every scan. Any async operation checks `myToken !== _scanToken` before posting results, preventing stale scans from polluting the UI (same pattern as Figma Selector).

---

## 3. Lint Rules — Complete Set

### 3.1 Fill — Missing Style or Variable
- **What:** Fill present but no `fillStyleId` and no `boundVariables.fills`
- **Applies to:** FRAME, RECTANGLE, INSTANCE, COMPONENT, COMPONENT_SET, TEXT, ELLIPSE, POLYGON, STAR, VECTOR*, BOOLEAN_OPERATION*, SECTION
- **Special cases:**
  - `fills === figma.mixed` → "Mixed fills" error
  - `fill.type === 'IMAGE'` or `'VIDEO'` → skip that fill
  - Invisible fill (`fill.opacity === 0` or `fill.visible === false`) → skip
- **Fix options:**
  - If an exact-match paint style found → "Apply Style" button
  - If an exact-match color variable found → "Apply Variable" button (new)
  - If near-match style found (same color, different name) → "Apply Suggested Style" with diff
  - "Create Style" → creates a new local paint style from the current fill value

### 3.2 Stroke — Missing Style or Variable
- **What:** Stroke present but no `strokeStyleId` and no `boundVariables.strokes`
- **Applies to:** FRAME, RECTANGLE, INSTANCE, COMPONENT, TEXT, ELLIPSE, POLYGON, STAR, LINE, VECTOR*
- **Special cases:**
  - `strokeWeight === figma.mixed` → "Mixed stroke weights" error
  - Multiple strokes → "Multiple strokes" warning (not an error, just informational)
- **Fix options:**
  - Apply matching paint style or color variable (same as fill)
  - "Create Style"

### 3.3 Text — Missing Text Style
- **What:** Text node with no `textStyleId`
- **Applies to:** TEXT only
- **Special cases:**
  - `fontName === figma.mixed` OR `fontSize === figma.mixed` → "Mixed typography" — cannot lint further
- **Match criteria (all must match):** `fontFamily`, `fontStyle`, `fontSize`, `lineHeight.value`, `lineHeight.unit`, `letterSpacing.value`, `letterSpacing.unit`, `textCase`, `paragraphSpacing`, `paragraphIndent` (design-lint omits paragraphIndent — we include it)
- **Fix options:**
  - Exact match → "Apply Style"
  - Partial match (family+style+size match, spacing differs) → "Apply Suggested Style" with property diff
  - "Create Style"

### 3.4 Effects — Missing Style or Variable
- **What:** Node has effects but no `effectStyleId` and no `boundVariables` on effect properties
- **Applies to:** FRAME, RECTANGLE, INSTANCE, COMPONENT, TEXT, ELLIPSE, POLYGON, STAR, LINE, VECTOR*
- **Match criteria:** `type`, `radius`, `color` (within 0.0001 tolerance per channel), `offset.x`, `offset.y`, `spread` — all effects in order
- **Fix options:**
  - Apply matching effect style
  - "Create Style"

### 3.5 Border Radius — Off-Token Value
- **What:** `cornerRadius` or any individual corner radius is not in the approved radius token set
- **Applies to:** FRAME, RECTANGLE, INSTANCE, COMPONENT, SECTION
- **Skip:** radius === 0 (no radius = valid), radius === node.height/2 (pill = valid), `boundVariables.bottomLeftRadius` present (variable-bound = valid)
- **Allowlist:** User-configurable array, default `[0, 2, 4, 8, 16, 24, 32, 9999]`. Stored in `figma.clientStorage`.
- **Fix options:**
  - Apply matching radius variable if one exists with the target value → "Apply Variable" (new)
  - Snap to nearest allowlist value manually (no auto-fix — user chooses)

### 3.6 Spacing / Gap / Padding — Off-Token Value  *(new — not in design-lint)*
- **What:** Auto-layout nodes where padding or gap values are not in the spacing token set
- **API properties:** `node.paddingLeft`, `node.paddingRight`, `node.paddingTop`, `node.paddingBottom`, `node.itemSpacing`, `node.counterAxisSpacing`
- **Applies to:** FRAME and COMPONENT with `layoutMode !== 'NONE'`
- **Skip:** Any value that is `0` (zero spacing = valid), any value bound to a variable
- **Allowlist:** User-configurable, default `[0, 2, 4, 8, 12, 16, 24, 32, 40, 48, 64]`. Stored in `figma.clientStorage`.
- **Fix options:**
  - Apply matching spacing variable → "Apply Variable"
  - No auto-snap (user picks the intended value)

### 3.7 Opacity — Off-Token Value  *(new — not in design-lint)*
- **What:** Node `opacity` is not 1 (100%) and the value is not in the opacity token set, and is not bound to a variable
- **API properties:** `node.opacity`, `node.boundVariables.opacity`
- **Applies to:** All node types except SLICE
- **Skip:** `opacity === 1` (fully opaque = valid), `boundVariables.opacity` defined
- **Allowlist:** User-configurable, default `[0, 0.08, 0.12, 0.16, 0.24, 0.32, 0.48, 0.64, 0.80, 0.88, 1]`.
- **Fix options:**
  - Apply matching opacity variable → "Apply Variable"
  - No auto-fix

### 3.8 Hidden Layers — Clutter Warning  *(new — not in design-lint)*
- **What:** Node where `node.visible === false`. These are design clutter candidates.
- **Applies to:** All non-root nodes
- **Severity:** Warning (not error) — shown with a distinct amber color in the UI
- **Fix options:**
  - "Delete Layer" button → removes the node (with undo checkpoint)
  - "Show Layer" → sets `node.visible = true`
  - "Ignore" — suppress for this node

### 3.9 Layer Naming — Convention Violation  *(new — not in design-lint)*
- **What:** Layer name matches patterns that indicate un-renamed auto-generated names
- **Detection patterns (any match = flag):**
  - Exactly `"Rectangle"`, `"Ellipse"`, `"Polygon"`, `"Star"`, `"Vector"`, `"Line"`, `"Frame"`, `"Group"`, `"Text"`, `"Component"`, `"Boolean Operation"` (Figma's default names)
  - Matches `^(Frame|Group|Rectangle|Ellipse|Vector|Text|Line|Component)\s+\d+$` (e.g., "Frame 42")
  - Name is a single emoji character
  - Name contains `"copy"` (case-insensitive) — indicates a duplicated, un-renamed layer
- **Applies to:** All node types except instances (instances inherit their component's name legitimately)
- **Severity:** Warning
- **Fix options:** No auto-fix — select the layer, user must rename. "Select Layer" focuses it in canvas.

---

## 4. Variable Application System  *(core new capability)*

Design-lint only checks whether fills are bound to a variable to *skip* linting. This plugin goes further: it actively **matches raw values against local and library variables** and offers one-click application.

### 4.1 Variable index build
At scan start, build two lookup maps:
```
colorVarMap:   Map<"r,g,b" → Variable[]>    (for fills, strokes, effects)
numberVarMap:  Map<number  → Variable[]>    (for radius, spacing, opacity)
```

Built from:
- `figma.variables.getLocalVariables('COLOR')` for color vars
- `figma.variables.getLocalVariables('FLOAT')` for number vars
- For each variable, resolve its value for `collection.defaultModeId`
- Color: round to 3 decimal places to build the key `"${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)}"`
- Float: store the raw number as the key

### 4.2 Match & suggest flow
When a lint error is found (e.g., missing fill style):
1. Look up the fill's `{r,g,b}` in `colorVarMap`
2. If one or more variables match → attach `suggestedVariables: Variable[]` to the error object
3. UI renders "Apply Variable: `color/primary/500`" button alongside (or instead of, if no style match) the style button

### 4.3 Apply variable (code.js handler)
```js
if (msg.type === 'apply_variable') {
  var node = figma.getNodeById(msg.nodeId);
  var variable = figma.variables.getVariableById(msg.variableId);
  if (msg.property === 'fill') {
    var fills = node.fills.map(function(f) { return JSON.parse(JSON.stringify(f)); });
    fills[msg.index] = figma.variables.setBoundVariableForPaint(fills[msg.index], 'color', variable);
    node.fills = fills;
  }
  if (msg.property === 'stroke') { /* same pattern */ }
  if (msg.property === 'cornerRadius') {
    node.setBoundVariable('bottomLeftRadius', variable);
    node.setBoundVariable('bottomRightRadius', variable);
    node.setBoundVariable('topLeftRadius', variable);
    node.setBoundVariable('topRightRadius', variable);
  }
  if (msg.property === 'paddingLeft')  { node.setBoundVariable('paddingLeft', variable); }
  /* ...etc for each spacing property */
  if (msg.property === 'opacity') { node.setBoundVariable('opacity', variable); }
}
```

### 4.4 Priority order in UI (per error)
1. Apply Style (exact match — most specific)
2. Apply Variable (exact value match)
3. Apply Suggested Style (near match)
4. Create Style (no match found)

---

## 5. Report Tab  *(core new capability)*

After a scan, the **Report** tab shows a usage analytics breakdown. This is entirely new — design-lint has no equivalent.

### 5.1 What is collected during scan
For every node visited, record:
- Which paint styles are in use → `styleUsage: Map<styleId → { style, count, nodeTypes: Map<nodeType, count> }>`
- Which text styles are in use → same shape
- Which effect styles are in use → same shape
- Which color variables are in use → `varUsage: Map<varId → { variable, count, nodeTypes }>`
- Which float variables are in use (spacing, radius, opacity) → same shape

### 5.2 Report tab sections

**Section A — Styles in Use**
Grouped by style type (Paint / Text / Effect). Each row:
- Style name + collection name
- Total usage count (badge)
- Usage breakdown by node type (e.g., `FRAME ×12 · TEXT ×4 · RECTANGLE ×2`)
- "Select All" → selects all nodes using this style

**Section B — Variables in Use**
Grouped by variable collection. Each row:
- Variable name (with group path if any)
- Variable type (COLOR / FLOAT)
- Total usage count
- Breakdown by property type (e.g., `fill ×8 · stroke ×2`)
- "Select All"

**Section C — Unused Styles** *(optional, off by default)*
Scans `figma.getLocalPaintStyles()` etc. and cross-references against Section A. Any style with 0 uses in the scanned scope is listed. Toggle is a checkbox in Report settings.

**Section D — Summary Numbers**
At the top of the Report tab, a quick stats bar:
- Total nodes scanned
- Total errors found
- Total warnings found
- Unique styles in use
- Unique variables in use
- Scan duration (ms)

### 5.3 Export
A small "Export JSON" button at the bottom of the Report tab serializes the full usage map to JSON and triggers `figma.openExternal()` to download — or more practically, copies to clipboard via `navigator.clipboard.writeText(JSON.stringify(report, null, 2))`.

---

## 6. UI Design

### 6.1 Plugin dimensions
- Width: **500px** fixed  
- Height: auto-resize via ResizeObserver on `document.body`
- Min height: 380px, max height: 800px (capped in code.js resize handler)

### 6.2 Tabs
Four tabs across the top:
1. **Issues** (default) — grouped error list (design-lint's "Page" view)
2. **Layers** — tree view (design-lint's "Layers" view)
3. **Report** — usage analytics (new)
4. **Settings** — radius allowlist, spacing allowlist, opacity allowlist, "Lint Vectors" toggle, "Warn on hidden layers" toggle, "Warn on naming" toggle

### 6.3 Issues tab layout

**Top bar:**
- Scope toggle: `[ Selection ] [ Page ]`
- Scan button: `Scan` → while running: `Scanning… (420 / 1,240 nodes)` with progress bar
- Error count badge

**Filter bar (pills):**
`All` · `Fill` · `Stroke` · `Text` · `Radius` · `Spacing` · `Opacity` · `Hidden` · `Naming`

Each filter pill shows a count badge.

**Error list (grouped by type+value):**
Each group row:
- Error type icon (Lucide icon)
- Error message (e.g., "Missing fill style — #3B82F6")
- Count badge ("12 layers")
- Severity dot (red = error, amber = warning)
- Expand chevron → opens sub-list of affected layer names with per-layer fix buttons
- Group-level actions: `Select All` · `Apply Style` · `Apply Variable` · `Ignore`

**Variable suggestion badge:**
When a variable match is found, a small pill `⬡ variable/name` appears next to the value — tapping it applies the variable to all layers in the group.

### 6.4 Layers tab layout

Tree view of all scanned nodes. Each node row:
- Node type icon (Lucide)
- Layer name (truncated)
- Error/warning count badges (separate colors)
- Clicking a node → selects it in Figma and opens the slide-in Detail Panel

**Detail Panel (slide-in from right):**
- Node name + type
- List of all errors for that node
- Per-error: type icon, message, current value, fix buttons (style/variable/create)
- Prev / Next arrows to navigate between nodes that have errors

### 6.5 Settings tab layout

**Allowlist editors** (each section):
- "Border Radius Token Set" — tag input (add/remove values), reset to default
- "Spacing Token Set" — same
- "Opacity Token Set" — same

**Toggle switches:**
- Lint vector layers (default: off)
- Warn on hidden layers (default: on)
- Warn on naming violations (default: on)
- Show unused styles in Report (default: off)

Settings persisted via `figma.clientStorage.setAsync('linter-settings', settingsObject)`.

### 6.6 Visual style
Follows existing plugin palette:
- Background: `#141414`
- Surface: `#1a1a1a`
- Border: `#222`
- Text primary: `#e0e0e0`
- Text secondary: `#666`
- Error accent: `#f87171` (red)
- Warning accent: `#fb923c` (amber)
- Success: `#4ade80` (green)
- Variable accent: `#a78bfa` (purple — for variable badges)
- Brand font: Cal Sans
- Body font: DM Sans

---

## 7. Code Structure

```
figma-linter/
  code.js          ← plugin main (Figma API side)
  ui.html          ← full UI (vanilla JS, no build)
  manifest.json
  PLAN.md          ← this document
```

### 7.1 code.js structure

```
// ── Init ──────────────────────────────────────────────────────────────────
figma.showUI(__html__, { width: 500, height: 580, title: 'Figma Linter', themeColors: true });

// ── Helpers ───────────────────────────────────────────────────────────────
function yieldIfNeeded() { ... }                 // async yield guard
function buildVariableIndex() { ... }            // returns { colorVarMap, numberVarMap }
function getLocalStyles() { ... }               // returns { paints, texts, effects }

// ── Traversal ─────────────────────────────────────────────────────────────
async function scanNode(node, config, maps, token) { ... }   // visits one node
async function walkTree(rootNodes, config, maps, token) { ... }  // DFS walk

// ── Lint rules ────────────────────────────────────────────────────────────
function lintFill(node, maps) { ... }            // returns error[] or []
function lintStroke(node, maps) { ... }
function lintText(node, maps) { ... }
function lintEffects(node, maps) { ... }
function lintRadius(node, config, maps) { ... }
function lintSpacing(node, config, maps) { ... }
function lintOpacity(node, config, maps) { ... }
function lintVisibility(node) { ... }
function lintNaming(node) { ... }

// ── Style matchers ────────────────────────────────────────────────────────
function findMatchingPaintStyle(fill, styles) { ... }
function findMatchingTextStyle(node, styles) { ... }
function findMatchingEffectStyle(node, styles) { ... }
function colorToKey(r, g, b) { ... }

// ── Report builder ────────────────────────────────────────────────────────
function buildReport(results) { ... }            // aggregates usage stats

// ── Message handler ───────────────────────────────────────────────────────
figma.ui.onmessage = async function(msg) {
  // scan, apply_style, apply_variable, create_style, select_node,
  // select_nodes, delete_node, show_node, load_settings, save_settings,
  // resize, open_url, close_plugin
};

// ── Document change listener ──────────────────────────────────────────────
var _rerunDebounce = null;
figma.on('documentchange', function() {
  clearTimeout(_rerunDebounce);
  _rerunDebounce = setTimeout(function() {
    figma.ui.postMessage({ type: 'document_changed' });
  }, 300);
});
```

### 7.2 ui.html structure

```
<head>
  <!-- Cal Sans, DM Sans, Lucide via CDN -->
  <style> ... </style>
</head>
<body>
  <!-- Header: plugin name + scope toggle + scan button -->
  <header>...</header>

  <!-- Tabs: Issues / Layers / Report / Settings -->
  <nav class="tabs">...</nav>

  <!-- Tab panels -->
  <div id="tab-issues">
    <div id="filter-bar">...</div>
    <div id="progress-bar">...</div>
    <div id="error-list">...</div>
  </div>
  <div id="tab-layers" hidden>...</div>
  <div id="tab-report" hidden>...</div>
  <div id="tab-settings" hidden>...</div>

  <!-- Detail panel (slide-in overlay) -->
  <div id="detail-panel" class="panel">...</div>

  <!-- Footer: brand + links -->
  <footer>...</footer>

  <script>
    // State
    var scanResults = [];
    var reportData  = {};
    var settings    = {};
    var activeTab   = 'issues';

    // Message → code.js routing
    function postMessage(msg) { parent.postMessage({ pluginMessage: msg }, '*'); }

    // Scan trigger
    function runScan() { ... }

    // Render functions
    function renderIssues(results, filter) { ... }
    function renderLayers(results) { ... }
    function renderReport(data) { ... }
    function renderSettings(settings) { ... }
    function openDetailPanel(nodeId) { ... }

    // Fix actions
    function applyStyle(nodeId, styleId, property) { ... }
    function applyVariable(nodeId, variableId, property, index) { ... }
    function createStyle(nodeId, property) { ... }
    function selectNodes(ids) { ... }
    function deleteNode(nodeId) { ... }

    // Inbound messages from code.js
    window.onmessage = function(event) { ... };

    // Auto-resize
    var resizeObserver = new ResizeObserver(function() {
      var h = document.body.offsetHeight;
      postMessage({ type: 'resize', height: h });
    });
    resizeObserver.observe(document.body);
  </script>
</body>
```

---

## 8. Error Object Shape

```js
// One error, attached to a node
{
  nodeId:    'string',           // figma node id
  nodeName:  'string',           // display name
  nodeType:  'FRAME',            // figma node type
  ruleId:    'fill_missing',     // see below
  severity:  'error',            // 'error' | 'warning'
  message:   'Missing fill style — #3B82F6',
  value:     '#3B82F6',          // human-readable current value
  rawValue:  { r:0.23, g:0.51, b:0.96 },  // machine-readable for matching
  suggestedStyleId:   'S:abc123' | null,
  suggestedVariableId:'VariableID:xyz' | null,
  fillIndex: 0,                  // which fill (for multi-fill nodes)
  property:  'fill',             // 'fill'|'stroke'|'text'|'effect'|'cornerRadius'|
                                 // 'paddingLeft'|'paddingRight'|'paddingTop'|
                                 // 'paddingBottom'|'itemSpacing'|'opacity'
}
```

**Rule IDs:**
- `fill_missing` · `fill_mixed`
- `stroke_missing` · `stroke_mixed` · `stroke_multiple`
- `text_missing` · `text_mixed` · `text_suggested`
- `effect_missing`
- `radius_off_token`
- `spacing_off_token`
- `opacity_off_token`
- `hidden_layer`
- `naming_violation`

---

## 9. Storage Keys (figma.clientStorage)

| Key | Value shape | Notes |
|-----|-------------|-------|
| `linter-settings` | `{ lintVectors, warnHidden, warnNaming, showUnusedStyles, radiusAllowlist[], spacingAllowlist[], opacityAllowlist[] }` | Persisted per Figma document |
| `linter-ignored` | `{ [ruleId + value]: true }` | Per-rule-value ignores (survive re-scan) |
| `linter-ignored-nodes` | `{ [nodeId + ruleId]: true }` | Per-node ignores (survive re-scan) |

---

## 10. Implementation Phases

### Phase 1 — Core lint engine
- [ ] `manifest.json` + project scaffold
- [ ] `code.js`: Init, yieldIfNeeded, buildVariableIndex, getLocalStyles
- [ ] `code.js`: All 9 lint rule functions
- [ ] `code.js`: walkTree (async DFS with cancel token)
- [ ] `code.js`: Message handler: scan, apply_style, apply_variable, select_node, resize, open_url, close_plugin

### Phase 2 — Issues tab UI
- [ ] `ui.html`: Header + scope toggle + Scan button + progress bar
- [ ] `ui.html`: Tab bar wiring
- [ ] `ui.html`: Error list grouped by ruleId+value, with filter pills
- [ ] `ui.html`: Expand/collapse per group, showing layer sub-list
- [ ] `ui.html`: Per-error fix buttons (Apply Style / Apply Variable / Create Style / Ignore)
- [ ] `ui.html`: "Select All" group action
- [ ] `ui.html`: Variable suggestion badge (purple pill)

### Phase 3 — Layers tab + Detail panel
- [ ] `ui.html`: Layers tree render (recursive, collapsible)
- [ ] `ui.html`: Detail panel slide-in with prev/next navigation
- [ ] `code.js`: select_nodes, delete_node, show_node handlers

### Phase 4 — Report tab
- [ ] `code.js`: buildReport aggregator function
- [ ] `ui.html`: Report tab: Summary bar + Styles in Use + Variables in Use sections
- [ ] `ui.html`: Export JSON to clipboard

### Phase 5 — Settings tab + persistence
- [ ] `ui.html`: Allowlist tag editors (radius, spacing, opacity)
- [ ] `ui.html`: Toggle switches
- [ ] `code.js`: load_settings / save_settings handlers using clientStorage
- [ ] `code.js`: Respect settings in all lint rules

### Phase 6 — Polish
- [ ] Document-change listener + debounced re-scan prompt
- [ ] Locked layer skip
- [ ] Mixed-value handling for all rules
- [ ] Footer with brand + social + coffee links (URL allowlist in code.js)
- [ ] Final visual pass matching plugin design language

---

## 11. Notable Design Decisions

### Why vanilla JS, no build step
Consistent with all existing plugins in this workspace. No npm, no Webpack, no TypeScript. Single `code.js` + `ui.html`, deployable from Figma desktop directly. Faster iteration.

### Why 500px width
Wider than most panels (design-lint uses ~340px). The Report tab and grouped error list benefit from more horizontal space for node type breakdowns and variable names.

### Variable application vs. style application — priority
Styles are preferred over variables when both match, because styles carry semantic names visible in the Figma inspection panel. Variables are offered as the secondary option. When neither exists, the user can create a style.

### Severity levels: errors vs. warnings
- **Error (red):** Definitively wrong — missing style/variable on fill, stroke, text, effect.
- **Warning (amber):** Judgment call — hidden layer might be intentional, naming "Frame 5" might be intermediate work, off-token opacity might be approved. Warnings can be batch-ignored per rule type.

### grouping in the Issues tab
Errors are grouped by `ruleId + value` (not by `ruleId` alone). This means "Missing fill style — #3B82F6" and "Missing fill style — #EF4444" are separate rows. This matches how a designer would actually work: "fix all uses of this exact un-styled color" is the natural unit of work.

### Paragraph indent in text matching
Design-lint collects `paragraphIndent` but omits it from the comparison function (a bug). We include it. This matters when a text style explicitly sets a non-zero indent.

### Opacity token set
Design-lint ignores opacity entirely. Most design systems have a defined opacity scale (e.g., Tailwind: 0, 5%, 10%, 15%, 20%, 25%, 30%, 40%, 50%, 60%, 70%, 75%, 80%, 90%, 95%, 100%). Flagging 0.37 opacity is genuinely useful.

---

## 12. Key Figma API Surface

| API | Used for |
|-----|----------|
| `node.fills` / `node.fillStyleId` / `node.boundVariables.fills` | Fill linting |
| `node.strokes` / `node.strokeStyleId` / `node.boundVariables.strokes` | Stroke linting |
| `node.effects` / `node.effectStyleId` | Effect linting |
| `node.textStyleId` / `node.fontName` / `node.fontSize` / `node.lineHeight` / `node.letterSpacing` / `node.textCase` / `node.paragraphSpacing` / `node.paragraphIndent` | Text linting |
| `node.cornerRadius` / `node.topLeftRadius` etc. / `node.boundVariables.bottomLeftRadius` | Radius linting |
| `node.layoutMode` / `node.paddingLeft` / `node.paddingRight` / `node.paddingTop` / `node.paddingBottom` / `node.itemSpacing` / `node.counterAxisSpacing` | Spacing linting |
| `node.opacity` / `node.boundVariables.opacity` | Opacity linting |
| `node.visible` | Hidden layer detection |
| `node.name` / `node.type` | Naming detection + routing |
| `node.locked` | Skip locked layers |
| `node.children` | Tree traversal |
| `figma.currentPage.selection` / `.children` | Scan scope |
| `figma.getLocalPaintStyles()` / `getLocalTextStyles()` / `getLocalEffectStyles()` | Local style lookup |
| `figma.variables.getLocalVariables('COLOR')` / `getLocalVariables('FLOAT')` | Variable index |
| `figma.variables.setBoundVariableForPaint()` | Apply color variable to fill/stroke |
| `node.setBoundVariable()` | Apply float variable to radius/spacing/opacity |
| `figma.variables.getLocalVariableCollections()` | Variable collection names for display |
| `figma.clientStorage.getAsync()` / `setAsync()` | Persist settings + ignores |
| `figma.on('documentchange', ...)` | Live re-lint on edit |
| `figma.currentPage.selection = [...]` | Select nodes from results |
| `figma.openExternal()` | Footer links |
| `figma.closePlugin()` | Close plugin handler |
| `figma.createPaintStyle()` / `createTextStyle()` / `createEffectStyle()` | Create style from node |
