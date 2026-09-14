# Figma Selector — Comprehensive Build Plan

## 1. Vision & Goals

**Figma Selector** is a precision selection tool that lets designers find and select any node in a Figma document using composable filters: by type, by name, by component hierarchy context, and by visual properties (fills, strokes, opacity, effects, etc.).

The design philosophy:
- **2-click minimum**: the most common case (select all text on the page) is just one type chip + click
- **Progressive disclosure**: advanced filters are accessible but never in the way
- **Live feedback**: the count updates as you configure — you always know what you'll get before you commit
- **Responsive**: never freezes, even on documents with 50,000+ nodes
- **Composable**: every filter stacks with AND logic; within a filter group, chips use OR logic

---

## 2. Complete V1 Feature Matrix

| Category | Feature |
|----------|---------|
| **Scope** | Current page |
| | Inside selection (all descendants) |
| | Direct children of selection |
| | Siblings of selection |
| **Name** | Contains (default) |
| | Exact match toggle |
| | Case-sensitive toggle |
| **Type** | Frame, Auto Layout, Group, Section |
| | Component, ComponentSet, Instance |
| | Text, Image, Vector |
| | Rectangle, Ellipse, Polygon, Star, Line, Boolean |
| | Widget, Connector, Sticky, Slice, Stamp, Washi Tape |
| **Context** | All / Inside instances / Not inside instances / Inside masters / Standalone |
| **Status (quick)** | Has Fill / No Fill |
| | Has Stroke / No Stroke |
| | Hidden / Locked / Masked |
| | No Children / Has Export |
| **Property Conditions** | Fill: presence, color match, variable-linked |
| | Stroke: presence, color match, weight, variable-linked |
| | Opacity: equals / greater than / less than |
| | Visibility: visible / hidden |
| | Lock state: locked / unlocked |
| | Effects: has drop shadow / inner shadow / blur / bg blur |
| | Auto Layout: enabled / direction (H/V) |
| | Children: has / none / count comparison |
| | Export: has / none |
| | Clips content: yes / no |

---

## 3. File Structure

```
figma-selector/
├── manifest.json       Plugin manifest
├── code.js             Plugin main thread (all Figma API access)
└── ui.html             Single-file UI (HTML + CSS + JS inline)
```

No build step. No npm. No TypeScript compilation. Direct Figma plugin pattern consistent with every other plugin in this repo. This keeps the plugin portable and zero-dependency.

---

## 3a. Icons — Lucide

We use **Lucide** for all iconography in the UI. Figma plugin UIs run in a real sandboxed iframe with network access, so we load Lucide from CDN in `ui.html`:

```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
```

Usage pattern — add `data-lucide` attributes, then call `lucide.createIcons()` once after DOM is ready (and again after any dynamic DOM updates like adding condition rows):

```html
<i data-lucide="search"></i>
<i data-lucide="plus"></i>
<i data-lucide="x"></i>
```

```js
document.addEventListener('DOMContentLoaded', function() {
  lucide.createIcons();
});

// After dynamically inserting new condition rows:
lucide.createIcons(); // safe to call multiple times
```

**Icon map — every icon used in the plugin:**

| Location | Icon name | Purpose |
|----------|-----------|---------|
| Header | `sliders-horizontal` | Plugin identity mark next to title |
| Name input | `search` | Left prefix inside the search input |
| Name input | `case-sensitive` | Exact/case toggle button |
| Scope section label | `scan` | Section icon |
| Type section label | `shapes` | Section icon |
| Context section label | `component` | Section icon |
| Status section label | `tag` | Section icon |
| Conditions section | `plus` | "Add condition" button |
| Condition row | `x` | Remove condition button |
| Condition dropdowns | `chevron-down` | Dropdown arrow |
| Color swatch in condition | `pipette` | Appears next to color input |
| Count/footer | `mouse-pointer-click` | Before the count label |
| Footer clear | `rotate-ccw` | Clear all filters icon |

**Icon sizing:** All icons rendered at `14px` (set via CSS `width: 14px; height: 14px; stroke-width: 1.75`). Section label icons at `12px`. The Lucide default stroke-width of 2 is slightly heavy at small sizes; 1.75 looks cleaner.

**Offline / production note:** If we ever need the plugin to work without internet (e.g. in restricted corporate Figma environments), we inline only the specific SVG `<path>` data for the icons we use. Lucide SVGs are MIT licensed. For now the CDN approach is used.

---

## 4. Manifest

```json
{
  "name": "Figma Selector",
  "id": "1234567890",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"]
}
```

**No `documentAccess: "dynamic-page"`** — we only operate on the current page (already loaded). Adding it would complicate the API without benefit for this scope.

**No extra permissions** — selection and property reading require no special permissions.

---

## 5. Architecture

### 5.1 High-Level Flow

