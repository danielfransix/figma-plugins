# Feasibility: a deterministic Figma → ProtoPie importer

> Current test evidence: [validation](validation.md) and [release checklist](release-checklist.md).
> Implementation update (October 18, 2026): the direct null-origin Figma-to-Studio HTTP path is
> rejected by the installed Studio server. The current implementation serves its panel through a
> localhost helper instead. Grants are reused locally; see [connection permissions](connection-permissions.md)
> for their expiry and the optional auto-approve launcher. The architecture and once-per-session
> approval assumptions in the original investigation below are superseded by these measured findings.

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

ProtoPie ships a second, unrelated server — **Code MCP** — worth naming explicitly so its absence
from the rest of this document isn't an oversight. Code MCP runs separately via `npx`, is
**read-only**, and exists for AI coding agents to pull a *finished* prototype's structure (scenes,
layers, components, variables, interactions) so they can regenerate it as application code — the
prototype-to-code handoff direction. It has no write path and is not usable for this project; only
Studio MCP is relevant here.

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

## High-level architecture (not yet built)

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

The sections below turn this into a concrete, ordered build plan: what to try, in what order, what
each step needs to confirm before the next one is trustworthy, and how the plan itself changes
depending on what each test finds. No code — this is the sequencing and the decisions, written so
implementation can start without re-deriving any of this.

## Build plan

The plan is split deliberately so that every slow or uncertain thing — anything that needs a human
driving Figma's UI by hand, or anything whose behavior is genuinely unknown — is tested as early
and as cheaply as possible, before any plugin code exists. Phase 1 only needs a running ProtoPie
Studio and a terminal; nothing in it touches Figma. That ordering is itself a performance decision
about the *build process*: the feedback loop for "does ProtoPie accept this" is a few seconds of
scripted HTTP calls, while the feedback loop for "does this look right coming out of a real Figma
file" requires a human to open Figma, select something, and visually compare — so everything that
can be resolved without that human-in-the-loop step should be, first.

### Phase 0 — Environment and repo setup

**Goal:** a repo laid out the same way as the existing `figma-plugin/` precedent, with the toolchain
proven to build and load before any real logic goes in.

Steps:
1. Decide the repo's internal shape up front: a `figma-plugin/` directory (manifest, sandboxed
   `code.ts`, UI `ui.ts`) mirroring the existing one's split between the Plugin-API thread and the
   networked UI thread; a separate directory for whatever the local relay turns out to be (a
   process, or nothing at all — see Phase 4); a `shared/` or equivalent for the intermediate
   representation (IR) types once Phase 2 defines them; `docs/` for this plan and its findings.
2. Stand up the same build split the existing plugin uses — typecheck the sandboxed code against
   `@figma/plugin-typings` separately from the DOM-only UI code, bundle both — and confirm a
   trivial "do nothing" plugin loads in Figma via Import plugin from manifest before writing any
   real logic into it. This catches toolchain/manifest problems (including the `networkAccess`
   entry from Phase 4) in isolation from everything else.
3. Confirm ProtoPie Studio's MCP server toggle and endpoint are reproducible from a clean state —
   re-check Preferences → Labs → MCP Server on a restart, confirm the port is stable or detect when
   it isn't (the docs note another port is assigned if 9982 is taken) — so the relay never hardcodes
   an assumption the setup doesn't guarantee. This matters more than it would for a personal tool:
   this plugin is meant to be open-sourced and run on other people's machines, where 9982 may
   already be taken by something else. The plugin's own UI needs a visible, editable endpoint field
   (defaulting to `http://127.0.0.1:9982/mcp`, overridable) rather than a hardcoded constant — treat
   this as a requirement from here on, not an optional nicety.

### Phase 1 — De-risk the unknowns against Studio MCP directly, no Figma involved

**Goal:** resolve every open item from the section above using only hand-built test payloads and
raw calls to the already-reachable MCP endpoint, so every decision that shapes Phase 2 onward is
made from evidence, not assumption. Each step below produces either a go/no-go or a concrete
parameter (a batch-size ceiling, an image-handling strategy, a container-mapping rule) that later
phases are written against.

