# Figma Relinker — Implementation Plan

**Plugin name:** Figma Relinker  
**Folder:** `figma-relinker/`  
**Reference plugin:** [Component Relinker](https://www.figma.com/community/plugin/981892464363185469/component-relinker)  
**Date:** 2026-06-29  
**QA pass:** 2026-06-29 (16 issues patched — see changelog at bottom)

---

## 1. What the Original Plugin Does (Feature Extraction)

The community **Component Relinker** plugin was built for one specific scenario: migrating files between Figma workspaces. Here is a precise breakdown of its feature set:

### Core Problem It Solves
When a Figma file is moved to a new workspace (e.g., from a personal workspace to an org workspace), all component instances inside that file still reference their main components by the old workspace's component IDs. Those IDs are no longer valid, so the instances break — they appear "detached" with a generic name and no library connection.

### Feature Set of Original Plugin

| Feature | Detail |
|---|---|
| **Library selection dropdown** | User picks which file holds the "real" component definitions from a list of available team libraries |
| **"Relink Components" button** | Single action that triggers the batch relinking process |
| **Name-based matching** | Matches broken instances to library components by component name |
| **Batch processing** | Handles multiple instances in one run |
| **Progress indicator** | Some processing feedback (takes "a few minutes") |

### Known Limitations of Original Plugin

1. **Requires Professional plan or higher** — `figma.teamLibrary` API requires org/professional access
2. **Components must be published first** — the target library file must already be published to the team
3. **Slow** — can take several minutes on large files
4. **Brittle name matching** — if a component was renamed during the migration, it won't be found
5. **No preview** — applies changes blindly, no confirmation step
6. **No undo grouping** — can't undo as one action
7. **No scope control** — can't limit to selection, current page, or full document
8. **No mismatch reporting** — doesn't tell you which instances it couldn't match
9. **Single library source** — you can only target one library at a time
10. **No fuzzy/path matching** — strict name equality only

---

## 2. Problem Space: How Component Relinking Actually Works

### The Figma Data Model

An INSTANCE node in Figma has:
- `mainComponentId` — the ID of the main component node (persists even when broken)
- `mainComponent` — the resolved node object (returns `null` when inaccessible)
- `name` — for variant-based components this is typically the **component SET name** (e.g. "Button"), not the variant name
- `componentProperties` — the variant values currently set (e.g. `{ State: "Default", Size: "Large" }`) — these survive even when the instance is broken

A COMPONENT node (in a published library) has:
- `key` — a stable key used to import it via `figma.importComponentByKeyAsync(key)`
- `name` — the component name, which for a variant looks like `"State=Default, Size=Large"` (the variant property string)

A COMPONENT_SET node has:
- `key` — used to import the entire set via `figma.importComponentSetByKeyAsync(key)`
- `name` — the set name e.g. `"Button"` — this is what typically matches `instance.name`
- `children` — the individual COMPONENT variants

> **Key insight:** When a variant instance is broken, `instance.name` matches the COMPONENT_SET name, not the individual variant. The individual variant is identified by `instance.componentProperties`. This two-level matching is critical — see Section 4.

### When Is an Instance "Broken"?

An instance is broken when `instance.mainComponent === null`. This happens when:

1. **Cross-workspace move** — the file was moved to a different workspace, invalidating component IDs
2. **Library file deleted or unpublished** — the source library no longer exists
3. **Component moved to a different library file** — the component exists but in a different file
4. **Local component deleted** — the main component was removed from the file
5. **Duplicated file with components** — the copy has instances pointing to the original file's components

### The Relinking API — Exact Method Names

```js
// 1. Get all component SETS from libraries connected to this file
//    ✅ CORRECT: getAvailableLibraryComponentSetsAsync (returns component SETS, not individual components)
//    ❌ WRONG:   getAvailableLibraryComponentsAsync (does not exist in the Plugin API)
const sets = await figma.teamLibrary.getAvailableLibraryComponentSetsAsync();
// sets: [{ key, name, libraryName }]
// 'name' here is the COMPONENT_SET name, e.g. "Button", "Icon/Arrow"

// 2. Import a specific component set to access its variants
const importedSet = await figma.importComponentSetByKeyAsync(set.key);
// importedSet: ComponentSetNode — now you can access importedSet.children

// 3. Find the right variant among the set's children
const variant = importedSet.children.find(c => variantMatchesProperties(c, instance.componentProperties));

// 4. Swap
instance.swapComponent(variant);
```

> **IMPORTANT LIMITATION:** `getAvailableLibraryComponentSetsAsync()` only returns component sets from libraries that are **already enabled** in the current file. If the user migrated to a new workspace but hasn't enabled the new library, the API returns nothing. We must detect and communicate this to the user.

### Two-Level Matching Flow

```
Broken instance
├── instance.name = "Button"         → matches COMPONENT_SET name
└── instance.componentProperties = { State: "Default", Size: "Large" }
                                    → used to pick the right COMPONENT within the set
```

---

## 3. Our Improved Feature Set

We build a significantly more reliable and user-friendly version. Every improvement is justified by a real failure mode in the original.

### 3.1 Scan Scope Control
- Scan **selection only**, **current page**, or **all pages**
- Scan uses a non-blocking stack walk with yielding (never `findAll` which blocks on large files)

### 3.2 Multi-Strategy Matching Engine (Two-Level)

**Level 1: Match broken instance → component SET**

Strategy order (highest confidence first):

| Strategy | Method | Confidence |
|---|---|---|
| Exact name | `instance.name === set.name` | High |
| Path-normalized | Normalize slash spacing, underscores | High |
| Suffix strip | Strip known variant suffixes from instance name | Medium |
| Fuzzy token | Precomputed token index, 60% overlap threshold | Low |
| Manual | User picks from a search picker | User-confirmed |

**Level 2: Match component set → specific variant**

Once the set is identified and imported, find the right variant:
1. Build a properties string from `instance.componentProperties` (e.g. `"State=Default, Size=Large"`)
2. Find the child COMPONENT whose name matches that properties string
3. If no exact match, pick the `defaultVariant`
4. Flag as "partial" if we fell back to default

### 3.3 Preview Before Apply (Diff View)

Before any change is made:

```
COMPONENT SET              VARIANT           LIBRARY        CONFIDENCE
──────────────────────────────────────────────────────────────────────
☑ Button (×15)            State=Default     Design System   ●
☑ Icon/Arrow/Right (×12)  (single variant)  Icon Kit        ●
☑ Card/Feature (×1)       (default)         Design System   ◐
☐ Old/Chip (×2)           → Chip (fuzzy)    Design System   ○
─  Badge (×2)             no match found     —               ✗
```

User can:
- Deselect individual rows
- Click a no-match row's "Choose…" inline search picker to manually assign
- "Enable high" or "Enable high + medium" quick-action buttons

### 3.4 Parallel Scan + Library Fetch

Both the document scan and library component fetch begin simultaneously when the user clicks "Scan". By the time the scan finishes, the library list is usually ready too — eliminating the freeze between Step 1 and Step 2.

```js
const [scanResult, libraryResult] = await Promise.all([
  scanBrokenInstances(scope),
  fetchLibraryComponentSets(),
]);
```

### 3.5 Batch Processing with Real Progress + Cancellation

- Import component sets in parallel batches of **IMPORT_BATCH = 15** (consistent with figlink)
- Apply swaps sequentially, yielding every 5 operations
- Stream progress as unsolicited messages from code.js to UI (see Section 4 — Progress Protocol)
- A `cancelled` flag can be set by the UI to abort mid-operation

### 3.6 Results Summary

After completion:
- ✅ X instances successfully relinked
- ⚠️ Y instances partially matched (fell back to defaultVariant — may need manual variant selection)
- ✗ Z instances failed

For failed instances: a "Select failures" button navigates to the page containing the most failures and selects those nodes. (Cross-page selection is not possible in Figma; we navigate to the right page first.)

### 3.7 Plan Detection + Graceful Degradation

Wrap `getAvailableLibraryComponentSetsAsync` in a try/catch. If it throws or returns empty:
1. First try local file — scan `figma.root` for local COMPONENT nodes that could be matches
2. Show a banner: "No connected libraries found. Make sure your library is enabled in Assets → Libraries, or check your Figma plan."
3. Still show local-only matches in the review table, clearly marked as "Local"

### 3.8 Multi-Library Support

All connected libraries are searched in one operation. The match table shows which library each match comes from. If two libraries have a component set with the same name, both appear as separate candidate rows for the user to choose between.

---

## 4. Technical Architecture

### File Structure

```
figma-relinker/
├── manifest.json
├── code.js          — plugin main thread (Figma API)
└── ui.html          — plugin UI (inline CSS + JS, no build step)
```

No TypeScript, no bundler — consistent with the figlink codebase pattern.

### manifest.json

```json
{
  "name": "Figma Relinker",
  "id": "figma-relinker-001",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "permissions": ["teamlibrary"]
}
```

### Plugin Dimensions

- Width: **460px** (420 was too narrow for the match table — needs room for instance name + arrow + component name + library + confidence dot)
- Height: auto-resizes via ResizeObserver + max-height scroll region for the match table

### Message Protocol

Same request/response pattern as figlink for most commands. Progress uses **unsolicited messages** (no `id` field):

```
// Request/response (standard):
UI → code.js:   { id: 'abc', command: 'scan_broken_instances', params: { scope: 'page' } }
code.js → UI:   { id: 'abc', result: { groups: [...] } }

// Progress (unsolicited — sent DURING a long-running command):
code.js → UI:   { type: 'scan_progress', scanned: 1200, found: 14 }
code.js → UI:   { type: 'apply_progress', processed: 47, total: 120 }

// Cancellation (UI → code.js, no id needed):
UI → code.js:   { type: 'cancel' }
```

The UI postMessage handler checks for `type` on messages that lack an `id` and routes them to the progress bar.

### Commands

| Command | Params | Returns |
|---|---|---|
| `scan_and_fetch` | `{ scope: 'selection'\|'page'\|'all' }` | `{ groups: InstanceGroup[], sets: LibrarySet[], localComponents: LocalComp[] }` |
| `apply_relinks` | `{ matches: Match[] }` | `{ ok, partial, failed, failedGroups }` |
| `import_set` | `{ key: string }` | `{ variants: Variant[] }` |
| `select_nodes_on_page` | `{ pageId: string, nodeIds: string[] }` | `{ ok: true }` |

> Note: `scan_and_fetch` replaces the original two-command approach (`scan_broken_instances` + `get_library_components`). Running them in parallel inside one command handler eliminates the inter-step delay.

### Data Types

```js
// InstanceGroup — broken instances grouped by component set name
{
  name: string,              // component SET name (what instance.name holds)
  instanceIds: string[],     // all instance node IDs with this name
  componentProperties: object|null, // sample properties from first instance (for variant matching)
  pageIds: string[],         // which pages these instances live on
  pageNames: string[],
}

// LibrarySet — from getAvailableLibraryComponentSetsAsync
{
  key: string,
  name: string,              // component SET name
  libraryName: string,
}

// LocalComp — from scanning figma.root for COMPONENT nodes
{
  id: string,
  name: string,              // individual component name (may include variant string)
  setName: string | null,    // parent COMPONENT_SET name if inside a set
}

// Match — what the UI builds and sends back for apply
{
  instanceName: string,             // the group name (= component set name)
  instanceIds: string[],
  targetSetKey: string | null,      // library set key to import
  targetLocalId: string | null,     // OR a local component ID (mutually exclusive)
  libraryName: string | null,
  confidence: 'high' | 'medium' | 'low' | 'manual',
  enabled: boolean,
}
```

### Scan Command — Non-blocking Stack Walk

`findAll` is synchronous and blocks the Figma thread for 2–5+ seconds on files with 50K+ nodes. We use a manual stack walk with periodic async yielding instead:

```js
async function scanBrokenInstances(scope) {
  let cancelled = false;
  const roots = getRoots(scope); // [figma.currentPage] or figma.root.children
  const groups = new Map(); // name → { instanceIds, componentProperties, pageIds, pageNames }

  for (const root of roots) {
    const pageId = root.id;
    const pageName = root.name;
    const stack = [root];
    let count = 0;

    while (stack.length > 0) {
      if (cancelled) return { cancelled: true, groups: [...groups.values()] };

      const node = stack.pop();
      count++;

      // Yield every 500 nodes (more frequent than figlink's 1000 — instances are expensive to check)
      if (count % 500 === 0) {
        figma.ui.postMessage({ type: 'scan_progress', scanned: count, found: groups.size });
        await new Promise(r => setTimeout(r, 0));
      }

      if (node.type === 'INSTANCE' && node.mainComponent === null) {
        const name = node.name;
        if (!groups.has(name)) {
          groups.set(name, {
            name,
            instanceIds: [],
            componentProperties: node.componentProperties || null,
            pageIds: [],
            pageNames: [],
          });
        }
        const g = groups.get(name);
        g.instanceIds.push(node.id);
        if (!g.pageIds.includes(pageId)) {
          g.pageIds.push(pageId);
          g.pageNames.push(pageName);
        }
      }

      // Push children — even into instances (broken nested instances still need relinking)
      if ('children' in node) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }
  }

  return { groups: [...groups.values()] };
}

function getRoots(scope) {
  if (scope === 'selection') {
    const sel = figma.currentPage.selection;
    return sel.length > 0 ? sel : [figma.currentPage];
  }
  if (scope === 'all') return figma.root.children; // all pages
  return [figma.currentPage];
}
```

> Yield frequency: every 500 nodes (not 1000 like figlink) because checking `node.mainComponent` is heavier than simple property reads.

### Library Fetch Command

```js
async function fetchLibraryComponentSets() {
  const sets = [];
  try {
    const raw = await figma.teamLibrary.getAvailableLibraryComponentSetsAsync();
    for (const s of raw) {
      sets.push({ key: s.key, name: s.name, libraryName: s.libraryName });
    }
  } catch (e) {
    console.warn('[Relinker] teamLibrary unavailable:', e.message);
    // Return empty — caller will fall back to local-only
  }

  // Also collect local COMPONENT nodes (for local-to-local relinking)
  const localComps = [];
  for (const page of figma.root.children) {
    for (const node of page.children) {
      collectLocalComponents(node, localComps);
    }
  }

  return { sets, localComps };
}

function collectLocalComponents(node, out) {
  if (node.type === 'COMPONENT') {
    const parent = node.parent;
    out.push({
      id: node.id,
      name: node.name,
      setName: parent && parent.type === 'COMPONENT_SET' ? parent.name : null,
    });
  }
  if ('children' in node) {
    for (const child of node.children) collectLocalComponents(child, out);
  }
}
```

### Matching Algorithm — Two-Level, Pre-indexed

Run entirely in code.js after `scan_and_fetch` returns. Pure functions — independently testable.

```js
// ── Utility ──────────────────────────────────────────────────────────────────

function normalizeName(name) {
  return name
    .replace(/\s*\/\s*/g, '/')
    .replace(/_/g, '/')
    .toLowerCase()
    .trim();
}

function stripVariantSuffix(name) {
  const parts = name.split('/');
  const VARIANT_WORDS = /^(default|primary|secondary|sm|md|lg|true|false|on|off|light|dark|\d+)$/i;
  if (parts.length > 1 && VARIANT_WORDS.test(parts[parts.length - 1].trim())) {
    return parts.slice(0, -1).join('/');
  }
  return name;
}

// Pre-build token index for O(1) lookup during fuzzy pass
function buildTokenIndex(sets) {
  const index = new Map(); // token → Set<LibrarySet>
  for (const s of sets) {
    const tokens = s.name.toLowerCase().split(/[\/\s_-]+/);
    for (const t of tokens) {
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(s);
    }
  }
  return index;
}

function bestFuzzyMatch(name, sets, tokenIndex) {
  const tokens = name.toLowerCase().split(/[\/\s_-]+/);
  const candidates = new Map(); // set → overlap count
  for (const t of tokens) {
    const matches = tokenIndex.get(t);
    if (!matches) continue;
    for (const s of matches) {
      candidates.set(s, (candidates.get(s) || 0) + 1);
    }
  }
  let best = null, bestScore = 0;
  for (const [s, overlap] of candidates) {
    const compTokens = s.name.toLowerCase().split(/[\/\s_-]+/);
    const score = overlap / Math.max(tokens.length, compTokens.length);
    if (score > bestScore && score >= 0.6) { bestScore = score; best = s; }
  }
  return best;
}

// ── Main match function ───────────────────────────────────────────────────────

function matchGroups(instanceGroups, librarySets, localComps) {
  // Build lookup maps — O(n) upfront, O(1) per lookup
  const byExact   = new Map(); // lowercased name → LibrarySet
  const byNorm    = new Map(); // normalized name → LibrarySet
  const tokenIdx  = buildTokenIndex(librarySets);

  for (const s of librarySets) {
    const lower = s.name.toLowerCase();
    const norm  = normalizeName(s.name);
    if (!byExact.has(lower)) byExact.set(lower, s);
    if (!byNorm.has(norm))   byNorm.set(norm, s);
  }

  // Local component index
  const localBySetName = new Map(); // set name lower → LocalComp[]
  for (const c of localComps) {
    const key = (c.setName || c.name).toLowerCase();
    if (!localBySetName.has(key)) localBySetName.set(key, []);
    localBySetName.get(key).push(c);
  }

  const matches = [];

  for (const group of instanceGroups) {
    const name   = group.name;
    const lower  = name.toLowerCase();
    const norm   = normalizeName(name);
    const suffix = stripVariantSuffix(name).toLowerCase();

    let target = null, confidence = null, isLocal = false;

    // Strategy 1: exact library name
    if ((target = byExact.get(lower))) { confidence = 'high'; }
    // Strategy 2: normalized library name
    else if ((target = byNorm.get(norm))) { confidence = 'high'; }
    // Strategy 3: suffix-stripped library name
    else if ((target = byExact.get(suffix) || byNorm.get(normalizeName(suffix)))) { confidence = 'medium'; }
    // Strategy 4: fuzzy (uses pre-built token index — O(tokens) not O(sets))
    else if ((target = bestFuzzyMatch(name, librarySets, tokenIdx))) { confidence = 'low'; }
    // Strategy 5: local component fallback
    else {
      const locals = localBySetName.get(lower) || localBySetName.get(norm);
      if (locals && locals.length > 0) {
        target = locals[0]; // will use targetLocalId path
        confidence = 'high';
        isLocal = true;
      }
    }

    matches.push({
      instanceName: name,
      instanceIds: group.instanceIds,
      componentProperties: group.componentProperties,
      pageIds: group.pageIds,
      pageNames: group.pageNames,
      targetSetKey: (!isLocal && target) ? target.key : null,
      targetLocalId: (isLocal && target) ? target.id : null,
      libraryName: isLocal ? 'Local' : (target ? target.libraryName : null),
      confidence,
      enabled: confidence === 'high' || confidence === 'medium',
    });
  }

  return matches;
}
```

### Apply Relinks — Two-Level with Variant Resolution

```js
// Shared cancel flag — set to true by the 'cancel' message handler
let _cancelled = false;

// IMPORT_BATCH: consistent with figlink codebase
const IMPORT_BATCH = 15;

async function applyRelinks(matches) {
  _cancelled = false;
  const results = { ok: 0, partial: 0, failed: 0, failedGroups: [] };

  // Phase 1: Pre-import all needed component sets (deduplicated, batched, parallel)
  const uniqueSetKeys = [...new Set(
    matches.filter(m => m.enabled && m.targetSetKey).map(m => m.targetSetKey)
  )];
  const keyToSet = {};

  for (let i = 0; i < uniqueSetKeys.length; i += IMPORT_BATCH) {
    if (_cancelled) return { ...results, cancelled: true };
    const batch = uniqueSetKeys.slice(i, i + IMPORT_BATCH);
    await Promise.all(batch.map(async (key) => {
      try { keyToSet[key] = await figma.importComponentSetByKeyAsync(key); }
      catch (e) { keyToSet[key] = null; }
    }));
    figma.ui.postMessage({ type: 'apply_progress', phase: 'importing', done: i + batch.length, total: uniqueSetKeys.length });
  }

  // Phase 2: Apply swaps
  let processed = 0;
  const total = matches.reduce((sum, m) => sum + (m.enabled ? m.instanceIds.length : 0), 0);

  for (const match of matches) {
    if (!match.enabled) continue;
    if (_cancelled) return { ...results, cancelled: true };

    for (const instanceId of match.instanceIds) {
      const node = figma.getNodeById(instanceId);
      if (!node || node.type !== 'INSTANCE') {
        results.failed++;
        continue;
      }

      try {
        let targetComponent = null;

        if (match.targetSetKey) {
          const set = keyToSet[match.targetSetKey];
          if (!set) throw new Error('Set import failed');
          targetComponent = findVariantInSet(set, match.componentProperties);
          if (targetComponent.isDefault) results.partial++;
        } else if (match.targetLocalId) {
          targetComponent = { node: figma.getNodeById(match.targetLocalId), isDefault: false };
          if (!targetComponent.node) throw new Error('Local component not found');
        }

        if (!targetComponent || !targetComponent.node) throw new Error('No target component');

        node.swapComponent(targetComponent.node);
        if (!targetComponent.isDefault) results.ok++;

      } catch (e) {
        results.failed++;
        if (!results.failedGroups.find(g => g.name === match.instanceName)) {
          results.failedGroups.push({ name: match.instanceName, error: e.message });
        }
      }

      processed++;
      if (processed % 5 === 0) {
        figma.ui.postMessage({ type: 'apply_progress', phase: 'relinking', done: processed, total });
        await new Promise(r => setTimeout(r, 0)); // yield
      }
    }
  }

  return results;
}

// Find the best variant component within an imported set, using componentProperties as the key
function findVariantInSet(set, componentProperties) {
  if (!set.children || set.children.length === 0) {
    return { node: set, isDefault: true };
  }

  if (!componentProperties || Object.keys(componentProperties).length === 0) {
    return { node: set.defaultVariant || set.children[0], isDefault: true };
  }

  // Build a properties string to match against variant names like "State=Default, Size=Large"
  // componentProperties format: { State: { type: 'VARIANT', value: 'Default' }, ... }
  const wantedPairs = Object.entries(componentProperties)
    .filter(([, v]) => v && v.type === 'VARIANT')
    .map(([k, v]) => `${k}=${v.value}`);

  // Find the variant whose name contains ALL of the wanted property pairs
  const exactMatch = set.children.find(c =>
    c.type === 'COMPONENT' &&
    wantedPairs.every(pair => c.name.includes(pair))
  );

  if (exactMatch) return { node: exactMatch, isDefault: false };

  // Fall back to default variant and flag as partial
  return { node: set.defaultVariant || set.children[0], isDefault: true };
}
```

### Select Nodes Cross-Page

Figma does not allow selecting nodes on a non-current page. Workaround:

```js
async function selectNodesOnPage(pageId, nodeIds) {
  // Navigate to the target page first
  const page = figma.root.children.find(p => p.id === pageId);
  if (!page) throw new Error(`Page ${pageId} not found`);
  figma.currentPage = page;

  // Now select the nodes
  const nodes = nodeIds.map(id => figma.getNodeById(id)).filter(Boolean);
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
  return { ok: true, pageId, selected: nodes.length };
}
```

When multiple failed pages exist, navigate to the page with the most failures first and inform the user in the UI: "Navigated to page 'Flows' (2 of 3 pages with failures)."

### Cancellation Handler

```js
figma.ui.onmessage = async (msg) => {
  // Cancellation — unsolicited, no id
  if (msg.type === 'cancel') {
    _cancelled = true;
    return;
  }

  const { id, command, params } = msg;
  try {
    const result = await handleCommand(command, params || {});
    figma.ui.postMessage({ id, result });
  } catch (err) {
    figma.ui.postMessage({ id, error: err.message });
  }
};
```

### groupBy Helper (defined, not assumed)

```js
function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
```

---

## 5. UX Design — Norman's 10 Heuristics Applied

### H1: Visibility of System Status

- Plugin opens immediately to the Scan button — no blank state
- During scan: animated spinner + "Scanning… X nodes checked, Y broken found" (updated every 500 nodes via progress messages)
- During library fetch (parallel with scan): "Loading libraries…" shown as a secondary label, resolves silently when ready
- During import phase: "Importing X / Y component sets…"
- During apply phase: progress bar "Relinking 47 / 120 instances…"
- After completion: always show a summary screen — never silently close
- Results timestamp: "Scan from 2:34 PM" with "Re-scan" button — no attempt to auto-detect file changes (Figma has no file-change event)

### H2: Match Between System and Real World

- Use "broken" not "null mainComponent" — designers know "broken link"
- Use "library" not "importable node set"  
- Use "Relink" not "Swap" — matches what Figma says ("This instance is not linked to any component")
- Show component SET name in the table (what the instance actually shows as its name)
- Show library name always, alongside component set name
- Count humanly: "47 broken instances across 2 pages" not "47 INSTANCE nodes with null mainComponent"

### H3: User Control and Freedom

- Preview step is mandatory — no skip-to-apply path
- User can deselect any row in the review table
- **Back button preserves scan results** — going back to Step 1 shows the previous scan result badge ("Last scan: 47 instances") and lets user change scope and re-scan. Scan results are NOT re-run automatically on Back.
- Cancel button always visible during scan/apply with the label "Cancel" (not "X")
- After apply, Cmd+Z undoes all swaps (swapComponent is natively undoable) — document this in the UI footer
- "Select failures" navigates to the page and selects failed nodes (with clear page-navigation feedback)

### H4: Consistency and Standards

- Visual design: dark theme matching figlink (#141414 bg-canvas, #1a1a1a bg-panel, #f59e0b accent)
- "Relink" verb matches Figma's own language
- Keyboard: Enter = apply/confirm, Escape = cancel, Space = toggle row, Tab = navigate rows
- Footer: same brand pattern as figlink (version + social links)
- Match table uses the same border and color tokens as figlink panels
- No modal dialogs — all feedback is inline

### H5: Error Prevention

- Mandatory preview before any changes
- Fuzzy (low-confidence) rows are **deselected by default**
- Warn inline on rows where component structure likely changed: "⚠ Property count differs — variant selection may be imprecise"
- "Apply" button disabled until at least one row is enabled
- Clear empty state if 0 broken instances found — never show an empty table
- If library is empty (no connected libraries): show warning BEFORE matching, not after

### H6: Recognition Over Recall

- Full component set name always shown — never just key or ID
- Library name always shown inline in muted color
- Broken instance count per group (×15) so user sees scope at a glance
- Page names shown in a secondary line when groups span multiple pages
- Confidence: colored dot (●◐○✗) with tooltip on hover — no need to read a label
- Step indicator at top shows current step (1 → 2 → 3) so user always knows where they are

### H7: Flexibility and Efficiency

- Scope selector: Selection / Page / All Pages
- **"Enable High"** button — ticks all high-confidence rows
- **"Enable High + Medium"** button — ticks all non-fuzzy rows (power users who trust their naming)
- Filter field above match table to search by component name or library
- "Copy report" exports the match table as a plain-text summary (format: `- ✅ Button ×15 → Button (Design System)`)
- Keyboard navigation through rows
- After apply, "Scan again" resets to Step 1 with the same scope pre-selected

### H8: Aesthetic and Minimalist Design

- Three-step flow (Scan → Review → Apply) — Step 2 UI is never shown until Step 1 is complete
- No settings panel — all options are contextually placed
- Plugin width 460px — comfortable for the table without being wide
- Match table max-height with scroll — never forces the plugin to expand beyond 600px
- Confidence dot is the only affordance — label text appears on tooltip, not inline
- Library name is muted (#888) so component name reads first
- Step 3 result screen is minimal: counts, action buttons, nothing else

### H9: Help Users Recognize, Diagnose, and Recover from Errors

- "No broken instances found" → "All instances may already be correctly linked. Try 'All Pages' scope or check that you're in the right file."
- "No libraries connected" → "Make sure your library file is enabled in the Assets panel (Shift+I → Libraries), then Re-scan."
- "Import failed for [Name]" → "The library may have been unpublished or you may lack access. Ask the library owner to re-publish, then Re-scan."
- "X instances could not be relinked" → "Select failures" button + page navigation
- "Relink complete" even with failures — always show counts, never just "done"
- All errors use amber (#f59e0b) banner, not modal interruptions

### H10: Help and Documentation

- Tooltip on "Confidence" column header: "High = exact name match. Medium = name normalized or suffix stripped. Low = approximate match — verify before applying."
- Tooltip on scope selector: "All Pages will scan every page in the document, including hidden ones."
- Inline guidance in no-library empty state (not a separate help modal)
- First-run tip shown only in the zero-instance empty state
- "Cmd+Z to undo all relinks" noted in the Step 3 result screen

---

## 6. Three-Step UI Flow

### Step 1: Scan

```
┌──────────────────────────────────────────────────┐
│  Figma Relinker                      ① → ② → ③  │
│  ──────────────────────────────────────────────  │
│                                                  │
│  Scope:  ○ Selection  ● Page  ○ All Pages       │
│                                                  │
│  [ Scan for broken instances ]                   │
│                                                  │
│  Broken instances are ones where the main        │
│  component is no longer accessible in any        │
│  connected library.                              │
│                                                  │
│  ──────────────────────────────────────────────  │
│  v1.0  |  @danielfransix  |  ☕ Buy me a coffee  │
└──────────────────────────────────────────────────┘

[During scan — same screen, button replaced:]

│  ● Scanning…  1,240 nodes · 14 broken found      │
│  ◌ Loading libraries…                            │
│  [ Cancel ]                                      │
```

### Step 2: Review Matches

```
┌──────────────────────────────────────────────────┐
│  ← Back   47 broken instances · 5 groups ① ②→③  │
│  ──────────────────────────────────────────────  │
│                                                  │
│  [Filter by name or library…    ]                │
│  [ Enable High ] [ Enable High + Medium ]        │
│                                                  │
│  ☑  Button ×15       → Button · Design System  ● │
│     Pages: Flows, Components                     │
│  ☑  Icon/Arrow ×20   → Icon/Arrow · Icons      ● │
│  ☑  Card/Feature ×1  → Card/Feature · DS       ◐ │
│  ☐  Old/Chip ×2      → Chip · DS (fuzzy)       ○ │
│  ─  Badge ×9         → no match   [Choose…]   ✗  │
│                                                  │
│  [ Relink 4 groups · 38 instances ]              │
│  [ Cancel ]                                      │
│  ──────────────────────────────────────────────  │
│  v1.0  |  @danielfransix  |  ☕ Buy me a coffee  │
└──────────────────────────────────────────────────┘
```

Notes on the table:
- Page names shown as secondary line under groups that span multiple pages
- "Choose…" opens an inline search field on that row (not a modal)
- The table has `max-height: 320px; overflow-y: auto` so the plugin never exceeds ~600px
- Each row is 48px tall — enough for name + page subline

### Step 3: Apply + Result

```
[During apply:]
│  ▸ Importing 8 / 4 component sets…              │
│  ████████░░░░░░░░  Relinking 47 / 120…           │
│  [ Cancel ]                                      │

[Result:]
┌──────────────────────────────────────────────────┐
│  Done                                 ① → ② → ③  │
│  ──────────────────────────────────────────────  │
│                                                  │
│  ✅  38  instances relinked                      │
│  ⚠    2  variant fell back to default            │
│  ✗    7  failed — no matching component          │
│                                                  │
│  Cmd+Z / Ctrl+Z to undo all relinks.             │
│                                                  │
│  [ Select 7 failures in canvas ]                 │
│  [ Copy report ]                                 │
│  [ Scan again ]                                  │
│  ──────────────────────────────────────────────  │
│  v1.0  |  @danielfransix  |  ☕ Buy me a coffee  │
└──────────────────────────────────────────────────┘
```

---

## 7. Edge Cases and Failure Modes

| Scenario | Handling |
|---|---|
| Instance is inside another instance | Stack walk recurses into all children including instance children — found |
| Broken instance inside a locked layer | `swapComponent` throws → caught → added to failedGroups |
| Component SET exists locally AND in a library | Local match shown as "Local" source; library match shown separately; user picks |
| Two libraries have sets with the same name | Both appear as rows in the match table — user picks |
| Library not enabled for this file | `getAvailableLibraryComponentSetsAsync` returns empty → banner shown: "Enable your library in Assets → Libraries, then Re-scan" |
| Starter plan | Same as above — teamLibrary may throw; wrapped in try/catch; local-only fallback |
| File with 100K+ nodes | Yielding stack walk every 500 nodes; cancel available; upfront warning if >1000 broken instances |
| 500 broken instances → postMessage too large | Groups are deduplicated before sending (send InstanceGroup[] not raw instances). A group with 500 instances of "Button" is one object, not 500 |
| Instance name has special characters or emoji | Unicode-safe `.toLowerCase()` only — no regex over content |
| Mixed pages (some have no broken instances) | Pages with 0 broken instances are never added to pageIds — skip silently |
| Variant overrides not preserved after swap | `findVariantInSet` marks as `isDefault: true` → counted as "partial" in results |
| Nested broken instances (instance inside broken instance) | Stack walk visits all children, so both the outer and inner broken instances are found and processed independently |
| User cancels mid-apply | `_cancelled` flag → partial results returned with `cancelled: true` → UI shows how many were completed before cancel |
| "Select failures" — failures on multiple pages | Navigate to page with most failures first; UI shows "Page 1 of 3" with a "Next page" button |
| User hits Back during scan | Cancel current scan (set _cancelled), restore previous scan result in Step 1 badge |

---

## 8. Efficiency Patterns — Full Reference

### Pattern 1: Non-blocking Stack Walk with Progress Emit

Used for the scan. Critical for large files. Yield every 500 nodes (more frequent than figlink's 1000 because `mainComponent` access is heavier than property reads):

```js
let count = 0;
while (stack.length) {
  const node = stack.pop();
  count++;
  if (count % 500 === 0) {
    figma.ui.postMessage({ type: 'scan_progress', scanned: count, found: groups.size });
    await new Promise(r => setTimeout(r, 0));
  }
  // ...process node
}
```

### Pattern 2: Parallel Scan + Library Fetch

Never wait for one before starting the other:

```js
const [scanResult, libResult] = await Promise.all([
  scanBrokenInstances(scope),
  fetchLibraryComponentSets(),
]);
```

### Pattern 3: Batched Parallel Async Imports (IMPORT_BATCH = 15)

Consistent with figlink. Parallelizes network calls without overwhelming the API:

```js
const IMPORT_BATCH = 15;
for (let i = 0; i < keys.length; i += IMPORT_BATCH) {
  await Promise.all(keys.slice(i, i + IMPORT_BATCH).map(async (key) => {
    try { result[key] = await figma.importComponentSetByKeyAsync(key); }
    catch { result[key] = null; }
  }));
}
```

### Pattern 4: Import Deduplication Before Batching

Deduplicate before any network call — 500 instances of "Button" still only import the "Button" set once:

```js
const uniqueSetKeys = [...new Set(matches.filter(m => m.enabled && m.targetSetKey).map(m => m.targetSetKey))];
```

### Pattern 5: Pre-built Token Index for Fuzzy Matching

O(1) candidate lookup instead of O(n) per name. Built once from the library set list, reused for all groups:

```js
const tokenIndex = buildTokenIndex(librarySets); // O(total tokens in all set names)
// Per-group fuzzy match: O(tokens in group name) not O(number of library sets)
```

### Pattern 6: Group Before Sending (Prevents postMessage Overflow)

Never send raw instance arrays across postMessage. Group first:
- 500 broken "Button" instances → 1 InstanceGroup object with 500 IDs
- A file with 5000 broken instances → maybe 30 InstanceGroup objects
- Payload stays small regardless of instance count

### Pattern 7: Error Isolation Per Instance

Each `swapComponent` is individually try/caught. One locked layer doesn't abort the entire batch:

```js
for (const instanceId of match.instanceIds) {
  try { /* swap */ results.ok++; }
  catch (e) { results.failed++; results.failedGroups.push(...); }
}
```

### Pattern 8: Cancellation Flag

A module-level `_cancelled` boolean checked at the start of each batch iteration:

```js
let _cancelled = false;
// Set by: figma.ui.onmessage handler for { type: 'cancel' }
// Checked at: start of each import batch AND each swap iteration
if (_cancelled) return { ...results, cancelled: true };
```

### Pattern 9: Unsolicited Progress Messages

For streaming feedback from a long-running command without blocking the response:

```js
// During the async operation:
figma.ui.postMessage({ type: 'scan_progress', scanned: 1200, found: 14 });
figma.ui.postMessage({ type: 'apply_progress', phase: 'importing', done: 3, total: 8 });

// After operation completes, send the final response with the original id:
figma.ui.postMessage({ id, result: { ok: 38, partial: 2, failed: 7 } });
```

UI side routes messages by checking `id` vs `type`:

```js
window.onmessage = ({ data }) => {
  const msg = data?.pluginMessage;
  if (!msg) return;
  if (msg.id) {
    // Resolve promise for this command
    resolvers.get(msg.id)?.(msg);
  } else if (msg.type === 'scan_progress') {
    updateScanProgress(msg);
  } else if (msg.type === 'apply_progress') {
    updateApplyProgress(msg);
  }
};
```

### Pattern 10: Auto-Resize UI

Same pattern as figlink — content-hugging height, max 600px with internal scroll on the match table:

```js
const ro = new ResizeObserver(() => {
  const h = Math.min(document.body.offsetHeight, 600);
  parent.postMessage({ pluginMessage: { type: 'resize', height: h } }, '*');
});
ro.observe(document.body);
```

### Pattern 11: URL Allowlist for External Links

```js
const ALLOWED_URLS = [
  'https://x.com/danielfransix',
  'https://danielfransix.short.gy/buy-coffee',
];
if (ALLOWED_URLS.includes(msg.url)) figma.openExternal(msg.url);
```

---

## 9. Implementation Sequence

Each step is independently testable before moving to the next:

1. **Scaffold** — `manifest.json`, empty `code.js` with one command, minimal `ui.html` Scan button
2. **Stack walk scan** — implement `scanBrokenInstances` with yielding; test on a large file; verify progress messages fire
3. **Library fetch** — implement `fetchLibraryComponentSets`; verify correct API call and local fallback
4. **Parallel scan + fetch** — combine into `scan_and_fetch` command with `Promise.all`; verify both complete
5. **Matching engine** — implement `matchGroups` with token index; test all 5 strategies with mock data
6. **Variant resolution** — implement `findVariantInSet`; test with a component set that has multiple variants
7. **Review UI** — render match table; enable/disable toggles; "Enable High", "Enable High + Medium"; filter; "Choose…" picker
8. **Apply + progress** — implement `applyRelinks` with two phases; wire progress messages to UI progress bar; test cancellation
9. **Result UI** — result screen with counts, "Select failures" (with page nav), "Copy report", "Scan again"
10. **Polish** — step indicators, transitions, keyboard navigation, max-height scroll on table, resize observer cap
11. **Edge cases** — no-library banner, Starter plan fallback, 0-results empty state, >1000 instance warning, Back button state restore, cross-page failure navigation

---

## 10. What We Are NOT Building (Scope Boundaries)

- **Not a "replace component" tool** — we only fix broken links, not intentional swaps
- **Not a variable/style relinker** — out of scope (follow-up plugin)
- **Not a cross-plugin sync tool** — standalone dialog plugin, no WebSocket server
- **Not a diff visualizer** — we show names and counts, not thumbnail previews of old vs new
- **Not an auto-run/background mode** — user always initiates

---

## Changelog

**QA pass 2026-06-29 — 16 issues found and patched:**

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | Critical | `getAvailableLibraryComponentsAsync()` doesn't exist | Corrected to `getAvailableLibraryComponentSetsAsync()`; added library-not-enabled handling |
| 2 | Critical | "All Pages" scan used `figma.currentPage.findAll()` | `getRoots()` helper now returns `figma.root.children` for "all" scope |
| 3 | Critical | `groupBy` helper used but never defined | Added definition in Section 4 |
| 4 | Critical | Progress callback couldn't work in postMessage pattern | Defined unsolicited message protocol in Section 4 + Pattern 9 |
| 5 | Efficiency | `findAll` blocks on large files | Replaced with yielding stack walk (every 500 nodes) throughout |
| 6 | Efficiency | Fuzzy match was O(n×m) | Replaced with pre-built token index — O(tokens) per lookup |
| 7 | Efficiency | postMessage could overflow on 5000+ instances | Scan now groups before sending (InstanceGroup[], not raw nodes) |
| 8 | Efficiency | Library fetch blocked UI transition to Step 2 | `scan_and_fetch` runs both in parallel via `Promise.all` |
| 9 | Efficiency | No cancellation path | Added `_cancelled` flag + cancel message handler |
| 10 | Efficiency | Batch size inconsistency (20/10/15) | Unified to `IMPORT_BATCH = 15` everywhere |
| 11 | UX | Back button state undefined | Documented: scan results preserved in memory, not re-run on Back |
| 12 | UX | No-match rows had no resolution path | Added inline "Choose…" search picker per row |
| 13 | UX | Stale scan detection impossible | Removed; replaced with timestamp + "Re-scan" label |
| 14 | UX | 420px too narrow for match table | Changed to 460px |
| 15 | UX | Instance name ≠ component name for variant instances | Documented two-level matching (set name → variant via componentProperties) |
| 16 | UX | `select_nodes` fails cross-page | Added `selectNodesOnPage` which navigates page first |

---

Sources:
- [Component Relinker on Figma Community](https://www.figma.com/community/plugin/981892464363185469/component-relinker)
- [Figmaelements.com — Component Relinker](https://figmaelements.com/plugins/component-relinker/)
- [figma.teamLibrary API docs](https://www.figma.com/plugin-docs/api/figma-teamlibrary/)
- [Figma Forum — Bulk relink component instances](https://forum.figma.com/t/bulk-relink-component-instances/1762)
- [Figma Forum — Relink instances to duplicated components from a new file](https://forum.figma.com/t/relink-instances-to-duplicated-components-from-a-new-file/28683)
- [InstaRelinker (alternative plugin)](https://www.figma.com/community/plugin/1047874318864404919/instarelinker)
- figlink-by-danielfransix codebase (batch/yield patterns, architecture conventions)