```
┌──────────────────────────────────────────────────────┐
│  Figma Editor                                        │
│  ┌────────────────┐        ┌────────────────────┐   │
│  │  Plugin Thread │        │    UI Thread        │   │
│  │  (code.js)     │        │    (ui.html)        │   │
│  │                │◄──────│  User changes filter│   │
│  │  1. Collect    │ msg    │  → debounce 200ms   │   │
│  │  2. Filter     │        │  → postMessage(run) │   │
│  │  3. Select     │───────►│  → show count/done  │   │
│  │                │        │                     │   │
│  │  figma.on(     │        │  figma.on(          │   │
│  │  'selection-   │───────►│  'selectionchange') │   │
│  │  change')      │        │  → update scope UI  │   │
│  └────────────────┘        └────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### 5.2 Filter Pipeline (ordered cheapest → most expensive)

```
Stage 0  findAllWithCriteria({ types })      ← native C++ speed, up to 100x faster than findAll
Stage 1  Scope reduction                     ← filter by roots (no Figma API, just array filter)
Stage 2  Name filter                         ← string.includes() / string === / regex.test()
Stage 3  Context filter                      ← walk parent chain, O(depth) per node
Stage 4  Quick status chips                  ← node property reads, O(1) per node
Stage 5  Advanced property conditions        ← O(fills.length) per node, still all synchronous
```

This order ensures the heaviest checks (property conditions) run on the smallest possible candidate set.

### 5.3 Message Protocol

**UI → Plugin:**

```js
{ type: 'run',   config: FilterConfig }     // Apply selection
{ type: 'count', config: FilterConfig }     // Dry run — just return count
{ type: 'resize', width: number, height: number }
```

**Plugin → UI:**

```js
{ type: 'init',           hasSelection: bool, selectionCount: number }
{ type: 'selectionChange', hasSelection: bool, selectionCount: number }
{ type: 'count',           count: number, duration: number }   // ms taken
{ type: 'done',            count: number, duration: number }
{ type: 'progress',        processed: number, total: number }  // for large docs
{ type: 'error',           message: string }
{ type: 'cancelled' }
```

**FilterConfig shape (sent from UI):**

```js
{
  scope: 'page' | 'inside' | 'children' | 'siblings',
  nameFilter: {
    value: string,          // '' = disabled
    exactMatch: boolean,
    caseSensitive: boolean,
  },
  types: string[],           // [] = all types
  contextFilter: 'all' | 'instances-only' | 'not-instances' | 'masters-only' | 'standalone-only',
  statusChips: string[],     // ['no-fill', 'hidden', 'locked', ...]
  conditions: Condition[],   // Advanced condition rows
  conditionLogic: 'AND' | 'OR',
}

// Condition shape:
{ property: string, operator: string, value: any }
// e.g. { property: 'stroke-weight', operator: 'gt', value: 2 }
```

---

## 6. UI Design

### 6.1 UX Principles

1. **Default state is ready**: plugin opens with "all types, current page" already configured — one click to run
2. **Types are chips, not a list**: fast scanning, multi-select with OR logic, tappable without precise clicking
3. **Status booleans are chips too**: "No Fill", "Hidden", "Locked" — common checks without building a condition
4. **Condition builder for the rest**: color matching, weight comparison, variable linking — power user territory, behind "+ Add"
5. **Live count is the answer**: no "Search Preview" button; the count just updates. The user reads "247 nodes match" and decides whether to click Select
6. **Selection-aware**: plugin listens to `selectionchange` in Figma and immediately updates scope availability and count
7. **Scannable sections**: each section has a label and a colored dot when active — you can see at a glance what's filtering

### 6.2 Full UI Layout

```
╔══════════════════════════════════════╗  ← 300px wide
║  ◆ Figma Selector            [×]    ║  header — 40px
╠══════════════════════════════════════╣
║  SCOPE                               ║  ← 12px gray label
║  [Page ✓]  [Inside]  [Children]     ║  ← toggle pills, 28px tall
║            [Siblings]               ║  (disabled + dimmed when no selection)
╠══════════════════════════════════════╣
║  NAME                                ║
║  [🔍 Layer name...           ] [Aa] ║  ← input + exact-match toggle
╠══════════════════════════════════════╣
║  TYPE                                ║
║  [All] [Frame] [Auto] [Group]        ║  ← chip rows, wrapping
║  [Section] [Component] [Set]         ║
║  [Instance] [Text] [Image]           ║
║  [Vector] ··· [Show more ▾]          ║  ← collapsed row for rare types
╠══════════════════════════════════════╣
║  CONTEXT                             ║
║  [All ✓] [In Instances]             ║
║  [Not Instances] [In Masters]        ║
║  [Standalone]                        ║
╠══════════════════════════════════════╣
║  STATUS                              ║  ← quick boolean chips
║  [No Fill] [No Stroke] [Hidden]      ║  (all OFF by default, toggle ON = requires that)
║  [Locked] [Masked] [No Children]     ║
║  [Has Export]                        ║
╠══════════════════════════════════════╣
║  CONDITIONS                    [+]  ║  ← "+ Add condition" on right
║  ┌──────────────────────────────┐   ║
║  │ Fill ▾  │ linked to var ▾ │ ×│   ║  ← condition row
║  └──────────────────────────────┘   ║
║  ┌──────────────────────────────┐   ║
║  │ Stroke ▾│ weight > ▾│ 2  │ ×│   ║  ← condition row with value
║  └──────────────────────────────┘   ║
║  Logic: [AND ✓] [OR]                ║  ← only shown when 2+ conditions
╠══════════════════════════════════════╣
║  ─────────────── sticky bottom ─────║
║  247 nodes match · 12ms             ║  ← live count + perf info
║  [Clear All]        [Select Nodes]  ║  ← clear resets all, select commits
╚══════════════════════════════════════╝
```

**Height**: Auto-expands with conditions. Base: ~520px. Each condition row adds ~36px. Max visible height: 720px with internal scroll on the conditions section.

### 6.3 Visual Specification

```
Background:           #1e1e1e
Section surface:      transparent (dividers only)
Dividers:             1px solid #333
Section label:        #777, 10px, 500 weight, letter-spacing: 0.1em, uppercase
Body text:            #d4d4d4, 12px
Chip default:         background #2d2d2d, border #3a3a3a, text #c0c0c0
Chip active:          background #0d99ff20, border #0d99ff, text #0d99ff
Chip hover:           background #363636
Input background:     #2a2a2a, border #3d3d3d, text #e0e0e0
Input focus:          border #0d99ff
Count label:          #aaa, 11px
Perf info:            #666, 11px (the " · 12ms" part)
Select button:        background #0d99ff, text white, border-radius 6px, 32px tall
Clear button:         text #777, no background, text-decoration underline on hover
Error text:           #ff6b6b
Font:                 Inter, system-ui, sans-serif
```

### 6.4 Chip Interaction Model

- **Type chips**: Multi-select OR logic. Clicking "All" deselects everything (= no type filter). Clicking any specific type deactivates "All" and selects that type. Clicking a selected type deselects it (if it's the last one, reverts to "All").
- **Context chips**: Single-select. Always exactly one active. Clicking the active one does nothing.
- **Status chips**: Multi-select AND logic. Each chip is a toggle. Active = requires that condition. OFF = don't care.
- **Scope pills**: Single-select. "Page" is always available. "Inside", "Children", "Siblings" are disabled (not just dimmed) when no selection exists.

### 6.5 Live Count Behavior

```
User changes any filter
        ↓