1. **Read the rest of `layer_manage`'s schema in full.** Only the first portion was captured live;
   the remaining content (the bulk of its 18KB) covers per-type property shapes, including `SHAPE`
   and `CONTAINER`'s full property lists, Auto-Layout-equivalent fields, and any other layer-type
   specifics not yet seen. This is a prerequisite read, not a test — do it first, since several
   later steps depend on knowing exactly what fields exist before testing them.
2. **Idempotency/tagging mechanism check — elevated to this phase because re-import is now a
   confirmed v1 requirement, not an optional later add-on.** Re-importing a changed Figma source
   (whole file or a specific selection — a frame, a section, a single component) must update the
   matching existing ProtoPie scenes/layers in place rather than duplicate them, mirroring exactly
   what `figma-plugin/src/code.ts` already does for the reverse direction via Figma's
   `setPluginData`/`getPluginData`. Before any of Phase 5 is designed around that behavior, confirm
   whether ProtoPie has an equivalent: read `layer_manage`, `scene_manage`, and `component_manage`'s
   full schemas (building on step 1's full read of `layer_manage`) specifically for any generic
   metadata/custom-data/tag field on a layer or scene, and if none exists, test whether `resolve_ids`
   or any other read tool can reliably re-identify a previously-created entity some other way (e.g.
   a `name` convention plus geometry, though name/geometry matching is inherently weaker than an
   opaque tag — a renamed or moved layer could be missed or misattributed). **If no on-node tagging
   mechanism exists**, the design commits to an external manifest instead: a small file the relay
   keeps (likely shipped as part of the `.pie` project's working directory, or embedded via
   `resource_manage`'s inline-data capability if ProtoPie allows storing arbitrary non-rendered data
   that way — worth testing as an alternative to a plain sidecar file) mapping a stable Figma node
   identity (component key, or a hash of the node's path + content, matching the `figma-plugin`'s
   existing `hashString`-based approach) to the ProtoPie entity id `compose_pie` returned when it was
   created. Either outcome is workable, but which one shapes the data model for everything in
   Phase 5, so it needs an answer before that phase starts, not during it.
3. **Batch-size and throughput test.** Against a disposable test `.pie` file, send `compose_pie`
   batches of increasing size (tens, then hundreds, then on the order of a thousand `layer_manage`
   ops) and record, for each: whether the call succeeds at all, how long the HTTP round trip takes,
   and — separately — how long Studio visibly takes to finish rendering the result (the network
   response returning fast doesn't by itself mean Studio-side processing is also fast). Look for
   either a hard rejection at some size or a point where latency stops scaling linearly. The
   outcome directly decides the chunking strategy Phase 6 implements: one call per screen, one call
   per file, or some fixed chunk size with multiple sequential calls.
4. **`connect_studio` cold-start behavior, now specifically as a first-run experience for a
   stranger, not just a timing question.** The one live test so far returned a `connectionId`
   immediately with no observed blocking prompt — which could mean this client type never blocks,
   or could mean a prior approval was already cached for it. Test this for real on a genuinely
   fresh state (a new Studio install or a reset approvals list, if ProtoPie exposes one, or at
   minimum a different client identifier never connected before) to find out whether a human must
   be present to click Allow on every cold start. Since this plugin is meant to be installed by
   people with no context beyond its own README, the plugin's UI needs to anticipate this dialog
   explicitly — a visible "check ProtoPie Studio for an approval prompt" message the moment
   `connect_studio` is called, not a silent spinner — regardless of what the timing test finds.
5. **Image payload strategy.** Take a handful of real images pulled from an actual Figma file at
   their real exported sizes (not synthetic small test images) and push each through `add_inline`
   as-is, then again after compression, and compare against uploading to a scratch https location
   and using `add_from_url` instead. Decide the default strategy from what actually works
   reliably and quickly — likely outcome is "always re-encode/compress raster fills before
   `add_inline`, prefer Figma's native SVG export for vector content since it's compact text, and
   only reach for `add_from_url` if a hosting mechanism already exists for other reasons" — but
   this must be confirmed against real asset sizes, not assumed from the ~64KB guidance alone.
6. **Auto Layout fidelity.** Build one Figma frame by hand that exercises real Auto Layout
   (direction, gap, padding, alignment, wrap, nested Auto Layout), manually author the equivalent
   `layer_manage` `CONTAINER` op by hand using the full schema from step 1, push it through
   `compose_pie`, and compare the result in ProtoPie against the Figma original using
   `capture_preview` side by side. This is a manual, one-off translation exercise specifically to
   validate the mapping rule before any code tries to automate it — find the mismatches here, where
   fixing them means editing one hand-written JSON object, not debugging a plugin.
7. **Vector/shape fidelity.** Export a non-trivial vector or icon from Figma as SVG (Figma's own
   per-node SVG export, available directly in the Plugin API), push it through `resource_manage`
   `add_inline` as an SVG resource on an `IMAGE` layer, and compare against attempting to represent
   the same shape natively via `SHAPE`'s own property schema (from step 1). The working assumption,
   consistent with what ProtoPie's own official plugin already does for vectors, is that
   "SVG-as-image" is the right default and native `SHAPE` mapping is only worth the extra
   complexity for the small set of primitive shapes (simple rects, ovals, basic polygons) where a
   native layer is unambiguously better than a flattened image — confirm or reject that against the
   real schema rather than assuming it.
8. **Cross-reference correctness at realistic scale.** Build one large synthetic `compose_pie`
   batch (on the order of what step 3 found as a safe upper bound) that uses `${name.property}`
   references across dozens of entries — a resource created early in the batch referenced by a
   layer created much later, a scene created early referenced by layers throughout — and confirm
   resolution is correct and order-independent in the ways the API implies, not just for the small
   examples in `describe_ops`'s own documentation.
9. **Schema stability check.** Studio MCP is new (the build pulled from in this investigation was
   tagged as a non-release/dirty build), unpublished, and could change its tool names or input
   shapes in a future Studio update without any changelog to track against. This matters more here
   than it would for a personal tool: a published, open-source plugin can be installed against any
   user's Studio version, not just the one this was built and tested against. Build the relay to
   open every run by calling `describe_ops` and comparing the live schema against what the code was
   written against — failing loudly with a clear, specific message naming the missing op kind or
   field, rather than silently producing a wrong or partial import. Treat this as required, not
   optional, given the audience.

### Phase 2 — Minimal read path (Figma plugin, no network yet)

**Goal:** confirm the Plugin API gives everything needed, and settle on the shape of the
intermediate representation (IR) — the JSON structure that sits between "what Figma's node tree
looks like" and "what ProtoPie's ops need," so the two translation directions (Figma → IR, IR →
ProtoPie ops) can be built and tested independently.

1. Hand-pick one small, simple frame in a real Figma file (no components, no images, no Auto
   Layout — the simplest possible case) and write the plugin code that walks it via the Plugin API
   (`figma.currentPage.selection`, node geometry, fills/strokes/effects, text properties,
   `children`), logging the walked structure rather than sending it anywhere yet.
2. Define the IR shape from what this walk actually produces, not from ProtoPie's op shape and not
   from Figma's raw node shape — a structure independent of both, the same role this ecosystem's
   other repo gives its own capture-engine-to-plan split (`src/shared/types.ts` /
   `src/shared/plan.ts` in `web-app-ui-explorer` is the precedent for keeping "what was captured"
   and "what the target format needs" as two separate, independently testable stages, worth
   deliberately reusing that separation here rather than coupling the Figma walk directly to
   `compose_pie`'s op shape).
3. Confirm `figma.exportAsync` (for vector/SVG export, per Phase 1 step 7's chosen strategy) works
   as expected from inside the plugin sandbox, with no network access required for the export call
   itself — only for sending the result onward.

### Phase 3 — Minimal write path (relay logic, against a hand-written fixture)

**Goal:** prove the IR → ProtoPie-ops translation is correct for the simple case, entirely
decoupled from Figma — the fastest possible feedback loop for fixing translation logic, since it
only requires editing a static JSON fixture and re-running a script, not re-selecting anything in
Figma.

1. Hand-author one IR document matching Phase 2's simple-frame case (not yet produced by the
   plugin — written directly, as a fixture).
2. Write the translation logic that turns that fixture into one `compose_pie` call per the mapping
   table above, and the surrounding lifecycle calls (`connect_studio` → `start_editing` →
   `compose_pie` → `end_editing`).
3. Run it against the real local Studio MCP endpoint and confirm, via `capture_preview`, that the
   resulting scene matches the original Figma frame. Iterate here — on the fixture and the
   translation logic — until this one case is solid, before introducing Figma's own output as a
   variable.

### Phase 4 — Connect the two ends

**Goal:** the same simple-frame case, now driven by a real Figma selection instead of a hand-written
fixture, deciding the actual transport for the local leg in the process.

1. Test directly whether the plugin UI iframe can `fetch()` straight to
   `http://127.0.0.1:9982/mcp` with `127.0.0.1` declared in the manifest's
   `networkAccess.allowedDomains`. If this works reliably, it removes an entire hop and an entire
   process compared to standing up a separate relay — prefer it by default, and only fall back to a
   separate local relay process (the `cursor-talk-to-figma-mcp` shape, a WebSocket relay sitting
   between the plugin and the target) if direct fetch turns out to be unreliable or blocked in
   practice. Don't assume a relay is required just because the precedent project uses one — that
   project needed a persistent relay because it bridges two independent long-lived actors for an
   ongoing conversational session; this tool's job is a one-shot batch translate-and-push per run,
   which is a meaningfully simpler problem that may not need a persistent process at all.
2. Wire Phase 2's plugin walk directly into Phase 3's translation logic, replacing the hand-written
   fixture with the plugin's real output.
3. Get one real, simple, hand-selected Figma frame into ProtoPie correctly through the full path,
   end to end. This is the first true milestone — everything before it is scaffolding, everything
   after it is breadth (more primitives) and depth (performance, robustness).

### Phase 5 — Scale up primitive coverage, one at a time

**Goal:** extend the same end-to-end path to cover every primitive in the mapping table, each as
its own checkpoint against a real Figma example before moving to the next, so a failure is always
traceable to one specific kind of content.

1. **Multiple frames in one run** — exercises `scene_manage` `batch_add` for more than one scene
   and confirms the batching approach from Phase 1 step 3 holds up against real (not synthetic)
   content.
2. **Text fidelity** — font family/weight/size, and the fallback case where a Figma font isn't in
   ProtoPie's font catalog (queryable via `query_design_system`); this is the same category of
   problem the existing `figma-plugin/src/code.ts` already solved for font availability in the
   reverse direction (its `drawText` falls back gracefully when a font fails to load) — same
   fallback shape is reusable here, adapted to ProtoPie's own font catalog instead of Figma's.
3. **Images** — apply whatever strategy Phase 1 step 5 settled on, against real exported Figma
   image fills at realistic sizes.
4. **Auto Layout containers** — apply the mapping rule Phase 1 step 6 validated, now driven by the
   plugin's real walk of an Auto Layout frame rather than a hand-authored one.
5. **Vectors/shapes** — apply the strategy Phase 1 step 7 settled on.
6. **Components and instances** — the most complex single piece, and now a hard v1 requirement
   (confirmed: feature parity with the official plugin's component handling, plus the ability to go
   further). `component_manage`'s `convert` action and `layer_manage`'s `COMPONENT_INSTANCE`
   placement are the ProtoPie-side primitives; the *resolution algorithm* — "has this component
   identity been seen before in this run; reuse the existing Master or create a new one; substitute
   an instance everywhere it recurs; apply this occurrence's own real text/content as an override
   rather than the Master's" — is structurally the same problem the existing
   `figma-plugin/src/code.ts` already solves for the opposite direction (`materializeComponents` /
   `drawChild` / `applyOwnText`), so that algorithm is a legitimate starting reference even though
   every underlying API call is different. Figma's own component/variant identity (component key,
   variant properties) is the natural source for the stable identity this resolution needs — and is
   also the identity the idempotency tagging in step 7 below keys on.
7. **Idempotent, selection-scoped re-import — confirmed v1 requirement, not optional.** Re-running
   an import — against the whole file, or against a specific selection (one frame, one section, one
   component) — must update the matching existing ProtoPie scenes/layers in place, leave unchanged
   content untouched, and flag a conflict rather than silently overwrite anything hand-edited in
   ProtoPie since the last run. This mirrors exactly what `figma-plugin/src/code.ts` already does
   for the reverse direction via Figma's `setPluginData`/`getPluginData` plus its content-hash
   comparison (see `fingerprintNode`/`contentHash`/`appliedHash` in that file) — same algorithm,
   different storage mechanism on this side. Build this against whichever outcome Phase 1 step 2
   found: if ProtoPie exposes on-node tagging, mirror the existing plugin's approach directly
   (tag each created scene/layer with its source Figma node's stable identity and a content hash,
   compare on re-run, skip unchanged, update changed-but-unedited, flag changed-and-hand-edited); if
   it doesn't, implement the external-manifest fallback designed in that same Phase 1 step instead.
   Selection-scoping itself needs no extra design here — the plugin already operates on
   `figma.currentPage.selection` from Phase 2 onward, so "re-import just this button" is already the
   natural unit of work, not a separate mode to build.
8. **Prototype links and Smart Animate → triggers.** `trigger_manage`/`response_manage`/
   `condition_manage` carry this, mirroring the Jump-response translation the official ProtoPie
   plugin already performs — a known-good mapping to replicate via the typed API rather than a new
   design question.
9. **Repeated structure.** Once the primitive-by-primitive path is solid, revisit whether detecting
   repeated structure in a Figma selection (a list of near-identical rows, a grid of cards) and
   emitting one `repeat_template`/`create_section` op instead of N sets of raw layer ops is worth
   the added detection complexity — treat this as an optimization pass on top of working primitive
   coverage, not a blocking dependency of it.

### Phase 6 — Performance tuning against a real file

**Goal:** the actual point of the project — measured, not assumed, speed.

1. Pick one real multi-screen file representative of actual usage and record the official ProtoPie
   plugin's import time for it as the baseline to beat.
2. Run the same file through this tool, apply the batching/chunking parameters Phase 1 established,
   and measure end-to-end wall-clock time the same way.
3. If Studio's `start_editing` lock effectively serializes all writes against one Pie regardless of
   how many `compose_pie` calls are issued, parallel calls won't help throughput — confirm whether
   that's actually the case before spending effort on parallelizing the relay's calls; the more
   likely lever is simply fewer, larger batches per Phase 1's findings, not concurrency.
4. Iterate chunk size/strategy against this real measurement, not the synthetic tests from Phase 1
   alone — synthetic tests find the ceiling, but real files have a different mix of op types and
   payload sizes than a uniform synthetic batch does.

### Phase 7 — Failure handling and reporting

**Goal:** a partially-failed run is informative, not silent or catastrophic.

1. Decide what the plugin surfaces when `compose_pie`'s `best_effort` semantics mean some ops in a
   batch succeeded and others didn't — mirror the existing `figma-plugin`'s report/conflicts panel
   shape (a visible list of what was built and what wasn't, not a bare pass/fail).
2. Decide the behavior for Figma content with no mapping at all (an effect, blend mode, or
   construct ProtoPie has no equivalent for) — consistent with this ecosystem's existing philosophy
   documented in the other repo's build plan ("note the gap... rather than failing or fabricating
   content"), the default should be: skip the unsupported piece, report it by name, never block the
   rest of the run and never approximate silently.

### Phase 8 — Distribution

**Goal:** confirmed intent — this ships as a public open-source Figma Community plugin, not a
locally-loaded personal tool, so "easy for a stranger to install and use" is a real requirement
from here on, not a later nicety.

1. Target actual publishing to the Figma Community plugin directory, not local-manifest loading
   only (the `figma-plugin/` precedent in the other repo intentionally stayed local-only because it
   was never meant for anyone else — that reasoning doesn't carry over here). Figma's own
   publishing review and listing requirements become a real dependency to account for in scheduling,
   not just a build step.
2. Write a public-facing README distinct from this internal planning document: prerequisites (Figma
   desktop, ProtoPie Studio on a plan with MCP Core, the Labs → MCP Server toggle enabled, the
   target `.pie` file open), install steps, and what to expect on first connection (the
   `connect_studio` approval dialog from Phase 1 step 4 — tell people to expect it before they hit
   it, not after).
3. Pick an open-source license (MIT is the conventional default for a plugin like this; no
   technical reason found in this investigation to deviate) and apply it before the first public
   commit, not retroactively.
4. Because installs are now uncontrolled (any Figma desktop, any ProtoPie Studio version, any OS),
   cross-platform correctness (Windows and macOS, since both run Figma desktop and ProtoPie Studio)
   and the Phase 1 step 9 schema-compatibility check both move from "good practice" to "required
   before a public release," since there's no longer a single known environment to assume.

## Cross-check: are these the most performant choices available

Explicitly re-examining the decisions in this plan against the alternatives that were considered
and set aside, to confirm each one is actually the fastest reasonable option rather than just the
first one found:

- **Figma Plugin API over Figma's REST API.** A server-side pipeline using Figma's public REST API
  (`GET /v1/files/:key`) was a real alternative — it would let this run headlessly, without Figma
  desktop open. Rejected for this tool: it only sees whatever's last saved to Figma's servers (not
  always-current for unsaved local state), it needs a separate Figma access token and is subject to
  Figma's API rate limits, and it directly contradicts the stated requirement (both apps open
  locally, driven by a plugin). The Plugin API is also simply faster for this use case: it's local,
  synchronous-ish, structured data with no network round trip to Figma's own servers at all — a
  clear performance win on top of matching the requirement.
- **Direct `fetch` from the plugin UI over a persistent local relay process.** The proven precedent
  (`cursor-talk-to-figma-mcp`) uses a relay, but for a different problem shape — a long-lived
  conversational bridge, not a one-shot batch job. Phase 4 tests the direct-fetch path first
  specifically because, if it works, it's strictly fewer moving parts and fewer network hops than
  standing up and managing a relay process — the relay is a fallback, not the default plan.
- **Large batched `compose_pie` calls over many small ones.** `compose_pie`'s own design
  (`${name.property}` cross-referencing, `best_effort` partial success) signals this is the
  intended usage, not an incidental allowance — Phase 1 step 3 exists specifically to find the
  actual ceiling empirically rather than guessing a conservative chunk size and leaving real
  throughput on the table.
- **Inline image payloads over externally-hosted URLs, by default.** `add_from_url` adds a network
  round trip to somewhere outside localhost and a hosting dependency this tool otherwise doesn't
  need; `add_inline` keeps everything inside the same local batch. The size guidance (~64KB) is the
  only reason to reach for `add_from_url` at all, so the plan treats compression-before-`add_inline`
  as the first thing to try, not external hosting.
- **SVG-as-image over native `SHAPE` mapping, by default, for non-trivial vectors.** Matches what
  ProtoPie's own official importer already does for vectors (a known-good, battle-tested choice),
  avoids a large and fragile path-data translation layer, and is almost certainly cheaper to both
  build and run than reconstructing arbitrary vector geometry through `SHAPE`'s native schema.
  Native `SHAPE` stays worth using only for the small set of genuinely primitive shapes where it's
  unambiguously simpler.
- **A one-shot relay over a persistent one.** Studio MCP is already a persistent local server;
  nothing about this tool's job (translate one Figma selection, push it, finish) needs its own
  long-running process on top of that. Simpler to build, nothing to keep alive or restart, no
  process-manager concerns — favored over blindly copying the precedent project's persistent-relay
  shape, which solves a different problem.

No decision in this plan depends on an assumption that a cheap, early test in Phase 1 could instead
resolve — every performance-sensitive choice above has an explicit test gate before the plan commits
to it in the later phases.

## QA pass

Checked explicitly before calling this plan ready:

- **Every open item from the feasibility findings has a corresponding resolution step in the build
  plan.** Idempotency/tagging mechanism → Phase 1.2. Batch-size ceiling → Phase 1.3. `connect_studio`
  cold-start behavior → Phase 1.4. Image size → Phase 1.5. Auto Layout fidelity → Phase 1.6.
  Vector/shape fidelity → Phase 1.7. None were left dangling as "open" without a phase that closes
  them.
- **Dependency order is consistent.** Nothing in Phase 2 onward depends on a Phase 1 decision that
  hasn't been made yet; Phase 3 deliberately doesn't depend on Phase 2's plugin code existing yet
  (it uses a hand-written fixture precisely so it doesn't have to); Phase 5's sub-steps each depend
  only on Phase 4's milestone, not on each other, so they can be reordered or parallelized across
  more than one person without restructuring the plan.
- **Every "reuse the existing repo's pattern" reference names the actual file and the actual
  mechanism being reused** (`figma-plugin/src/code.ts`'s `materializeComponents`/`drawChild`/
  `applyOwnText` for component resolution; `src/shared/types.ts`/`src/shared/plan.ts` for the
  capture-then-plan separation; its `setPluginData`/conflict-detection pattern for idempotency) —
  not a vague "do it like the other repo," which would've been un-actionable once this document is
  the only thing a future build session has in front of it.
- **The plan doesn't silently assume anything the live probe didn't actually confirm.** Where the
  investigation found a gap — no confirmed batch ceiling, no confirmed idempotency/tagging
  mechanism on the ProtoPie side, `layer_manage`'s schema only partially read — the plan names the
  gap explicitly and puts a step in front of it rather than building on top of an unverified
  assumption.
- **Nothing in the plan requires code to validate it.** It was written to be readable and checkable
  as prose and sequencing alone, per the instruction this plan was written under.

## Alignment — decided

1. **ProtoPie plan/licensing durability.** Confirmed: current plan covers Studio MCP (MCP Core
   tier). Proceeding on that basis.
2. **Scope of "done" for v1: full parity with the official plugin, plus more.** Confirmed. This is
   not a narrow personal-design-system tool — every primitive the official plugin handles
   (including components as real, reusable ProtoPie components, not flattened containers) is in
   scope, with Phase 5 as the literal checklist. "More" concretely means, at minimum, the speed
   this whole project exists for, plus the two items below (selection-scoped idempotent re-import,
   and public distribution) that the official plugin doesn't offer at all.
3. **Re-import is a v1 requirement: idempotent, and scoped to whatever is selected** (whole file, one
   frame, one section, one component) **— not just whole-file.** Confirmed. Phase 1 step 2 now
   resolves the open technical question this depends on (whether ProtoPie supports on-node tagging
   or needs an external manifest) before Phase 5 step 7 builds on top of it.
4. **Distribution: public, open-source, installable by people with no inside context.** Confirmed.
   Phase 8 now targets actual Figma Community publishing with a public README and a license, not
   local-manifest loading. This also raises the bar on several things that would otherwise be
   nice-to-haves: a configurable MCP endpoint (Phase 0 step 3) instead of a hardcoded port, explicit
   first-run guidance for the `connect_studio` approval dialog (Phase 1 step 4), and the Phase 1
   step 9 schema-compatibility check all move from "good practice" to "required," since this now
   has to work on machines and ProtoPie versions this plan was never tested against.

## Current implementation findings (October 18, 2026)

The plan above is the historical investigation, not a current feature checklist. See
[validation](validation.md), [installation](installation.md), and [release gates](release-checklist.md).

- Studio exposes no source-link metadata. Version 2 stores target-scoped, chunked link records
  on the Figma document root. Atomic manifest generations preserve the previous complete state
  if persistence is interrupted. Grants are stored separately in per-user clientStorage.
- The first connection uses Studio's native approval. Reopening reuses a valid local grant.
  The tested build expires it after 30 minutes idle. An undocumented process environment switch
  permits automatic approval for every local MCP client; see [permission research](connection-permissions.md).
- Masters are created directly with component_manage add. Their returned artboard ID and actual
  root layer ID differ; the importer resolves the root before editing it and adding children.
  No off-canvas scratch instance is created. Native instance_override uses verified master source
  layer IDs, including nested instance paths. Master updates preserve compatible child IDs.
- Native array layer creates outperform many individually named layer operations. Operation and
  UTF-8 byte limits, cross-chunk dependencies, per-node acknowledgements, and conservative uncertain
  write protection are implemented. There is no automatic retry after an ambiguous network write.
- The local panel helper is necessary because Studio rejects Figma's null-origin requests. It
  serves static panel assets only; the panel talks directly to Studio. There is no remote relay.
- Conflict checks protect the whole affected scene/master using rendered appearance, topology,
  and interactions. This is conservative: unrelated manual edits can block a source update.
- The compiled reader has been exercised against the real P&E Team QA file. Headless browser
  coverage checks the actual bootstrap transport. A Figma desktop plugin run, official importer
  comparison, macOS app run, numeric publication ID, and Community publication remain external gates.
- Compatibility probes check required capability markers before writing. The tested MCP surface
  is version-specific and unpublished; future Studio releases may require adapter changes.
