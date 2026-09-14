# Component Collector — Plugin Plan

## Summary

**Yes, this is fully doable.** The Figma Plugin API gives us everything we need: node type inspection, `createInstance()`, cross-page node movement, and `loadAsync()` for safe multi-page traversal.

This plugin scans every page in the document, finds all local master components (standalone `COMPONENT` nodes and `COMPONENT_SET` containers), and gathers them onto a dedicated page. Where a master component is embedded inside a design (i.e. living inside a frame as an actual design element, not floating freely on the canvas), the plugin first replaces it with a visually identical instance so the design is never left with a hole.

---

## Core Concepts

### Node Types We Care About

| Type | What it is | Action |
|---|---|---|
| `COMPONENT_SET` | Container holding variant `COMPONENT` children | Move entire set to collection page |
| `COMPONENT` (inside `COMPONENT_SET`) | A single variant | Skip — handled as part of its parent set |
| `COMPONENT` (parent = Page) | Standalone master floating on canvas | Move directly — nothing to replace |
| `COMPONENT` (parent = Frame/Group/etc.) | Master embedded inside a design | Replace with instance first, then move |

### The Key Insight

When a `COMPONENT` lives inside a `Frame`, removing it leaves a gap in the design. The fix is:

1. Call `component.createInstance()` → produces a pixel-perfect instance
2. Slot the instance into the same parent at the same index/position
3. Move the component (which is now detached from that parent) to the collection page

Instances always follow their master across pages — they don't break when the master is moved. This is a core Figma guarantee.

---

## Collection Page — Find or Create

The collection page has a fixed, unique name: **`"[component-collector]"`**

The bracketed, lowercase, hyphenated format makes it instantly distinguishable from any user-created page and is unlikely to collide with existing page names in real files.

On each run, the plugin checks before creating:

```
const COLLECTION_PAGE_NAME = '[component-collector]';

let collectionPage = figma.root.children.find(p => p.name === COLLECTION_PAGE_NAME);
if (!collectionPage) {
  collectionPage = figma.createPage();
  collectionPage.name = COLLECTION_PAGE_NAME;
}
```

- **First run**: page does not exist → created fresh
- **Subsequent runs**: page found by name → reused, components appended into the same auto-layout container
- **Scan skip**: the collection page is always excluded from the scan phase, so components already collected are never re-processed

This means the plugin is safe to run multiple times on the same file — each run drains whatever new masters are still living on design pages into the same collection page.

---

## Algorithm

### Phase 0 — Find or Create Collection Page

```
collectionPage = find page named '[component-collector]' or create it
skip this page during all scanning
```

### Phase 1 — Scan (page by page)

```
collected = []           // components to move
needsReplacement = []    // components embedded in designs

For each page in document (excluding collectionPage):
  await page.loadAsync()
  Run iterative DFS (stack-based) over all nodes on page

  For each node:
    if node.type === 'COMPONENT_SET':
      if node.remote === false (local only):
        add to collected (move entire set)
        do NOT descend into its COMPONENT children

    if node.type === 'COMPONENT':
      if parent is COMPONENT_SET:
        skip (already handled by parent)
      else if parent is a Page:
        add to collected (safe, standalone)
      else:
        add to needsReplacement (embedded in design)
        add to collected after replacement
```

### Phase 2 — Replace Embedded Components

For each component in `needsReplacement`:
```
parent = component.parent
index  = parent.children.indexOf(component)

instance = component.createInstance()
parent.insertChild(index, instance)
instance.x = component.x
instance.y = component.y

// component is now detached and ready to move
```

### Phase 3 — Move to Collection Page & Layout

Find or create the auto-layout container inside the collection page:

```
const CONTAINER_NAME = 'Components';

let container = collectionPage.findOne(n => n.type === 'FRAME' && n.name === CONTAINER_NAME);
if (!container) {
  container = figma.createFrame();
  container.name = CONTAINER_NAME;
  container.layoutMode = 'VERTICAL';
  container.primaryAxisSizingMode = 'AUTO';
  container.counterAxisSizingMode = 'AUTO';
  container.itemSpacing = 80;
  container.paddingTop = container.paddingBottom = 80;
  container.paddingLeft = container.paddingRight = 80;
  container.fills = [];
  container.x = 100;
  container.y = 100;
  collectionPage.appendChild(container);
}

For each component in collected:
  container.appendChild(component)
  // set layoutSizingHorizontal = 'FIXED' so it keeps its natural width
  component.layoutSizingHorizontal = 'FIXED';
```

- **First run**: container created fresh, components stacked inside it
- **Subsequent runs**: existing container found, new components appended to the bottom
- No manual x/y tracking needed — auto layout owns all positioning

---

## Identifying External Library Components

Skip any component where `component.remote === true`. These belong to external libraries and cannot be moved.