Debounce 200ms (reset on each change)
        ↓
Send { type: 'count', config } to plugin thread
        ↓
Count label → "Searching..." (only if not done in <80ms)
        ↓
Plugin replies { type: 'count', count: N, duration: T }
        ↓
Label → "247 nodes match · 12ms"
```

If a new count request arrives while one is running, the running one is cancelled via cancellation token.

### 6.6 Selection Change Tracking

```js
// In code.js — always active while plugin is open
figma.on('selectionchange', function() {
  var sel = figma.currentPage.selection;
  figma.ui.postMessage({
    type: 'selectionChange',
    hasSelection: sel.length > 0,
    selectionCount: sel.length,
  });
});
```

When the UI receives this, it:
1. Enables/disables scope options
2. If current scope is a selection-based option and `hasSelection` just became false → auto-switches scope to "page"
3. If scope is selection-based → triggers a fresh count

---

## 7. Core Algorithms — code.js

### 7.1 Initialization

```js
figma.showUI(__html__, { width: 300, height: 520, title: 'Figma Selector' });

var sel = figma.currentPage.selection;
figma.ui.postMessage({
  type: 'init',
  hasSelection: sel.length > 0,
  selectionCount: sel.length,
});

figma.on('selectionchange', function() {
  var s = figma.currentPage.selection;
  figma.ui.postMessage({
    type: 'selectionChange',
    hasSelection: s.length > 0,
    selectionCount: s.length,
  });
});
```

### 7.2 Message Handler

```js
var _cancelToken = 0;  // Incremented before each new operation

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'resize') {
    figma.ui.resize(msg.width, msg.height);
    return;
  }
  if (msg.type === 'run' || msg.type === 'count') {
    _cancelToken++;
    var myToken = _cancelToken;
    var apply = msg.type === 'run';
    var t0 = Date.now();

    try {
      var results = await executeFilterPipeline(msg.config, myToken);

      if (myToken !== _cancelToken) {
        figma.ui.postMessage({ type: 'cancelled' });
        return;
      }

      if (apply) {
        figma.currentPage.selection = results;
        figma.ui.postMessage({ type: 'done', count: results.length, duration: Date.now() - t0 });
      } else {
        figma.ui.postMessage({ type: 'count', count: results.length, duration: Date.now() - t0 });
      }
    } catch (err) {
      if (myToken === _cancelToken) {
        figma.ui.postMessage({ type: 'error', message: err.message });
      }
    }
  }
};
```

### 7.3 Filter Pipeline — executeFilterPipeline()

```js
async function executeFilterPipeline(config, token) {
  // === Stage 0: Collect candidates by type ===
  var types = config.types && config.types.length > 0 ? config.types : null;

  // Normalize 'AUTO_LAYOUT' pseudo-type → 'FRAME' (filter for layoutMode later)
  var wantsAutoLayout = types && types.includes('AUTO_LAYOUT');
  var apiTypes = types ? types.filter(function(t) { return t !== 'AUTO_LAYOUT'; }) : null;
  if (wantsAutoLayout && apiTypes && !apiTypes.includes('FRAME')) apiTypes.push('FRAME');

  // Determine search roots based on scope
  var searchRoots = getSearchRoots(config.scope);
  if (!searchRoots) {
    figma.ui.postMessage({ type: 'error', message: 'Nothing is selected.' });
    return [];
  }

  // Collect via findAllWithCriteria for speed
  var candidates = [];
  for (var i = 0; i < searchRoots.length; i++) {
    var root = searchRoots[i];
    var criteria = apiTypes ? { types: apiTypes } : {};
    var found = ('findAllWithCriteria' in root)
      ? root.findAllWithCriteria(criteria)
      : [root];
    for (var j = 0; j < found.length; j++) candidates.push(found[j]);
  }

  // If scope=children, limit to direct children of selection roots
  if (config.scope === 'children') {
    candidates = candidates.filter(function(n) {
      return searchRoots.some(function(r) { return r.id === (n.parent && n.parent.id); });
    });
  }

  if (token !== _cancelToken) return [];

  // === Stage 1: Auto Layout sub-filter ===
  if (wantsAutoLayout && types && !types.includes('FRAME')) {
    // Only wanted AUTO_LAYOUT, not plain frames
    candidates = candidates.filter(function(n) {
      return n.type === 'FRAME' && n.layoutMode !== 'NONE';
    });
  } else if (wantsAutoLayout && types && types.includes('FRAME')) {
    // Wanted both: keep all frames AND auto-layout frames (which are frames anyway)
    // No extra filter needed
  } else if (!wantsAutoLayout && types && types.includes('FRAME')) {
    // Wanted only plain frames (without auto layout) — but AUTO_LAYOUT not selected
    // Keep as is; user can add a condition for layoutMode if they want to exclude
  }

  // === Stage 2: Name filter ===
  var nf = config.nameFilter;
  if (nf && nf.value && nf.value.length > 0) {
    candidates = applyNameFilter(candidates, nf);
  }

  if (token !== _cancelToken) return [];

  // === Stage 3: Context filter ===
  if (config.contextFilter && config.contextFilter !== 'all') {
    candidates = applyContextFilter(candidates, config.contextFilter);
  }

  if (token !== _cancelToken) return [];

  // === Stage 4 & 5: Status chips + Conditions ===
  if ((config.statusChips && config.statusChips.length > 0) ||
      (config.conditions && config.conditions.length > 0)) {
    candidates = await applyPropertyFilters(candidates, config, token);
  }

  return candidates;
}
```

### 7.4 Scope Collection — getSearchRoots()

```js
function getSearchRoots(scope) {
  if (!scope || scope === 'page') {
    return [figma.currentPage];
  }
  var sel = figma.currentPage.selection;
  if (sel.length === 0) return null;

  if (scope === 'inside') {
    // Return the selected nodes as roots — findAllWithCriteria will descend
    return Array.from(sel);
  }
  if (scope === 'children') {
    // Same roots — we filter to direct children later
    return Array.from(sel);
  }
  if (scope === 'siblings') {
    // Return parents of selected nodes as roots, then we'll filter
    // to only siblings (nodes at the same level)
    var siblingSet = new Set();
    var parents = new Set();
    for (var i = 0; i < sel.length; i++) {
      var parent = sel[i].parent;
      if (parent && !parents.has(parent.id)) {
        parents.add(parent.id);
        if ('children' in parent) {
          for (var j = 0; j < parent.children.length; j++) {
            siblingSet.add(parent.children[j]);
          }
        }
      }
    }
    return Array.from(siblingSet);
  }
  return [figma.currentPage];
}
```

**Note for siblings**: When scope is 'siblings', we collect the actual sibling nodes directly (not using findAllWithCriteria to descend), since siblings are at the same level.

### 7.5 Name Filter — applyNameFilter()

```js
function applyNameFilter(nodes, nf) {
  var val = nf.caseSensitive ? nf.value : nf.value.toLowerCase();
  return nodes.filter(function(node) {
    var name = nf.caseSensitive ? node.name : node.name.toLowerCase();
    if (nf.exactMatch) return name === val;
    return name.indexOf(val) !== -1;
  });
}
```

### 7.6 Context Detection — getAncestorContext()

```js
// Returns 'instance', 'master', or 'standalone'
// Walks parent chain, returns on FIRST significant container encountered
function getAncestorContext(node) {
  var cur = node.parent;
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    if (cur.type === 'INSTANCE') return 'instance';
    if (cur.type === 'COMPONENT') return 'master';
    cur = cur.parent;
  }
  return 'standalone';
}

