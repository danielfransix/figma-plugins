# Installation

This build uses a small localhost helper because Studio rejects direct requests from Figma's
plugin origin. No design content is uploaded to a remote service.

## Packaged development candidate

Extract the entire ZIP to a permanent folder. A platform package contains the helper's Node
runtime and its upstream license, so the recipient does not need npm or the source toolchain.
The node-required package instead needs Node.js 20 or later on PATH.

1. Windows: double-click `Start-Plugin.cmd`. macOS: open `Start-Plugin.command`.
2. In Figma desktop, import `figma-plugin/manifest.json` through Plugins > Development.
3. Enable Studio's MCP server under Preferences > Labs and open the target Pie.
4. Run Figma to ProtoPie, approve the initial Studio connection, select content, and import.

Keep the helper window open while importing. Its only listener is `127.0.0.1:9983`. The Studio
address defaults to `http://127.0.0.1:9982/mcp` and can be changed in the panel settings.

The current manifest contains a development ID placeholder. Before Community publishing, create
the plugin in your Figma account, obtain its numeric ID, and build the package with
`npm run package -- --with-runtime --plugin-id YOUR_ASSIGNED_ID`. A different plugin ID has a
different storage namespace; do not change it after users start syncing files.

## Source checkout

```
npm ci
npm run build
npm start
```

`npm run doctor` checks the build files, helper, and Studio endpoint without requesting approval.
`npm test` runs the offline and headless browser suite; first install its browser with
`npx playwright install chromium`. The runtime helper itself has no npm dependencies.

## Updating an existing prototype

The fixed timer above the footer starts when you click Import, including the connection wait and
Figma read. It stays visible while scrolling, stops when the attempt completes, fails, or finishes
stopping, and keeps the final duration until the next import. It counts minutes and seconds,
adding hours for long runs. Diagnostics retain the elapsed duration and outcome even after errors.

Re-import the same selection to update its linked layers. Whole sections, pages, and all pages in a file are supported.
Node IDs are retained for compatible updates so existing ProtoPie interactions stay attached.
Changed visual content or interactions in ProtoPie produce a conflict instead of an overwrite.
The conflict check conservatively protects the entire affected scene or component master.

Create components is on by default. Turn it off to import instances and component definitions as
editable layers without creating ProtoPie masters. Visible instance overrides are retained; complex
artwork still uses the documented image fallback. Existing masters are kept. Update shared masters
is disabled while Create components is off. Switching modes on a linked import can replace instance
layers with containers or vice versa, so existing manual-edit and interaction protections still apply.
Enable shared master updates only when you intend the change to propagate to all its instances.
Live auto layout and Match canvas size are on by default whenever the plugin opens. Both can be
turned off for an import. Match canvas size changes the Pie device and therefore every scene in it.
Turn off Live auto layout to keep Figma's resolved positions and fixed sizes, including text boxes,
instead of letting Studio recalculate layout. Component instances
with incompatible visibility, paint, structure, styling, or size overrides use their actual visible
editable children instead of substituting an inaccurate source master. This may sacrifice master
sharing; complex artwork still uses the documented SVG fallback.
Import as new creates a separate copy and preserves the previous import. In that mode, an existing
variable name gets an independent suffix such as `_2`, used by the new interactions. Later updates
retain the assigned name.

With Import as new off, an unlinked variable-name collision pauses before any Studio writes. Choose
an action for every variable: Use existing, Create separate variable, or Skip this variable, then
click Continue import. Use existing is available only for matching types; it preserves the current
ProtoPie value during this and later imports. Create separate makes an independent variable. Skip
omits that variable's actions for this attempt and asks again on a later attempt if still unlinked.
Cancel import sends no writes. The timer keeps counting while waiting for your decision.

Manual changes to importer-owned variables remain protected and require restoring their imported
settings if you want syncing to resume. Variable-only conflicts do not offer Import as new as a
recovery action.

If a transport interruption makes a write's result unknowable, the affected scope is blocked from
automatic retry. Inspect it first, or use Import as new to preserve it and create a separate copy.
The report and downloadable snapshot contain useful diagnostics; they include design content.

Earlier development builds used different link data. Their links are preserved, and an explicit
Import as new is required to migrate without guessing which existing layers belong to them.

## Permissions

Approved grants are cached on each recipient's device. Normal grants in the inspected Studio
build expire after 30 minutes idle, disabling MCP, or restarting Studio. The optional auto-approve
launchers are described in [connection permissions](connection-permissions.md); they accept every
local MCP client for that Studio process, not only this plugin.

## Platform validation

Windows build, browser bridge, and live Studio tests have run locally. macOS launchers and CI
configuration are supplied; a macOS app run and actual Figma desktop installation are separate
release gates, not implied by a successful TypeScript build.
