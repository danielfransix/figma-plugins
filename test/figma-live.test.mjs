import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { Studio } from "./.compiled/studio.mjs"
import { importDesign } from "./.compiled/importer.mjs"
import { emptyState } from "./.compiled/design.mjs"
import { callToolContent, listContexts } from "./.compiled/protopie-client.mjs"

test(
  "real Figma reader snapshot imports native layout, instance text, variables and Smart Animate",
  { skip: !process.env.F2P_LIVE_CONNECTION },
  async () => {
    const connection = JSON.parse(await readFile(process.env.F2P_LIVE_CONNECTION, "utf8"))
    const contexts = await listContexts(connection.endpoint, connection.connectionId)
    const scratch = contexts.find((c) => c.tabName === "Untitled" && !c.filePath)
    assert.ok(scratch?.isActiveTab, "Focus an unsaved Untitled scratch Pie")
    const studio = new Studio({ ...connection, contextId: scratch.contextId }),
      state = emptyState()
    const design = JSON.parse(
      await readFile(new URL("./fixtures/figma-source.json", import.meta.url), "utf8"),
    )
    const original = await studio.tool("studio_session_init", { include_op_kinds: false })
    try {
      const first = await importDesign(studio, design, state, { allowSharedComponents: true })
      assert.deepEqual(first.report.errors, [])
      assert.deepEqual(first.report.conflicts, [])
      const scope = state.scopes[`scene:${design.units[0].id}`]
      const interactions = await studio.tool("query_interactions", {
        sceneId: scope.id,
        include_properties: true,
      })
      assert.equal(interactions.interactions.length, 2)
      for (const trigger of interactions.interactions) {
        const props = trigger.directResponses[0].properties
        assert.equal(props.transition, "SMART")
        assert.equal(props.easingFunction, "CUBIC_BEZIER")
      }
      assert.equal((await studio.tool("inspect_interactions", { sceneId: scope.id })).issueCount, 0)
      const second = await importDesign(studio, design, state, { allowSharedComponents: true })
      assert.equal(second.report.calls, 0)
      assert.deepEqual(second.report.errors, [])
      await mkdir(".scratch-qa", { recursive: true })
      await writeFile(
        ".scratch-qa/real-figma-live-report.json",
        JSON.stringify({ first: first.report, unchanged: second.report }, null, 2),
      )
      const content = await callToolContent(connection.endpoint, "capture_preview", {
        connectionId: connection.connectionId,
        contextId: scratch.contextId,
        sceneId: scope.id,
      })
      const image = content.find((c) => c.type === "image")
      assert.ok(image)
      await writeFile(".scratch-qa/real-figma-studio.png", Buffer.from(image.data, "base64"))
    } finally {
      await studio.tool("start_editing")
      try {
        if (original.currentSceneId)
          await studio.write([
            {
              tool: "scene_manage",
              input: { action: "select", sceneIdList: [original.currentSceneId] },
            },
          ])
        const scenes = Object.values(state.scopes)
          .filter((s) => s.kind === "scene" && s.id)
          .map((s) => s.id)
        if (scenes.length)
          assert.equal(
            (
              await studio.write([
                { tool: "scene_manage", input: { action: "delete", sceneIdList: scenes } },
              ])
            ).failureCount,
            0,
          )
        for (const s of Object.values(state.scopes)
          .filter((s) => s.kind === "component" && s.id)
          .reverse())
          assert.equal(
            (
              await studio.write([
                { tool: "component_manage", input: { action: "delete", componentIdList: [s.id] } },
              ])
            ).failureCount,
            0,
          )
        const variables = Object.values(state.variables).map((v) => v.id)
        if (variables.length)
          assert.equal(
            (
              await studio.write([
                {
                  tool: "variable_manage",
                  input: {
                    sceneId: original.currentSceneId,
                    action: "delete",
                    variableIdList: variables,
                  },
                },
              ])
            ).failureCount,
            0,
          )
        if (original.currentSceneId)
          await studio.write([
            {
              tool: "scene_manage",
              input: { action: "select", sceneIdList: [original.currentSceneId] },
            },
          ])
      } finally {
        await studio.tool("end_editing")
      }
    }
  },
)