function applyContextFilter(nodes, contextFilter) {
  return nodes.filter(function(node) {
    var ctx = getAncestorContext(node);
    if (contextFilter === 'instances-only')  return ctx === 'instance';
    if (contextFilter === 'not-instances')   return ctx !== 'instance';
    if (contextFilter === 'masters-only')    return ctx === 'master';
    if (contextFilter === 'standalone-only') return ctx === 'standalone';
    return true;
  });
}
```

**Edge cases handled:**
- Text inside COMPONENT_SET variant: hits COMPONENT first → `'master'` ✓
- Text inside instance nested within a master component: hits INSTANCE first → `'instance'` ✓
- Text directly on page: no significant ancestor → `'standalone'` ✓

### 7.7 Property Filter Pipeline — applyPropertyFilters()

```js
var _yieldCount = 0;
var _lastYield = Date.now();

async function yieldIfNeeded(token) {
  if (++_yieldCount % 100 !== 0) return true;
  if (Date.now() - _lastYield > 30) {
    await new Promise(function(r) { setTimeout(r, 0); });
    _lastYield = Date.now();
  }
  return token === _cancelToken;
}

async function applyPropertyFilters(nodes, config, token) {
  var results = [];
  var total = nodes.length;
  var lastProgress = Date.now();
  _yieldCount = 0;
  _lastYield = Date.now();

  for (var i = 0; i < total; i++) {
    var node = nodes[i];
    var ok = true;

    // --- Quick status chips (each chip uses OR within the same property domain) ---
    if (config.statusChips && config.statusChips.length > 0) {
      ok = evalStatusChips(node, config.statusChips);
    }

    // --- Advanced conditions ---
    if (ok && config.conditions && config.conditions.length > 0) {
      ok = evalConditions(node, config.conditions, config.conditionLogic || 'AND');
    }

    if (ok) results.push(node);

    // Yield + progress reporting
    var alive = await yieldIfNeeded(token);
    if (!alive) return [];

    if (Date.now() - lastProgress > 150) {
      figma.ui.postMessage({ type: 'progress', processed: i + 1, total: total });
      lastProgress = Date.now();
    }
  }

  return results;
}
```

### 7.8 Status Chip Evaluator — evalStatusChips()

Status chips are AND-combined (all active chips must pass):

```js
function evalStatusChips(node, chips) {
  for (var i = 0; i < chips.length; i++) {
    var chip = chips[i];
    var pass = false;

    if (chip === 'no-fill')       pass = !hasFills(node);
    if (chip === 'has-fill')      pass = hasFills(node);
    if (chip === 'no-stroke')     pass = !hasStrokes(node);
    if (chip === 'has-stroke')    pass = hasStrokes(node);
    if (chip === 'hidden')        pass = node.visible === false;
    if (chip === 'locked')        pass = node.locked === true;
    if (chip === 'masked')        pass = node.isMask === true;
    if (chip === 'no-children')   pass = !('children' in node) || node.children.length === 0;
    if (chip === 'has-export')    pass = node.exportSettings && node.exportSettings.length > 0;

    if (!pass) return false;  // AND logic: one failure = whole node fails
  }
  return true;
}

