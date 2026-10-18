import { build } from "esbuild"
await Promise.all([
  build({
    entryPoints: ["figma-plugin/src/code.ts"],
    bundle: true,
    outfile: "figma-plugin/code.js",
    target: "es2020",
    format: "iife",
  }),
  build({
    entryPoints: ["figma-plugin/src/ui.ts"],
    bundle: true,
    outfile: "figma-plugin/ui.js",
    target: "es2020",
    format: "iife",
  }),
  build({
    entryPoints: ["scripts/benchmark.mjs"],
    bundle: true,
    outfile: "build/benchmark.mjs",
    target: "node20",
    platform: "node",
    format: "esm",
  }),
])
