import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Studio } from "./.compiled/studio.mjs"
import { importDesign } from "./.compiled/importer.mjs"
import { emptyState } from "./.compiled/design.mjs"
import { sameFingerprint } from "./.compiled/visual.mjs"

test(
  "live Studio: complete import, overrides, identity-preserving updates, conflicts, scoped update, and cleanup",
  { skip: !process.env.F2P_LIVE_CONNECTION },
  async (t) => {
    const { endpoint, connectionId, contextId } = JSON.parse(
      await readFile(process.env.F2P_LIVE_CONNECTION, "utf8"),
    )
    const initial = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "live-context",
        method: "tools/call",
        params: { name: "list_contexts", arguments: { connectionId } },
      }),
    }).then((r) => r.text())
    const envelope = JSON.parse(
      initial
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .at(-1)
        .slice(5),
    )
    const contexts = JSON.parse(envelope.result.content[0].text).contexts
    const scratch = contexts.find(
      (c) =>
        c.isActiveTab &&
        c.tabName === "Untitled" &&
        !c.filePath &&
        (!contextId || c.contextId === contextId),
    )
    assert.ok(scratch, "Open an unsaved Untitled scratch Pie for these tests")
    const studio = new Studio({ endpoint, connectionId, contextId: scratch.contextId })
    const original = await studio.tool("studio_session_init", { include_op_kinds: false })
    const originalScene =
      original.scenes.find((s) => s.id === original.currentSceneId)?.id ?? original.scenes[0]?.id
    assert.ok(originalScene, "The scratch Pie needs an original scene to restore")
    const state = emptyState(),
      prefix = `F2P_QA_${Date.now()}`
    const node = (id, type, props = {}, children = []) => ({
      id,
      type,
      props: { name: id, x: 0, y: 0, width: 120, height: 40, ...props },
      children,
    })
    const master = node(
      `${prefix}_master`,
      "CONTAINER",
      { fillColor: "#E8EEFF", fillEnabled: true },
      [
        node(`${prefix}_label`, "TEXT", {
          text: "Default",
          font: "Inter-Regular",
          fontSize: 16,
          textColor: "#101010",
        }),
      ],
    )
    const instance = node(`${prefix}_instance`, "COMPONENT_INSTANCE", { x: 30, y: 100 })
    instance.component = master.id
    instance.overrides = [{ sourceId: master.children[0].id, props: { text: "Instance text" } }]
    const second = {
      ...structuredClone(instance),
      id: `${prefix}_instance2`,
      props: { ...instance.props, x: 30, y: 160 },
    }
    const rect = node(`${prefix}_rectangle`, "RECT", {
      x: 10,
      y: 10,
      fillColor: "#2299FF",
      fillEnabled: true,
    })
    const root = node(
      prefix,
      "CONTAINER",
      { width: 390, height: 844, fillEnabled: true, fillColor: "#FFFFFF" },
      [rect, instance, second],
    )
    const destination = node(`${prefix}_dest`, "CONTAINER", { width: 390, height: 844 }, [])
    rect.reactions = [
      {
        key: `${rect.id}:0:0`,
        trigger: "tap",
        triggerProps: {},
        action: "navigate",
        destination: destination.id,
        props: { transition: "SMART", duration: 0.3 },
      },
    ]
    const design = {
      version: 2,
      units: [
        { id: root.id, scene: true, root },
        { id: destination.id, scene: true, root: destination },
      ],
      components: [{ id: master.id, name: "QA_Master", root: master }],
      assets: [],
      variables: [{ id: `${prefix}_var`, name: `${prefix}_count`, dataType: "NUMBER", value: 1 }],
      notes: [],
    }
    const run = (d = design) => importDesign(studio, d, state, { allowSharedComponents: true })
    function clean(report) {
      assert.deepEqual(report.errors, [], JSON.stringify(report))
      assert.deepEqual(report.conflicts, [], JSON.stringify(report))
    }
    async function check(label, run) {
      let failure
      await t.test(label, async () => {
        try {
          await run()
        } catch (error) {
          failure = error
          throw error
        }
      })
      if (failure) throw failure
    }
    try {
      await check("creates real components and applies instance text overrides", async () => {
        const result = await run()
        clean(result.report)
        assert.equal(result.report.created.length, 3)
        const scope = state.scopes[`scene:${root.id}`]
        const view = await studio.view(scope.id)
        assert.ok(
          sameFingerprint(view.fingerprint, scope.fingerprint),
          "visual fingerprints must be stable",
        )
        const interaction = await studio.tool("query_interactions", {
          sceneId: scope.id,
          include_properties: true,
        })
        assert.equal(interaction.interactions.length, 1)
        assert.equal(interaction.interactions[0].directResponses[0].properties.transition, "SMART")
        assert.ok(state.variables[`${prefix}_var`]?.id)
        const validation = await studio.tool("inspect_interactions", { sceneId: scope.id })
        assert.equal(validation.issueCount, 0)
      })
      await check("identical re-import performs zero writes", async () => {
        const result = await run()
        clean(result.report)
        assert.equal(result.report.calls, 0)
      })
      await check("editing a layer preserves its id and existing trigger", async () => {
        const oldId = state.scopes[`scene:${root.id}`].nodes[rect.id].id
        const triggerId = Object.values(state.scopes[`scene:${root.id}`].reactions)[0].id
        rect.props.fillColor = "#FF4455"
        const result = await run()
        clean(result.report)
        assert.equal(state.scopes[`scene:${root.id}`].nodes[rect.id].id, oldId)
        assert.equal(Object.values(state.scopes[`scene:${root.id}`].reactions)[0].id, triggerId)
      })
      await check(
        "shared masters update without replacing master or source-layer ids",
        async () => {
          const scope = state.scopes[`component:${master.id}`],
            id = scope.id,
            labelId = scope.nodes[master.children[0].id].id
          master.children[0].props.text = "Updated default"
          const result = await run()
          clean(result.report)
          assert.equal(state.scopes[`component:${master.id}`].id, id)
          assert.equal(
            state.scopes[`component:${master.id}`].nodes[master.children[0].id].id,
            labelId,
          )
        },
      )
      await check("a child selection updates within its existing scene", async () => {
        rect.props.width = 160
        const result = await run({
          ...design,
          components: [],
          variables: [],
          units: [{ id: rect.id, scene: false, parent: root.id, root: rect }],
        })
        clean(result.report)
        assert.equal(Object.keys(state.scopes).length, 3)
        assert.equal(state.scopes[`scene:${root.id}`].nodes[rect.id].props.width, 160)
      })
      await check("clears removed text overrides and supports nested component text", async () => {
        instance.overrides = []
        const nested = node(`${prefix}_nested_source`, "COMPONENT_INSTANCE")
        nested.component = master.id
        const wrapper = node(`${prefix}_wrapper`, "CONTAINER", {}, [nested])
        design.components.push({ id: wrapper.id, name: "QA Wrapper", root: wrapper })
        const placed = node(`${prefix}_nested_instance`, "COMPONENT_INSTANCE", { y: 240 })
        placed.component = wrapper.id
        placed.overrides = [
          {
            sourceId: master.children[0].id,
            instancePath: [nested.id],
            props: { text: "Nested label" },
          },
        ]
        root.children.push(placed)
        const result = await run()
        clean(result.report)
        assert.deepEqual(state.scopes[`scene:${root.id}`].nodes[instance.id].overrides, [])
        assert.equal(
          state.scopes[`scene:${root.id}`].nodes[placed.id].overrides[0].props.text,
          "Nested label",
        )
      })
      await check("manually edited content conflicts instead of being overwritten", async () => {
        const scope = state.scopes[`scene:${root.id}`]
        await studio.tool("start_editing")
        try {
          const r = await studio.write([
            {
              tool: "layer_manage",
              input: {
                sceneId: scope.id,
                action: "batch_edit",
                layers: [{ id: scope.nodes[rect.id].id, properties: { x: 77 } }],
              },
            },
          ])
          assert.equal(r.failureCount, 0)
        } finally {
          await studio.tool("end_editing")
        }
        rect.props.fillColor = "#FFFFFF"
        const result = await run()
        assert.ok(result.report.conflicts.length > 0)
        assert.equal(result.report.calls, 0)
      })
      await check(
        "a protected scene prevents indirect changes through shared and nested masters",
        async () => {
          const nativeMaster = state.scopes[`component:${master.id}`]
          const before = await studio.view(nativeMaster.id, true)
          master.children[0].props.text = "This must not propagate into the protected scene"
          const result = await run()
          assert.ok(result.report.conflicts.some((message) => /master was preserved/.test(message)))
          assert.equal(result.report.calls, 0)
          assert.ok(
            sameFingerprint(
              before.fingerprint,
              (await studio.view(nativeMaster.id, true)).fingerprint,
            ),
          )
        },
      )
    } finally {
      await studio.tool("start_editing")
      try {
        assert.equal(
          (
            await studio.write([
              { tool: "scene_manage", input: { action: "select", sceneIdList: [originalScene] } },
            ])
          ).failureCount,
          0,
        )
        const scenes = Object.values(state.scopes)
          .filter((s) => s.kind === "scene")
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
        for (const scope of Object.values(state.scopes)
          .filter((s) => s.kind === "component")
          .reverse())
          assert.equal(
            (
              await studio.write([
                {
                  tool: "component_manage",
                  input: { action: "delete", componentIdList: [scope.id] },
                },
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
                  input: { sceneId: originalScene, action: "delete", variableIdList: variables },
                },
              ])
            ).failureCount,
            0,
          )
      } finally {
        await studio.tool("end_editing")
      }
    }
  },
)