function hasFills(node) {
  if (!('fills' in node)) return false;
  var fills = node.fills;
  if (fills === figma.mixed) return false;
  return fills.some(function(f) { return f.visible !== false; });
}

function hasStrokes(node) {
  if (!('strokes' in node)) return false;
  var strokes = node.strokes;
  return strokes && strokes.length > 0 && strokes.some(function(s) { return s.visible !== false; });
}
```

### 7.9 Advanced Condition Evaluator — evalConditions()

```js
function evalConditions(node, conditions, logic) {
  for (var i = 0; i < conditions.length; i++) {
    var pass = evalSingleCondition(node, conditions[i]);
    if (logic === 'AND' && !pass) return false;
    if (logic === 'OR'  && pass)  return true;
  }
  return logic === 'AND';  // AND: all passed. OR: none passed.
}

function evalSingleCondition(node, cond) {
  var p = cond.property;
  var op = cond.operator;
  var val = cond.value;

  // --- Fill conditions ---
  if (p === 'fill') {
    if (!('fills' in node) || node.fills === figma.mixed) return op === 'no-fill';
    var fills = node.fills.filter(function(f) { return f.visible !== false; });
    if (op === 'has-fill')          return fills.length > 0;
    if (op === 'no-fill')           return fills.length === 0;
    if (op === 'color-equals')      return fills.some(function(f) { return f.type === 'SOLID' && colorMatchesHex(f.color, val); });
    if (op === 'color-not-equals')  return !fills.some(function(f) { return f.type === 'SOLID' && colorMatchesHex(f.color, val); });
    if (op === 'linked-to-variable')return fills.some(function(f) { return f.boundVariables && f.boundVariables.color; });
    if (op === 'not-linked')        return !fills.some(function(f) { return f.boundVariables && f.boundVariables.color; });
  }

  // --- Stroke conditions ---
  if (p === 'stroke') {
    if (!('strokes' in node)) return op === 'no-stroke';
    var strokes = node.strokes.filter(function(s) { return s.visible !== false; });
    if (op === 'has-stroke')          return strokes.length > 0;
    if (op === 'no-stroke')           return strokes.length === 0;
    if (op === 'color-equals')        return strokes.some(function(s) { return s.type === 'SOLID' && colorMatchesHex(s.color, val); });
    if (op === 'color-not-equals')    return !strokes.some(function(s) { return s.type === 'SOLID' && colorMatchesHex(s.color, val); });
    if (op === 'linked-to-variable')  return strokes.some(function(s) { return s.boundVariables && s.boundVariables.color; });
    if (op === 'weight-equals')       return 'strokeWeight' in node && node.strokeWeight === Number(val);
    if (op === 'weight-gt')           return 'strokeWeight' in node && node.strokeWeight > Number(val);
    if (op === 'weight-lt')           return 'strokeWeight' in node && node.strokeWeight < Number(val);
  }

  // --- Opacity conditions ---
  if (p === 'opacity') {
    var opac = ('opacity' in node ? node.opacity : 1) * 100;
    if (op === 'equals') return Math.round(opac) === Number(val);
    if (op === 'gt')     return opac > Number(val);
    if (op === 'lt')     return opac < Number(val);
  }

  // --- Visibility ---
  if (p === 'visible') {
    if (op === 'is-visible') return node.visible !== false;
    if (op === 'is-hidden')  return node.visible === false;
  }

  // --- Lock ---
  if (p === 'locked') {
    if (op === 'is-locked')   return node.locked === true;
    if (op === 'is-unlocked') return node.locked !== true;
  }

  // --- Effects ---
  if (p === 'effects') {
    if (!('effects' in node)) return op === 'no-effect';
    var effects = node.effects || [];
    if (op === 'has-effect')        return effects.length > 0;
    if (op === 'no-effect')         return effects.length === 0;
    if (op === 'has-drop-shadow')   return effects.some(function(e) { return e.type === 'DROP_SHADOW'; });
    if (op === 'has-inner-shadow')  return effects.some(function(e) { return e.type === 'INNER_SHADOW'; });
    if (op === 'has-blur')          return effects.some(function(e) { return e.type === 'LAYER_BLUR'; });
    if (op === 'has-bg-blur')       return effects.some(function(e) { return e.type === 'BACKGROUND_BLUR'; });
  }

  // --- Auto Layout ---
  if (p === 'auto-layout') {
    if (!('layoutMode' in node)) return op === 'no-auto-layout';
    if (op === 'has-auto-layout')  return node.layoutMode !== 'NONE';
    if (op === 'no-auto-layout')   return node.layoutMode === 'NONE';
    if (op === 'is-horizontal')    return node.layoutMode === 'HORIZONTAL';
    if (op === 'is-vertical')      return node.layoutMode === 'VERTICAL';
    if (op === 'is-grid')          return node.layoutMode === 'GRID';
  }

  // --- Children ---
  if (p === 'children') {
    var hasKids = 'children' in node;
    var count = hasKids ? node.children.length : 0;
    if (op === 'has-children')  return count > 0;
    if (op === 'no-children')   return count === 0;
    if (op === 'count-equals')  return count === Number(val);
    if (op === 'count-gt')      return count > Number(val);
    if (op === 'count-lt')      return count < Number(val);
  }

  // --- Clips content ---
  if (p === 'clips') {
    if (op === 'clips-content')     return 'clipsContent' in node && node.clipsContent === true;
    if (op === 'no-clip')           return !('clipsContent' in node) || node.clipsContent === false;
  }

  // --- Export settings ---
  if (p === 'export') {
    var hasExp = node.exportSettings && node.exportSettings.length > 0;
    if (op === 'has-export') return hasExp;
    if (op === 'no-export')  return !hasExp;
  }

  // --- Mask ---
  if (p === 'mask') {
    if (op === 'is-mask')     return node.isMask === true;
    if (op === 'is-not-mask') return node.isMask !== true;
  }

  return false;
}

