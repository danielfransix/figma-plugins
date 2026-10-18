import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Studio } from "../figma-plugin/src/studio.ts"
import { importDesign } from "../figma-plugin/src/importer.ts"
import { emptyState } from "../figma-plugin/src/design.ts"
import {
  initializeSession,
  connectStudio,
  listContexts,
} from "../figma-plugin/src/protopie-client.ts"
const args = process.argv.slice(2)
const option = (key, fallback) => {
  const i = args.indexOf(key)
  return i < 0 ? fallback : args[i + 1]
}
if (args.includes("--help")) {
  console.log(
    "Benchmark: --connection <local grant JSON> [--design <downloaded diagnostic.json>] [--layers 1000] [--batches 50,100,250] [--official-ms <measured baseline>] [--output <result.json>]\nRequires an unsaved Untitled scratch Pie. Created scenes, masters and variables are removed afterward; Studio retains uploaded media resources. Without --connection, Studio asks for approval once.",
  )
  process.exit(0)
}
let connection
if (option("--connection")) connection = JSON.parse(await readFile(option("--connection"), "utf8"))
else {
  const endpoint = option("--endpoint", "http://127.0.0.1:9982/mcp")
  await initializeSession(endpoint)
  console.log("Approve the benchmark connection in Studio if prompted.")
  connection = { endpoint, connectionId: await connectStudio(endpoint) }
}
const contexts = await listContexts(connection.endpoint, connection.connectionId)
const context = contexts.find((c) => c.tabName === "Untitled" && !c.filePath)
if (!context?.isActiveTab)
  throw new Error(
    "Focus an unsaved Untitled scratch Pie before approving the connection. The benchmark will not alter a saved project.",
  )
const studio = new Studio({ ...connection, contextId: context.contextId })
const layers = Number(option("--layers", "1000")),
  sizes = option("--batches", "50,100,250").split(",").map(Number)
if (
  !Number.isInteger(layers) ||
  layers < 1 ||
  layers > 10000 ||
  sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)
)
  throw new Error("Use 1–10000 layers and batch sizes 1–1000")
let design
if (option("--design")) {
  const input = JSON.parse(await readFile(option("--design"), "utf8"))
  design = input.design ?? input
  if (design.version !== 2) throw new Error("Use a version 2 design snapshot")
} else {
  const id = `F2P_BENCH_${Date.now()}`
  const root = {
    id,
    type: "CONTAINER",
    props: {
      name: id,
      x: 0,
      y: 0,
      width: 1440,
      height: 1024,
      fillEnabled: true,
      fillColor: "#FFFFFF",
    },
    children: Array.from({ length: layers }, (_, i) => ({
      id: `${id}_${i}`,
      type: "RECT",
      props: {
        name: `Cell ${i}`,
        x: (i % 36) * 40,
        y: Math.floor(i / 36) * 32,
        width: 32,
        height: 24,
        fillEnabled: true,
        fillColor: i % 2 ? "#2478D4" : "#C3DFFA",
      },
      children: [],
    })),
  }
  design = {
    version: 2,
    units: [{ id, scene: true, root }],
    components: [],
    assets: [],
    variables: [],
    notes: [],
  }
}
const results = [],
  originalSession = await studio.tool("studio_session_init", { include_op_kinds: false })
for (const size of sizes) {
  const state = emptyState()
  try {
    const initial = await importDesign(studio, structuredClone(design), state, {
      limits: { operations: size, bytes: 8 * 1024 * 1024 },
      allowSharedComponents: true,
    })
    if (initial.report.errors.length || initial.report.conflicts.length)
      throw new Error(JSON.stringify(initial.report))
    const noop = await importDesign(studio, structuredClone(design), state, {
      allowSharedComponents: true,
    })
    if (noop.report.errors.length || noop.report.conflicts.length || noop.report.calls !== 0)
      throw new Error(`Unchanged import failed validation: ${JSON.stringify(noop.report)}`)
    results.push({
      batchSize: size,
      importMs: initial.report.milliseconds,
      unchangedMs: noop.report.milliseconds,
      calls: initial.report.calls,
      bytes: initial.report.bytes,
    })
    console.log(JSON.stringify(results.at(-1)))
  } finally {
    await studio.tool("start_editing")
    try {
      if (originalSession.currentSceneId)
        await studio.write([
          {
            tool: "scene_manage",
            input: { action: "select", sceneIdList: [originalSession.currentSceneId] },
          },
        ])
      const scenes = Object.values(state.scopes)
        .filter((s) => s.kind === "scene")
        .map((s) => s.id)
      if (scenes.length) {
        const r = await studio.write([
          { tool: "scene_manage", input: { action: "delete", sceneIdList: scenes } },
        ])
        if (r.failureCount) throw new Error("Benchmark scene cleanup failed")
      }
      for (const scope of Object.values(state.scopes)
        .filter((s) => s.kind === "component")
        .reverse()) {
        const r = await studio.write([
          { tool: "component_manage", input: { action: "delete", componentIdList: [scope.id] } },
        ])
        if (r.failureCount) throw new Error("Benchmark master cleanup failed")
      }
      const variables = Object.values(state.variables).map((v) => v.id)
      if (variables.length)
        await studio.write([
          {
            tool: "variable_manage",
            input: {
              sceneId: originalSession.currentSceneId,
              action: "delete",
              variableIdList: variables,
            },
          },
        ])
      if (originalSession.currentSceneId)
        await studio.write([
          {
            tool: "scene_manage",
            input: { action: "select", sceneIdList: [originalSession.currentSceneId] },
          },
        ])
    } finally {
      await studio.tool("end_editing")
    }
  }
}
const officialMs = Number(option("--official-ms", "0"))
if (officialMs && (!Number.isFinite(officialMs) || officialMs <= 0))
  throw new Error("Baseline must be a positive measured duration")
const summary = {
  date: new Date().toISOString(),
  nodeVersion: process.version,
  platform: process.platform,
  source: option("--design")
    ? "downloaded Figma design snapshot"
    : `synthetic ${layers}-rectangle fixture`,
  studioBuild: originalSession.buildHash,
  includesFigmaRead: false,
  results,
  ...(officialMs
    ? {
        userSuppliedOfficialMs: officialMs,
        speedup: officialMs / Math.min(...results.map((r) => r.importMs)),
      }
    : {}),
}
const output = option("--output", ".scratch-qa/benchmark.json")
await mkdir(dirname(resolve(output)), { recursive: true })
await writeFile(output, JSON.stringify(summary, null, 2))
console.log(`Results saved to ${output}`)
