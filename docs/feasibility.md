# Feasibility: a deterministic Figma → ProtoPie importer

## The problem

ProtoPie's official Figma plugin is slow enough to be a real workflow blocker — user reports cite
roughly 30 seconds per frame (4 frames ≈ 2 minutes), worse with large images, shadows/masks, or
certain stroke settings that can cause the importer to stall or skip content. ProtoPie's own
documentation describes the mechanism as importing "items individually," appearing in Studio "as
soon as they're ready" — i.e. a per-item streaming protocol, not a bulk transfer. That per-item
round trip, over whatever private channel connects the Figma plugin sandbox to the Studio desktop
app, is the bottleneck. It isn't something file cleanup fixes at the root, only mitigates.
ProtoPie's own workaround advice is procedural, not technical: import core components once and
drive different states with variables/formulas instead of importing a separate frame per state.

## The goal

A custom Figma plugin that reads a selection through the Figma Plugin API (richer and cheaper
than DOM scraping — nodes already expose `x/y/width/height/fills/strokes/effects/children`
directly) and writes it into ProtoPie Studio through a **different, faster channel**: ProtoPie's
own Studio MCP server, called directly and deterministically — no AI model anywhere in the data
path, no dependency on ProtoPie's proprietary plugin-to-Studio protocol (which is undocumented
and not worth reverse-engineering: unknown wire format, no public port/spec, and real ToS risk,
versus a channel ProtoPie ships and documents on purpose).

## Precedent: a Figma plugin can talk to localhost, deterministically

Figma added `localhost` / `127.0.0.1` support to the plugin manifest's
`networkAccess.allowedDomains` in Plugin API Update 78 (Sept 2023), specifically so a plugin can
reach a process running on the same machine. This is a documented, sanctioned capability, not a
sandbox workaround.

The open-source `cursor-talk-to-figma-mcp` project (sonnylazuardi) already ships exactly this
shape in production: the plugin's UI panel (the sandboxed main thread has no network access; the
UI iframe does) opens a WebSocket to `ws://localhost:3055`, exchanges plain `{command, params,
id}` / `{id, result}` JSON messages with a local relay, and the relay forwards commands to/from an
MCP client. The wire protocol itself is a deterministic RPC — the AI in that project sits on the
far end of the relay, outside the Figma-plugin-to-localhost leg entirely. This repo's architecture
reuses the same leg, just pointed at a different destination.

## Live verification: ProtoPie Studio MCP's actual write surface

ProtoPie hasn't published Studio MCP's tool schemas anywhere (no GitHub repo, no npm package, no
API reference page — the docs only show conversational examples like "add a tap trigger"). The
following was pulled directly from a running ProtoPie Studio 10.5.0 instance
(`protopie-studio-mcp` server v1.0.2) via raw JSON-RPC calls to its local endpoint
(`http://127.0.0.1:9982/mcp`), bypassing any AI client — confirming the server can be driven by a
plain script.

### Connection lifecycle

1. `initialize` (standard MCP handshake) — works immediately, no approval needed for the handshake
   itself.
2. `connect_studio` — required before any real tool call. Shows a native Allow/Deny dialog in
   Studio on first use; returns an opaque `connectionId` (idle-expires after 30 minutes). Every
   other tool call requires this `connectionId`.
3. `connect_studio`'s grant pins to the currently active Pie (`contextId`). Calls against a
   different open Pie are rejected until `open_pie` explicitly retargets the grant.
4. `start_editing` / `end_editing` — Studio locks the tab for the duration of a write so manual
   edits and scripted edits can't interleave; required around `compose_pie`/`replace_styles`/
   `import_assets` calls.

### The write surface: one batchable entry point

`compose_pie` is the **single write entry point** for everything:

```
compose_pie({ operations: [{ tool: "<op_kind>", input: {...}, name?: "<label>" }, ...] })
```

- `best_effort` by default: partial successes are kept; failed ops surface individually in the
  response rather than rolling back the whole batch.
- Ops can reference each other's results within the same batch via `${name.property}` (e.g.
  `${addCheckIcon.resourceId}`, `${add_tap.triggerIds[0]}`) — a single `compose_pie` call can
  create a resource and a layer that references it, or a scene and layers inside it, in one round
  trip.
- `describe_ops` (called with no args, or `{op: "<kind>"}`) returns the live input schema for any
  op kind — this is how the schemas below were pulled, not from documentation.

### Op kinds relevant to a Figma import, and how Figma maps onto them