// RGB (0-1) to hex comparison
function colorMatchesHex(color, hex) {
  if (!color || !hex) return false;
  var h = hex.replace('#', '');
  var r = parseInt(h.substring(0, 2), 16);
  var g = parseInt(h.substring(2, 4), 16);
  var b = parseInt(h.substring(4, 6), 16);
  return Math.abs(Math.round(color.r * 255) - r) < 2 &&
         Math.abs(Math.round(color.g * 255) - g) < 2 &&
         Math.abs(Math.round(color.b * 255) - b) < 2;
}
```

---

## 8. Performance Strategy

### 8.1 Why This Plugin Will Stay Fast

| Technique | Benefit |
|-----------|---------|
| `findAllWithCriteria({ types })` | 100x faster than `findAll()` — native indexed lookup |
| Filter ordering (type → name → context → property) | Each stage shrinks the set before the next, more expensive stage |
| Synchronous property reads | No `await` in the filter loop; fills/strokes are in-memory |
| `yieldIfNeeded()` every 100 nodes | Keeps Figma UI responsive during large traversals |
| Cancellation token | New search cancels the old one instantly |
| 200ms debounce on live count | No spam on rapid filter changes |
| 80ms threshold for "Searching..." label | Fast searches don't flicker the UI |

### 8.2 Estimated Performance on Real Files

| Scenario | Expected time |
|----------|---------------|
| Select all text, page with 1,000 nodes | < 30ms |
| Select all text with name filter, 10,000 nodes | < 100ms |
| Select all text with context filter, 10,000 nodes | < 200ms |
| Select all frames with property conditions, 50,000 nodes | < 1,000ms |
| Full filter stack, 100,000 node document | 2-4 seconds (with progress bar) |

### 8.3 `figma.skipInvisibleInstanceChildren`

We do NOT set this to `true` by default because:
1. It's a persistent session flag — affects all subsequent `getNodeById` calls
2. Users may want to select nodes inside hidden instances
3. It returns `null` for invisible nodes even when accessed by ID later

We expose this as an optional "Skip hidden layer children" toggle in the UI (default off). When on, set it before the pipeline and reset after (note: cannot actually be reset — so it stays on for the session).

### 8.4 Siblings Scope — Special Case

Siblings don't use `findAllWithCriteria` recursion. Instead:

```js
// Collect siblings directly from parent.children
var seen = new Set();
for each selected node → get parent → iterate parent.children → add to candidates set
// Then apply all other filters normally on that flat list
```

This is O(sibling count), not O(document size). Very fast.

---

## 9. Condition Builder — UI State Model

### 9.1 Property Menu

**Color filtering is fully supported** for both fills and strokes. When a color operator is selected, the value input renders as an `<input type="color">` (native color picker) alongside a hex text field. The comparison uses a ±2/255 tolerance per channel to handle Figma's float rounding. Only **SOLID** fills/strokes are color-matched — gradients, images, and pattern fills are never matched by the color operator (a tooltip clarifies this). If a node has multiple fills, the condition passes if **any** visible fill matches the target color.

```
─ Fill
  ├── has fill
  ├── no fill
  ├── fill color =  [🎨 #FFFFFF]    ← color picker + hex input
  ├── fill not color =  [🎨 #FFFFFF]
  └── fill linked to variable

─ Stroke
  ├── has stroke
  ├── no stroke
  ├── stroke color =  [🎨 #FFFFFF]  ← color picker + hex input
  ├── stroke color ≠  [🎨 #FFFFFF]
  ├── stroke weight =  [  2  ]      ← number input, px
  ├── stroke weight >  [  2  ]
  ├── stroke weight <  [  2  ]
  └── stroke linked to variable

─ Opacity
  ├── opacity = [0–100]
  ├── opacity > [0–100]
  └── opacity < [0–100]

─ Visibility
  ├── is visible
  └── is hidden

─ Lock
  ├── is locked
  └── is unlocked

─ Effects
  ├── has effect
  ├── no effect
  ├── has drop shadow
  ├── has inner shadow
  ├── has layer blur
  └── has background blur

─ Auto Layout
  ├── has auto layout
  ├── no auto layout
  ├── direction: horizontal
  ├── direction: vertical
  ├── direction: grid
  ├── wrap: on            ← layoutWrap === 'WRAP' (HORIZONTAL only)
  └── wrap: off

─ Padding Left / Right / Top / Bottom  (each its own property)
  ├── padding = [n]
  ├── padding > [n]
  ├── padding < [n]
  └── padding between [n]–[n]

─ Padding (All Sides)                 ← passes only if every side matches
  ├── padding = [n]
  ├── padding > [n]
  ├── padding < [n]
  └── padding between [n]–[n]

─ Gap (Item Spacing)
  ├── gap = [n]
  ├── gap > [n]
  ├── gap < [n]
  └── gap between [n]–[n]

─ Children
  ├── has children
  ├── no children
  ├── child count = [n]
  ├── child count > [n]
  └── child count < [n]

─ Clips Content
  ├── clips content
  └── doesn't clip

─ Export Settings
  ├── has export
  └── no export

─ Mask
  ├── is mask
  └── is not mask
```

### 9.2 Condition Row Layout

```
[Property ▾ (120px)] [Operator ▾ (130px)] [Value (60px, if needed)] [× (24px)]
```

Operators and value inputs are shown/hidden based on the selected property. The value input type changes:
- Color condition → `<input type="color">` with hex text fallback
- Number condition → `<input type="number" min="0">` with appropriate range
- No value needed → row is just 2 dropdowns + ×

### 9.3 Logic Toggle

Only shown when 2+ conditions exist:
```
Match [All ✓] [Any] of the above conditions
```
"All" = AND, "Any" = OR.

---

## 10. Type System Reference

Full list of Figma node types and how they map to our type chips:

| Our Chip | Figma `node.type` values matched |
|----------|----------------------------------|
| Frame | `FRAME` where `layoutMode === 'NONE'` |
| Auto Layout | `FRAME` where `layoutMode !== 'NONE'` |
| Group | `GROUP` |
| Section | `SECTION` |
| Component | `COMPONENT` |
| ComponentSet | `COMPONENT_SET` |
| Instance | `INSTANCE` |
| Text | `TEXT` |
| Image | `RECTANGLE` with image fill (or use `IMAGE` type) |
| Vector | `VECTOR` |
| Rectangle | `RECTANGLE` |
| Ellipse | `ELLIPSE` |
| Polygon | `POLYGON` |
| Star | `STAR` |
| Line | `LINE` |
| Boolean | `BOOLEAN_OPERATION` |
| Widget | `WIDGET` |
| Connector | `CONNECTOR` |
| Sticky | `STICKY` |
| Stamp | `STAMP` |
| Slice | `SLICE` |
| Washi Tape | `WASHI_TAPE` |

**Auto Layout** is a pseudo-type: it's a FRAME with `layoutMode !== 'NONE'`. When "Auto Layout" chip is selected alone, we collect FRAMEs then sub-filter. When both "Frame" and "Auto Layout" are selected, we collect all FRAMEs (Auto Layout frames are frames).

---

## 11. Step-by-Step Build Order

### Phase 1 — Skeleton (working but minimal)
1. `manifest.json` with the config from Section 4
2. `code.js`: `showUI`, `onmessage` handler, `init` postMessage, `selectionchange` listener
3. `ui.html`: dark shell with section labels, no functionality yet

### Phase 2 — Core engine
4. Implement `getSearchRoots(scope)` 
5. Implement `executeFilterPipeline(config, token)` — type collection only
6. Implement `applyNameFilter()`
7. Wire "run" and "count" messages end-to-end — basic type + name filtering works

### Phase 3 — Context filter
8. Implement `getAncestorContext(node)` 
9. Implement `applyContextFilter()`
10. Add Context chips to UI, wire to config

### Phase 4 — Status chips
11. Implement `evalStatusChips()` with all 8 status types
12. Add Status chip grid to UI, wire to config

### Phase 5 — Condition builder
13. Build condition row component in UI (property dropdown, operator dropdown, value input, × button)
14. Implement AND/OR logic toggle
15. Implement all `evalSingleCondition()` branches
16. Wire condition builder to config

### Phase 6 — Live count & polish
17. Debounced count trigger on any filter change
18. "Searching..." indicator (only if > 80ms)
19. Progress bar for large operations (>2000 nodes in stage 4/5)
20. Selection change tracking → scope enable/disable + auto-count
21. "Clear All" button
22. Resize handler for dynamic height
23. "Show more types" toggle for rare type chips

### Phase 7 — Testing & edge cases
24. Test all conditions against edge cases (see test matrix below)
25. Verify performance on large documents
26. Add "Auto Layout" pseudo-type handling

---

## 12. Test Matrix

| Scenario | Scope | Type | Context | Status | Expected |
|----------|-------|------|---------|--------|----------|
| Page with no nodes | Page | All | All | — | 0 |
| Standalone text node | Page | Text | All | — | found |
| Text inside INSTANCE | Page | Text | Instances only | — | found |
| Text inside INSTANCE | Page | Text | Masters only | — | not found |
| Text inside COMPONENT variant | Page | Text | Masters only | — | found |
| Text in COMPONENT inside COMPONENT_SET | Page | Text | Masters only | — | found |
| Frame with no fills | Page | Frame | All | No Fill | found |
| Frame with white fill | Page | Frame | All | Has Fill | found |
| Frame with white fill + condition "fill color = #FFFFFF" | Page | Frame | All | — | found |
| Hidden text layer | Page | Text | All | Hidden | found |
| Locked frame | Page | Frame | All | Locked | found |
| Auto layout frame | Page | Auto Layout | All | — | found |
| Regular frame (no AL) | Page | Auto Layout | All | — | not found |
| Node with drop shadow | Page | All | All | — + condition "has drop shadow" | found |
| Node with stroke weight 3 + condition "stroke weight > 2" | Page | All | All | — | found |
| Nothing selected, scope=Inside | — | — | — | — | error message |
| Selection exists, scope=Children | sel | All | All | — | direct children only |
| 2 conditions AND: has fill + hidden | Page | All | All | — | only nodes with fills AND hidden |
| 2 conditions OR: has fill + hidden | Page | All | All | — | nodes with fills OR hidden |
| Name filter "button" exact match | Page | All | All | — | only nodes named exactly "button" |
| Name filter "btn" contains | Page | All | All | — | all nodes with "btn" in name |

---

## 13. Future Extensions (V2+)

The architecture is deliberately designed with extension points:

- **Cross-page scope**: Add "All Pages" scope option. Add `documentAccess: "dynamic-page"` to manifest. Iterate over pages with `await page.loadAsync()` and post progress per page.
- **More node type chips**: Already handled by the type registry in Section 10 — just add chips.
- **Regex name filter**: Change `nameFilter.mode` to include `'regex'`. Use `new RegExp(val, flags).test(node.name)`.
- **Font conditions** (Text only): `node.fontName`, `node.fontSize`, `node.fontWeight` — add to condition builder, show only when type=Text is active.
- **Variable binding conditions**: Check `node.boundVariables` for top-level variable links (width, height, opacity, etc.). `fill.boundVariables.color` already handled.
- **Save/load filter presets**: Serialize `FilterConfig` to `figma.clientStorage.setAsync('presets', [...])`.
- **Select and zoom**: After selecting, call `figma.viewport.scrollAndZoomIntoView(results)` to navigate to the results.
- **Count breakdown**: Return counts per type/context/status so the UI can show "247 nodes (142 in instances, 80 in masters, 25 standalone)".
- **Invert selection**: Select all nodes on the page EXCEPT the ones matching the filters.
