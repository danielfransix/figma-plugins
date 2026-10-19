# Figma plugins

A collection of Figma plugin projects. Each project keeps its own manifest, source files and installation instructions.

## Figma to ProtoPie

[Figma to ProtoPie](figma-to-protopie/README.md) imports editable Figma designs into ProtoPie Studio and updates linked layers. The current version is **0.3.4**.

From this repository's root:

```sh
cd figma-to-protopie
npm ci
npm run build
npm start
```

In Figma desktop, register `figma-to-protopie/figma-plugin/manifest.json` through Plugins > Development > Import plugin from manifest. See the [installation guide](figma-to-protopie/docs/installation.md), [QA results](figma-to-protopie/docs/validation.md) and [release checklist](figma-to-protopie/docs/release-checklist.md).

## Other projects

- [Design system](design-system/)
- [Figlink](figlink-by-danielfransix/)
- [Arrow Manager](figma-arrow-manager/)
- [Bulk Style Manipulator](figma-bulk-style-manipulator/)
- [Color Generator](figma-color-generator/)
- [Component Collector](figma-component-collector/)
- [Linter](figma-linter/)
- [Relinker](figma-relinker/)
- [Selector](figma-selector/)
- [Mosaic Grid Maker](mosaic-grid-maker/)
- [Property Resetter](property%20resetter%20plugin%20for%20figma/)
