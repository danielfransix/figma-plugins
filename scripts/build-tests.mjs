import { build } from "esbuild"
await build({
  entryPoints: [
    "connection",
    "protopie-client",
    "design",
    "read-design",
    "storage",
    "checkpoint",
    "batch",
    "studio",
    "visual",
    "importer",
  ].map((n) => `figma-plugin/src/${n}.ts`),
  outdir: "test/.compiled",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
})
await build({
  entryPoints: ["figma-plugin/src/ui.ts", "figma-plugin/src/code.ts"],
  bundle: true,
  outdir: "figma-plugin",
  target: "es2020",
  format: "iife",
})
