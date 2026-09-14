# Figma Connector Plugin — Implementation Plan

**Folder:** `figma-connector/` (new sibling folder in `c:\Github Repos\figma-plugins\`, alongside `figma-selector`, `figma-relinker`, etc.)
**Plugin name:** "Figma Connector" (easy to rename later)
**Date:** 2026-09-13

---

## 1. Context

Daniel uses Figma's native **Connector** (sticky arrow) object to show developers how screens/flows link together. The connector is genuinely sticky — once both ends are attached to nodes, it stays attached as those nodes move. The pain point is entirely in the *setup*: manually dragging each end onto its target every time a new connection is needed is slow and repetitive, especially across a large flow diagram with many screens.

Investigation confirmed this is solvable with the Plugin API: the object the user has selected (`node 4416:13306`, type `CONNECTOR`, in file `IYptRncGvctLie2oRm4Dbd`) is a first-class Figma node with `connectorStart`/`connectorEnd` properties that can be attached to any node by ID (`{ endpointNodeId, magnet: 'AUTO' }`). A plugin can automate exactly the manual step Daniel wants to skip: select two elements, run the plugin, get a properly-attached, correctly-styled connector between them.

This plan covers a small, self-contained plugin following the same conventions as Daniel's other tools in this repo (plain JS, no build step, dark-themed `ui.html`, `manifest.json` + `code.js` + `ui.html` flat structure).

### Feasibility QA — verified live against the actual file (not just docs)

Figma's own developer docs and forum posts state that `ConnectorNode`/`figma.createConnector()` are **FigJam-only** and blocked in Design-mode Plugin API. That's true, but it turned out to only block *creating a brand-new* connector — it does **not** block cloning an *existing* connector already in the file and reassigning its endpoints. I confirmed this directly by running real Plugin API code (via the official Figma MCP, `use_figma`) against the actual file and node in question (`IYptRncGvctLie2oRm4Dbd`, node `4416:13306`), rather than trusting docs alone:

| Test | Result |
|---|---|
| Clone the existing master `CONNECTOR` node | ✅ Succeeds |
| Reassign `connectorStart`/`connectorEnd` to `{ endpointNodeId, magnet: 'AUTO' }` on the clone, targeting top-level frames/sections | ✅ Succeeds |
| Attach to a plain node nested 6–7 levels deep (through frames/groups only, no instance involved) | ✅ Succeeds — nesting depth alone is not a problem |
| Attach to a `COMPONENT` `INSTANCE` node itself | ✅ Succeeds |
| Attach to **any node living inside a component instance's overridden subtree** (a direct child of an instance, at any depth) | ❌ Fails every time: `"in set_connectorStart: Invalid endpointNodeId"` — this is the **one real, precisely-identified restriction** |
| Attach to the `PAGE` node itself | ✅ "Succeeds" (no thrown error) — but is visually meaningless, so the plugin should still treat this as a failure case itself |
| Attach to a node on a **different page** than the connector | ✅ "Succeeds" (no thrown error) — the API does **not** enforce same-page; this must be validated by the plugin itself |
| Clear a connector's text label (`clone.text.characters = ''`) | ✅ Succeeds directly (master's label was already empty in this test — the plugin will still follow Figma's font-load-before-mutate recipe defensively for masters that do have label text) |

**Conclusions this changes in the plan below:**
- The clone-and-reassign approach is now a confirmed technique, not a bet — no `figma.createConnector()` needed anywhere.
- The "closest connectable parent" climbing logic has exactly one real trigger: a target node nested inside a component instance. Climbing up the parent chain (generic try/catch, climb on `"Invalid endpointNodeId"`) always succeeds by the time it reaches the instance root, since the instance itself is a valid endpoint.
- Because the API silently "accepts" both page-level and cross-page attachments without erroring, **the plugin must explicitly validate same-page itself** — this is application logic, not something the API enforces for us.
- No `"figjam"` entry needed in `editorType` — the whole flow works under a plain `editorType: ["figma"]` manifest, confirmed live.

---

## 2. Confirmed Behavior (from discussion)

- **Master-first workflow:** the plugin always starts by asking the user to select an existing connector on the canvas and designate it as the **master**. All connectors the plugin creates afterward are clones of that master (so styling — stroke, arrowheads, line type — matches exactly).
- **Master resets on close:** the master is held only in memory for the lifetime of the open plugin panel. Closing and reopening the plugin always returns to "select a master" — no `clientStorage`/`pluginData` persistence. This falls out naturally from Figma's plugin execution model (the JS context dies when the panel closes), so no extra code is needed to enforce it.
- **Same-page only:** both target elements must be on the current page (a `CONNECTOR` cannot span pages). This is already guaranteed by Figma's selection model (you can't multi-select across pages), but the plugin still validates defensively.
- **No selection-order logic:** Figma selection order isn't reliable, so the plugin does **not** try to infer which node is the "start." It attaches `connectorStart` to the first selected node and `connectorEnd` to the second, in whatever order `figma.currentPage.selection` returns them. If the arrowhead ends up backwards, the user flips it manually via the stroke panel (Figma's native "reverse" affordance) — no in-plugin fix needed.
- **Closest-connectable-parent fallback:** if a selected node itself can't be a connector endpoint, the plugin climbs `node.parent` until it finds one that works, and reports which parent it used. If it climbs all the way to the page with no success, it throws a clear, specific error instead of silently failing.
- **Label text is cleared on clone:** the master's styling (stroke, arrowhead caps, line type, color) is copied exactly, but any text label on the master is cleared on each new connector, since a label is normally specific to one connection, not shared across all of them.

---

## 3. File Structure (matches repo convention)

```
figma-connector/
├── manifest.json
├── code.js      — plugin backend (Figma API), plain JS, no build step
├── ui.html      — single-file UI (inline CSS + JS), dark theme, DM Sans + Cal Sans
└── PLAN.md      — this plan, copied into the folder for reference
```

No `package.json`, no TypeScript, no bundler — consistent with every other plugin in this repo (verified against `figma-selector`, `figma-relinker`, `figma-linter`, `instance-resetter`).

### manifest.json

```json
{
  "name": "Figma Connector",
  "id": "figma-connector-001",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"]
}
```

No `documentAccess: "dynamic-page"` — kept on the legacy sync model (like `figma-selector`/`figma-relinker`) so `figma.getNodeById` and `figma.currentPage.selection` stay synchronous. No special `permissions` needed (connectors don't require `teamlibrary` or similar), and no `"figjam"` needed in `editorType` — **confirmed live** that cloning/reassigning an existing connector works fine under a plain `editorType: ["figma"]` manifest, even though `figma.createConnector()` itself is FigJam-gated.

---

## 4. UI Flow — Two Steps, One Panel

The panel stays open across many "Connect" actions in one sitting — the user sets the master once, then repeatedly selects pairs of screens and clicks Connect without reopening anything.

### Step 1 — Set Master (shown on open, and whenever there's no master)

```
┌────────────────────────────────────┐
│  Figma Connector                    │
│  ──────────────────────────────────│
│                                      │
│  Select a connector on the canvas   │
│  to use as your master style.       │
│                                      │
│  Selected: (nothing selected)       │
│                                      │
│  [ Set as Master ]  (disabled)      │
│                                      │
└────────────────────────────────────┘
```

- Live-updates via `figma.on('selectionchange', ...)`, mirroring the status pattern already used in `figma-selector`/`figma-relinker`.
- "Set as Master" enables only when selection is exactly one `CONNECTOR` node; label shows its name.

### Step 2 — Connect (shown once a master is set)

```
┌────────────────────────────────────┐
│  Figma Connector                    │
│  ──────────────────────────────────│
│  Master: "Connector line"  [Change] │
│  ──────────────────────────────────│
│                                      │
│  Select two elements to connect.    │
│                                      │
│  Selected: 2 — "Screen A", "Screen B"│
│                                      │
│  [ Connect Selected ]                │
│                                      │
└────────────────────────────────────┘
```

- "Connect Selected" enables only when exactly 2 nodes are selected and neither is itself a `CONNECTOR`.
- "Change" resets `masterConnectorId` and returns to Step 1 without closing the panel.
- After a successful connect, the panel stays on Step 2 so the user can immediately select the next pair.

---

## 5. Core Logic (code.js)

See `code.js` in this folder for the implemented version. Summary of the approach:

- State is in-memory only (`masterConnectorId`) — no `clientStorage`/`pluginData`, so it resets naturally when the plugin closes.
- `figma.on('selectionchange', ...)` drives a live status message to the UI (`selection-status`) with counts, names, and flags the UI uses to enable/disable buttons.
- `handleSetMaster()` requires exactly one selected `CONNECTOR` node.
- `handleConnect()`:
  1. Re-validates the master still exists and is still a `CONNECTOR`.
  2. Requires exactly 2 selected nodes, neither of which is a `CONNECTOR`.
  3. Validates both selected nodes are on the same page as the connector-to-be (the API itself does not enforce this).
  4. Clones the master, appends it to the current page, clears its label (font-load-then-mutate recipe for non-empty labels).
  5. Calls `attachEndpoint()` for `connectorStart`/`connectorEnd` — tries the node itself first, climbs to `node.parent` on `"Invalid endpointNodeId"`, stops and fails at the page boundary.
  6. Selects the new connector afterward (one click away from a manual arrow-flip via the stroke panel).
  7. Notifies success (noting any climbed parents) or failure.

---

## 6. Error Messages (all via `figma.notify(..., { error: true })`)

| Condition | Message |
|---|---|
| "Set as Master" clicked without exactly 1 connector selected | "Select exactly one connector to use as the master." |
| "Connect" clicked before a master is set | (button is disabled in this state — not reachable) |
| Master node was deleted since being set | "Master connector no longer exists — set a new master." (auto-resets to Step 1) |
| Not exactly 2 nodes selected when clicking Connect | "Select exactly two elements to connect." |
| One of the 2 selected nodes is itself a connector | "Can't connect a connector to another connector." |
| A selected node and all its ancestors reject attachment | `Couldn't attach to "<name>" or any of its parents.` |

---

## 7. Edge Cases

| Scenario | Handling |
|---|---|
| Selected element is deeply nested via plain frames/groups (no instance involved) | **Confirmed live: works directly, no climbing needed** — tested to 7 levels deep |
| Node inside a component instance (any depth) | **Confirmed live: always fails with `"Invalid endpointNodeId"`.** Climbing reaches the instance root, which is confirmed to always succeed as an endpoint itself |
| Selected element IS a component instance (not a child of one) | **Confirmed live: works directly**, same as any other node |
| Two selected elements on different pages | Not possible via Figma's own multi-select UI, but defensively checked anyway — **confirmed live the raw API does NOT reject this itself**, so the plugin's own `findPage` check (Section 5) is what actually prevents a broken cross-page connector |
| Locked or hidden target node | Untested — lower priority than the cases above; if the API rejects it, the existing climb-on-`"Invalid endpointNodeId"` loop handles it the same way as any other rejection |
| User selects the master itself as one of the two endpoints | Blocked by the "can't connect a connector to another connector" check |
| Master deleted mid-session, then user clicks Connect | Detected via `figma.getNodeById` returning null; resets to Step 1 with a clear message |
| Plugin closed and reopened | Master resets to unset by design — no code needed, this is default behavior |
| Arrowhead ends up on the "wrong" side | Not handled by the plugin — user flips it via Figma's native stroke panel. The new connector is auto-selected after creation so this is a one-click follow-up |
| Master's text label has real content (not empty) | Cleared via the font-load-then-mutate recipe (`clearLabel`), per confirmed decision — styling is preserved, label is not |

---

## 8. Verification Plan (manual, inside Figma)

The underlying API behavior is already confirmed live (see Feasibility QA above); this pass is about the assembled plugin/UI working end-to-end:

1. Open the plugin in file `IYptRncGvctLie2oRm4Dbd`, set connector `4416:13306` (or any connector) as master → confirm "Master set" toast and Step 2 appears.
2. Select two top-level frames ("screens") → Connect → confirm a new connector appears styled like the master, attached at both ends, selected afterward, and stays attached when either frame is moved.
3. Select a deeply nested non-instance node + a top-level frame → Connect → confirm direct attachment, no climb needed.
4. Select a node inside a component instance + another element → Connect → confirm the toast reports it climbed to the instance root.
5. Select 1 node, or 3 nodes → Connect (should be disabled/blocked) → confirm correct error.
6. Select the master connector itself as one of two "elements" → confirm blocked with the correct message.
7. Delete the master connector, then click Connect → confirm graceful reset to Step 1.
8. Close and reopen the plugin → confirm it returns to Step 1 (no memory of the previous master).
9. After a successful connect, manually flip the arrowhead via the stroke panel → confirm it behaves like any native connector.

---

## Changelog

**Real-world QA pass 2026-09-13** — first run in actual Figma Desktop surfaced 2 bugs + 1 feature request:

| # | Issue | Fix |
|---|---|---|
| 1 | Error thrown right after "Set as Master" | `sendSelectionStatus()` called synchronous `figma.getNodeById()` to look up the master's display name — this Figma client version rejects the sync call. Switched every node lookup to `figma.getNodeByIdAsync()` (`sendSelectionStatus` and `handleConnect` are now both `async`). |
| 2 | UI visually cropped, button pushed off-screen | Panel had a fixed 300px height with no scroll/resize; once "Selected: ..." text wrapped to multiple lines (long frame names), it overflowed the fixed box. Replaced with a content-hugging layout plus a debounced `ResizeObserver` → `postMessage({type:'resize', height})` → `figma.ui.resize()` in code.js, clamped to 340–600px. |
| 3 | (feature request) No visibility into what the plugin did/errored, no easy way to share that info | Added a Log section: every `figma.notify()` call now also emits a structured `{type:'log', level, message, time}` message; the UI renders a scrollable timestamped list (errors in red) with a "Copy" button that copies the full log as plain text via a hidden-textarea `execCommand('copy')` (more reliable than `navigator.clipboard` inside Figma's plugin iframe sandbox). |
| 4 | **Critical, plan-invalidating**: `master.clone()` threw `"Cloning CONNECTOR nodes is not supported in the current editor"` in the real installed plugin | The earlier "confirmed live" feasibility test (Feasibility QA section above) ran through the official Figma MCP's `use_figma` tool, which turned out to execute with more privileged access than a real plugin gets — it let cloning through without error, which was misleading. The real Plugin API enforces exactly what Figma's docs/forum said from the start: **a plugin cannot create (`figma.createConnector()`) or clone an existing `CONNECTOR` node, at all, under any manifest configuration.** Property mutation (`connectorStart`/`connectorEnd`) on a connector that already exists is a different, unrestricted operation and still works. See "Pivot" section below for the redesigned approach. |

---

## Pivot: Paste-then-Connect (superseding the clone-based design above)

Since the plugin can never create or duplicate a connector itself, the workflow changed to lean on Figma's own native copy-paste (which *is* allowed to duplicate a connector, including its exact styling) instead of the Plugin API:

1. User does `Ctrl+C` on their styled connector once, then `Ctrl+V` a fresh copy for every new connection they want to make (Figma keeps the last copy on the clipboard, so this is just repeated pasting, no re-copying needed).
2. User selects **3 items**: the freshly pasted connector + the two elements to connect.
3. Runs the plugin — it identifies which of the 3 selected nodes is the `CONNECTOR`, and reassigns its `connectorStart`/`connectorEnd` to the other two, using the same climb-to-parent fallback and same-page validation as before (both are still real, still needed, and were never dependent on the cloning approach).

**This drops entirely from the plan:** the "Set Master" step, the in-memory `masterConnectorId` state, "master resets on plugin close" behavior, the `master.clone()` call, and the "Change master" button — none of that is needed anymore since there's no cloning to configure. `code.js` and `ui.html` are now a single-screen plugin: one status box, one "Connect Selected" button, plus the Log section from fix #3 above.

**What's preserved unchanged:** the `attachEndpoint` climb-to-parent logic (still the only real restriction — nodes inside a component instance), the same-page validation (the API still doesn't enforce it), and the label-clearing behavior (pasted copies can carry over the original's label text, so it's still cleared via the font-load-then-mutate recipe).

**Trade-off accepted by the user:** one extra manual step (`Ctrl+V`) per connection instead of the original zero-manual-steps vision, in exchange for keeping a **real, natively-sticky** Connector node (exact styling, genuine auto-follow-on-move) rather than a fully-automated fake arrow built from plain shapes that would require a live watcher to simulate stickiness and would stop updating the moment the plugin panel closes.

---

## Feature addition: Manage Connectors (ported from a separate "Toggle connectors" plugin brief)

A separate plugin brief (`Toggle-connectors-source/`, built independently) targeted the same "Connector creation/cloning isn't supported in Design files" limitation from a different angle: instead of creating connections, it bulk-manages the visibility and styling of every connector already on the page. Its four features were folded directly into this plugin as a second section, reusing its color-math logic as-is:

- **Toggle visibility** — a switch that shows/hides every `CONNECTOR` on the current page (`connector.visible`), without touching any connection.
- **Set color + weight** — a color swatch + weight slider (0.5–10) with an Apply button that sets `strokes`/`strokeWeight` uniformly across every connector.
- **Randomize colors** — assigns each connector a maximally distinct color via golden-angle (137.508°) hue spacing, so overlapping connections stay visually distinguishable.

Implementation notes:
- `getAllConnectors()` uses `figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] })` — works fine under this plugin's default (non-`dynamic-page`) manifest, since `figma.currentPage` is always fully loaded regardless of that setting.
- State (visibility + count) is pushed to the UI via a `connector-state` message, sent on load and on every `selectionchange` alongside the existing `selection-status` message — cheap enough to piggyback on that event rather than adding a separate polling loop.
- The original brief's UI used Figma's internal `fig-*` web component kit (`fig-switch`, `fig-input-color`, `fig-slider`) with Cal Sans — not used here, since it's inconsistent with this repo's hand-rolled dark-theme convention. Rebuilt as plain HTML: a CSS toggle switch, a native `<input type="color">`, and a native `<input type="range">`, styled with the same tokens and Plus Jakarta Sans as the rest of the plugin.

### Matching Figma's real UI, not a guessed palette

`fig-switch`/`fig-input-color`/`fig-slider` turned up in zero official Figma documentation — they're almost certainly artifacts of Figma's internal AI-plugin-generation preview surface, not something a normally-loaded plugin actually has access to. Rather than risk another wrong assumption (see the cloning incident above), the plugin now sources its colors from Figma's own documented, confirmed mechanism instead: `figma.showUI(__html__, { themeColors: true })` injects real `--figma-color-*` CSS variables that auto-track the user's actual light/dark Figma theme. Every `--color-*` token in `ui.html` is now a thin alias over the matching `--figma-color-*` variable (e.g. `--color-bg: var(--figma-color-bg, #2C2C2C)`), with the old hardcoded hex kept only as a fallback. Text/control sizing was also tightened to Figma's native ~11–12px scale and denser spacing, still limited to 2 font sizes.