| Figma primitive | ProtoPie op kind | Notes |
|---|---|---|
| Top-level frame | `scene_manage` (`batch_add`) | 1:1, same as the official plugin's own frame→scene mapping. Scene size follows the active device, not the scene itself — set via `device_manage`. Background color goes under `properties.fillColor`/`fillOpacity` (0–100, not 0–1). |
| Rectangle / vector / group / auto-layout frame | `layer_manage` (`batch_add`, `layerType: RECT \| SHAPE \| CONTAINER \| ...`) | 12 layer types total (`RECT, OVAL, SHAPE, TEXT, TEXT_INPUT, IMAGE, VIDEO, AUDIO, CONTAINER, LOTTIE, CAMERA, IOS_EFFECT, COMPONENT_INSTANCE`). `CONTAINER` is the nesting/grouping primitive Figma frames map to. |
| Text node | `layer_manage` (`layerType: TEXT`) | Direct. |
| Image fill | `resource_manage` (`add_inline` with base64/SVG, or `add_from_url` for https sources) then `layer_manage` with `resourceId` (IMAGE-type layers) or `fillResourceId` (image fill on RECT/SHAPE) | `add_inline` guidance: keep payloads ≤64KB; `data:`/`file://` are rejected by an SSRF guard on `add_from_url`, so local/inline bytes must go through `add_inline`. |
| Figma component + instances | `component_manage` (Master lifecycle: `add/edit/delete/duplicate/convert/detach/swap/reset_overrides`) + `layer_manage` (`COMPONENT_INSTANCE` layers, placement) | Same two-tier model as Figma's own component/instance split. `convert` turns existing layers into a Master non-destructively, in place — directly useful for a "detect repeated structure, promote to component" pass. Per-instance edits use `instance_override` (child content) vs `batch_edit` on the instance id (root appearance) — the existing repo's `figma-plugin/src/code.ts` already implements an analogous instance/master resolution algorithm for the reverse direction and is a reasonable starting reference for this split. |
| Repeated structure (lists, card grids) | `repeat_template` (meta op: expand a sub-template across N items with `{{var}}` substitution) and `create_section` (scaffolds a CONTAINER + children with auto-layout wiring for `vertical-list \| horizontal-list \| scroll-feed \| card`) | Not a Figma-side concept to map *from* — a ProtoPie-side efficiency primitive to map *to*: detecting repeated structure in a Figma selection (e.g. a list of 20 near-identical rows) and emitting one `repeat_template`/`create_section` op instead of 20 sets of raw `layer_manage` ops is a meaningful operation-count reduction worth designing for. |
| Figma prototype links / Smart Animate | `trigger_manage` + `response_manage` (+ `condition_manage`) | Same translation the official plugin already does (prototype link → ProtoPie Jump response) — confirms this is a known-good mapping, just worth replicating via the typed API instead of the slow plugin. |
| Design tokens / variables | `variable_manage` (`NUMBER/STRING/COLOR`, scope `NORMAL/GLOBAL/FORMULA`) | Maps to Figma variables/styles, and is also the mechanism ProtoPie itself recommends for driving states instead of importing one frame per state. |

### What this confirms

- **No AI required.** Every op above is a plain typed JSON object; `compose_pie` is callable by a
  deterministic script exactly as tested here (raw `curl` + a fixed JSON body, zero model
  involvement).
- **Batching is a first-class, intended use case**, not an incidental side effect — the
  `${name.property}` cross-referencing and `best_effort` partial-success semantics are explicitly
  designed for large multi-op calls, which is the main lever for beating the official plugin's
  per-item streaming.
- **The full set of Figma primitives this matters for has a corresponding ProtoPie op**: shapes,
  text, images, containers/auto-layout, components/instances, prototype links, and variables all
  have a write path.

## Open items — not yet resolved, worth testing before/during build

- **No confirmed upper bound on `compose_pie` batch size or total ops per call.** The schema
  encourages large batches but doesn't state a hard limit; needs an empirical test with a
  realistically large payload (a real multi-screen app's worth of layers) before assuming "one
  call per screen" or "one call per file" is actually safe.
- **`connect_studio`'s Allow/Deny dialog behavior under automation is untested beyond this one
  session.** It returned a `connectionId` immediately in this test without an observed blocking
  prompt — unclear whether that's because a prior approval was already cached for this client, or
  whether it genuinely never blocks for this client type. A fresh Studio profile / first-ever
  connection needs to be tested to know whether a human has to be present to click Allow on every
  cold start, which affects whether this can ever run fully unattended.
- **Image fill size.** Figma images can easily exceed the ~64KB inline-payload guidance;
  large fills likely need either compression before `add_inline`, or an intermediate upload to an
  https location so `add_from_url` can be used instead (adds a dependency, but removes the size
  pressure).
- **Auto Layout → ProtoPie layout fidelity** is asserted by analogy (CONTAINER + the layout
  properties `layer_manage`'s full schema exposes) but not yet checked against a real Auto Layout
  frame with wrapping/spacing/alignment rules.
- **Vector/shape fidelity**: Figma's arbitrary vector paths vs. ProtoPie's `SHAPE` layer type —
  needs a check on what `SHAPE`'s schema actually accepts (path data vs. a fixed primitive set)
  for non-trivial icon/illustration work; `layer_manage`'s full schema (18KB, not fully
  transcribed here) should be read in full before implementation starts.

## Proposed architecture (not yet built)

1. **Figma plugin** — structurally a mirror of the existing `web-app-ui-explorer` repo's
   `figma-plugin/` (which already writes *into* Figma from a captured payload): a `code.ts` running
   in the Plugin API sandbox walks the current selection into one structured payload per top-level
   frame; a `ui.ts` iframe (the only part of a Figma plugin with network access) owns the
   connection out.
2. **Local relay** — a small deterministic script (not necessarily even a separate process; the
   plugin UI could call Studio MCP directly over `fetch` if `127.0.0.1` is in
   `networkAccess.allowedDomains`, removing the relay hop entirely — worth testing before assuming
   a relay is needed at all) that translates the walked Figma tree into `compose_pie` operations
   per the mapping table above, and manages the `connect_studio` → `start_editing` →
   `compose_pie` (batched) → `end_editing` lifecycle.
3. **One-time setup per Studio session**: enable Preferences → Labs → MCP Server in ProtoPie
   Studio (confirmed port `9982`, endpoint `http://127.0.0.1:9982/mcp`), with the target `.pie`
   file open and focused — same operational precondition the official plugin already has ("keep
   both apps open"), just serving a much cheaper write path once connected.

This is a standalone tool, independent of the `web-app-ui-explorer` repo's own Figma export work —
it only shares an architectural shape with it, not code or a build target.
