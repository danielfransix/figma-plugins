# Figma to ProtoPie

Import Figma selections into ProtoPie Studio through its local MCP server. The importer uses deterministic code and native array operations, keeps compatible layer IDs on updates, and protects manually edited target content.

## Install

Extract a packaged development candidate and double-click **Start-Plugin.cmd** on Windows or **Start-Plugin.command** on macOS. Platform packages include Node; recipients do not need npm. In Figma desktop, import **figma-plugin/manifest.json** through Plugins > Development.

Enable ProtoPie's MCP server under Preferences > Labs, open the target Pie, select content in Figma, and run the plugin. Approve the initial Studio connection and click Import. See [installation](docs/installation.md) for source builds and updates.

## Features

- Frames, sections, a page, all pages in a file, or individual layer selections.
- Native rectangles, ellipses, uniform text, corners, rotation, and scrolling containers.
- Live auto layout and Match canvas size enabled by default; turn off Live auto layout to keep resolved Figma positions and fixed dimensions.
- Optional component creation with reusable masters, nested components, compatible instance text overrides, and master updates. Instances with unsupported overrides or different resolved geometry import as their actual editable layers.
- Basic prototype triggers, scene navigation including Smart Animate, URL links, and variables. Normal imports ask how to handle unlinked variable-name collisions; Import as new creates independent variables with unique names.
- Selection-scoped updates, unchanged-content skipping, preserved compatible native IDs, and conflict reporting.
- Cached local grants, cancellation, per-layer acknowledgements, resource reuse, crash recovery protection, and incremental chunked link storage.
- Parent-aware native array creation, a live elapsed timer, and diagnostics that can be saved while an import is running.

Turn off **Create components** to import instances and component definitions as their visible editable layers without creating shared ProtoPie masters. It starts on; **Update shared masters** is disabled while it is off. Existing masters remain in the Pie.

**Clip truncated text** starts on. Single-line text with Figma truncation enabled is imported as editable Auto Width text inside a clipping container. The container inherits the source width and Fill sizing (with Live auto layout on), preserving the available space without wrapping or adding ellipses. Turn it off for the previous text behavior. Ordinary wrapping text and multi-line truncation are unchanged. Changing this setting applies on the next import; updating existing shared masters still requires **Update shared masters**.

Complex paints, mixed or decorated text, masks, vectors, and unsupported effects use SVG images with explicit notes. Instances whose source masters are hidden also use an SVG of the visible instance. Empty exported artwork keeps an invisible layout placeholder; other export failures identify the layer in the downloaded diagnostic. Advanced conditional prototypes, overlays, interactive variant changes, and media actions are reported as unsupported. See [release checklist](docs/release-checklist.md) for the exact boundaries and external release gates.

## Permission prompts

The plugin reuses a valid approved grant when reopened. The tested Studio build expires grants after 30 minutes idle or a restart. Each recipient approves their own connection. Optional Windows/macOS launchers use an undocumented Studio switch to approve all local MCP clients for that process. Read [connection permissions](docs/connection-permissions.md) before enabling it.

**Disconnect** stops this plugin and forgets its saved approval. It stays disconnected when reopened until you click **Connect**. Existing imports remain linked. To switch Pies, focus the desired Studio tab and choose **Import settings → Connect to current ProtoPie tab**.

## Development

Requires Node.js 20 or newer. In Windows PowerShell, use npm.cmd/npx.cmd if script execution is disabled.

```sh
npm ci
npx playwright install chromium
npm test
npm run build
npm start
```

The runtime helper has no npm dependencies and binds only to 127.0.0.1:9983. Figma's bootstrap hosts this localhost panel because Studio rejects direct requests from Figma's opaque origin.

```sh
npm run doctor
npm run test:live
npm run benchmark -- --help
npm run package -- --with-runtime
```

Live tests require F2P_LIVE_CONNECTION pointing to a private local grant JSON and an unsaved Untitled scratch Pie. They clean up only their own test content. Never share the grant file.

## Validation and distribution

See [validation](docs/validation.md) for measured results and their limits. A comparison against the official importer remains unmeasured; no speedup over that importer is claimed. The current manifest is a development placeholder. Figma Community publication needs the owner's assigned numeric plugin ID and the app checks in the release checklist.

[Feasibility research and original plan](docs/feasibility.md) preserve the investigation history. MIT licensed.