---

## Performance Architecture

All learnings carried over from instance-resetter:

### manifest.json
```json
{
  "documentAccess": "dynamic-page"
}
```
Required for safe multi-page access. Pages not currently open are only loaded on demand.

### Page Loading
```javascript
for (let pi = 0; pi < pages.length; pi++) {
  const page = pages[pi];
  if (page === collectionPage) continue;  // always skip
  try { await page.loadAsync(); } catch (e) {}
  // process page...
}
```
Load one page at a time, wrapped in try-catch.

### Iterative DFS (not recursive)
```javascript
const stack = [page];
while (stack.length > 0) {
  await yieldIfNeeded();
  const node = stack.pop();
  if (!node || node.removed) continue;
  // type checks...
  if ('children' in node) {
    for (let i = 0; i < node.children.length; i++) {
      stack.push(node.children[i]);
    }
  }
}
```
Stack-based traversal avoids call-stack overflow on deeply nested files.

### Cooperative Yielding
```javascript
let _yieldCounter = 0;
let _lastYieldTime = Date.now();

async function yieldIfNeeded() {
  if (++_yieldCounter % 50 !== 0) return;
  if (Date.now() - _lastYieldTime > 30) {
    await new Promise(r => setTimeout(r, 0));
    _lastYieldTime = Date.now();
  }
}
```
Yields control every 50 nodes. Prevents UI freeze on huge files.

### Component Deduplication
```javascript
const _seen = new Set();  // node IDs already queued for collection
```
Prevents double-processing if the same component is reachable via multiple traversal paths.

### Progress Updates (Throttled)
```javascript
if (Date.now() - _lastProgressTime > 100) {
  figma.ui.postMessage({ type: 'progress', page: pageName, pageIndex: pi, pageTotal: total, found: collected.length });
  _lastProgressTime = Date.now();
}
```
Max one UI update per 100ms.

### Per-Operation Error Isolation
```javascript
try {
  await processComponent(component);
} catch (e) {
  skipped++;
  // continue to next
}
```
One bad node never aborts the entire run.

---

## Edge Cases

| Case | Handling |
|---|---|
| Component inside a component | Only the outermost non-variant COMPONENT is targeted; inner ones travel with it |
| Component with no instances anywhere | Move directly — no replacement needed |
| External library components (`node.remote === true`) | Always skip |
| `COMPONENT_SET` itself inside a frame (unusual) | Treated same as embedded COMPONENT — replace with instance first |
| Node deleted during processing (`node.removed`) | Guard check at top of each loop iteration |
| Component is hidden or locked | Still collected — display state is irrelevant |
| Plugin run twice on same file | Collection page and container found by name; new components appended; already-collected ones skipped because they live on `[component-collector]` which is excluded from scan |

---

## UI Design

No configuration needed — the page name is fixed and the plugin is fully opinionated. The UI is purely informational.

```
┌──────────────────────────────────────┐
│  Component Collector                 │
│                                      │
│  Scans every page, gathers all       │
│  master components onto one page,    │
│  and replaces embedded masters       │
│  with instances in place.            │
│                                      │
│        [ Collect Components ]        │
└──────────────────────────────────────┘
```

During a run:
```
│  Scanning page 4 of 9 — 38 found    │
```

On completion:
```
│  Done                                │
│  42 collected · 6 replaced           │
```

### UI → Plugin Messages
```javascript
{ type: 'run' }
{ type: 'resize', height: number }
```

### Plugin → UI Messages
```javascript
{ type: 'progress', page: string, pageIndex: number, pageTotal: number, found: number }
{ type: 'done', collected: number, replaced: number, skipped: number }
{ type: 'error', message: string }
```

---

## File Structure

```
component-collector/
├── manifest.json   — plugin metadata, documentAccess: "dynamic-page"
├── code.js         — all plugin logic (scanning, replacing, moving, layout)
├── ui.html         — run button + progress display
└── PLAN.md         — this document
```

`code.js` follows the same single-file pattern as instance-resetter: no bundler, no dependencies, vanilla JS with async/await.

---

## Implementation Phases

### Phase 1 — Scaffold
- `manifest.json` with correct permissions
- `ui.html` with static layout
- `code.js` shell with message handlers

### Phase 2 — Scanner
- Page-by-page DFS excluding `[component-collector]`
- Correctly categorises: variant / standalone / embedded
- Reports findings to UI without mutating anything yet

### Phase 3 — Replacement
- `createInstance()` + re-parent for embedded components
- Position and index preservation

### Phase 4 — Collection Page + Layout
- Find-or-create page and auto-layout container
- Move nodes, set `layoutSizingHorizontal = 'FIXED'` on each

### Phase 5 — Polish
- Progress display and done state
- Error handling and per-node resilience
