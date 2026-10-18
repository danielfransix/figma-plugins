import { test } from "node:test"
import assert from "node:assert/strict"
import { importDesign, componentOrder } from "./.compiled/importer.mjs"
import { emptyState } from "./.compiled/design.mjs"
import { FakeStudio, fixture } from "./fixtures/studio.mjs"
test("unchanged imports write nothing; changed layers keep their ids", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  await importDesign(studio, design, state)
  const id = state.scopes["scene:screen"].nodes.button.id
  assert.equal((await importDesign(studio, design, state)).report.calls, 0)
  button.props.width = 150
  const report = (await importDesign(studio, design, state)).report
  assert.deepEqual(report.errors, [])
  assert.equal(state.scopes["scene:screen"].nodes.button.id, id)
  assert.equal(studio.nodes.get(id).props.width, 150)
  assert.equal(studio.operations.filter((op) => op.input.action === "delete").length, 0)
})

test("alternating native thumbnail workers still require an exact prior baseline", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture(),
    view = studio.view.bind(studio)
  let counter = 0
  studio.view = async (...args) => {
    const result = await view(...args)
    return { ...result, fingerprint: result.fingerprint + "-" + (counter++ % 2) }
  }
  assert.deepEqual((await importDesign(studio, design, state)).report.errors, [])
  button.props.width = 140
  assert.deepEqual((await importDesign(studio, design, state)).report.conflicts, [])
  const id = state.scopes["scene:screen"].nodes.button.id
  studio.nodes.get(id).props.fillColor = "#FF0000"
  button.props.width = 150
  const result = await importDesign(studio, design, state)
  assert.ok(result.report.conflicts.length)
  assert.equal(result.report.calls, 0)
})
test("a native manual edit blocks overwrites and preserves target content", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  await importDesign(studio, design, state)
  const id = state.scopes["scene:screen"].nodes.button.id
  studio.nodes.get(id).props.fillColor = "#FF0000"
  button.props.width = 150
  const result = await importDesign(studio, design, state)
  assert.equal(result.report.conflicts.length, 1)
  assert.equal(result.report.calls, 0)
  assert.equal(studio.nodes.get(id).props.width, 100)
})

for (const nested of [false, true])
  test(`a protected scene blocks ${nested ? "nested" : "direct"} shared-master changes`, async () => {
    const studio = new FakeStudio(),
      state = emptyState(),
      { design, root, node } = fixture()
    const label = node("master-label", "TEXT", { text: "Original" })
    design.components = [
      { id: "inner", name: "Inner", root: node("inner-root", "CONTAINER", {}, [label]) },
    ]
    const instance = node("instance", "COMPONENT_INSTANCE")
    instance.component = "inner"
    if (nested) {
      design.components.push({
        id: "outer",
        name: "Outer",
        root: node("outer-root", "CONTAINER", {}, [instance]),
      })
      const outer = node("outer-instance", "COMPONENT_INSTANCE")
      outer.component = "outer"
      root.children = [outer]
    } else root.children = [instance]
    assert.deepEqual((await importDesign(studio, design, state)).report.errors, [])
    const scope = state.scopes["scene:screen"]
    studio.nodes.get(scope.nodes.screen.id).props.fillColor = "#FF0000"
    label.props.text = "Changed"
    const report = (await importDesign(studio, design, state, { allowSharedComponents: true }))
      .report
    assert.ok(report.conflicts.some((message) => /master was preserved/.test(message)))
    assert.equal(report.calls, 0)
    const native = state.scopes["component:inner"].nodes["master-label"].id
    assert.equal(studio.nodes.get(native).props.text, "Original")
  })

test("unstable native previews never become a trusted baseline or permit later writes", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  const view = studio.view.bind(studio)
  let capture = 0
  studio.view = async (...args) => ({
    ...(await view(...args)),
    fingerprint: `incomplete-${++capture}`,
  })
  const first = await importDesign(studio, design, state)
  assert.deepEqual(first.report.errors, [])
  assert.ok(
    first.report.verificationPending.some((message) => /baseline is still changing/.test(message)),
  )
  assert.equal(state.scopes["scene:screen"].fingerprint, "")
  button.props.width = 160
  const next = await importDesign(studio, design, state)
  assert.ok(next.report.conflicts.length)
  assert.equal(next.report.calls, 0)
  assert.equal(studio.scenes.size, 1)
})

test("global-variable writes pin a live scene when Studio's current artboard was deleted", async () => {
  const studio = new FakeStudio(),
    { design } = fixture()
  const tool = studio.tool.bind(studio)
  studio.tool = async (name, args) =>
    name === "studio_session_init"
      ? { currentSceneId: "deleted", scenes: [{ id: "original" }] }
      : tool(name, args)
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  const result = await importDesign(studio, design)
  assert.deepEqual(result.report.errors, [])
  assert.equal(
    studio.operations.find((op) => op.tool === "variable_manage").input.sceneId,
    "original",
  )
})
test("partial failure commits only acknowledged nodes and retries without duplicates", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design } = fixture()
  studio.failName = "button"
  const first = await importDesign(studio, design, state)
  assert.ok(first.report.errors.length)
  assert.equal(state.scopes["scene:screen"].hash, "")
  const rootId = state.scopes["scene:screen"].nodes.screen.id
  assert.equal(state.scopes["scene:screen"].nodes.button, undefined)
  studio.failName = null
  const second = await importDesign(studio, design, state)
  assert.deepEqual(second.report.errors, [])
  assert.equal(studio.nodes.size, 2)
  assert.equal(state.scopes["scene:screen"].nodes.screen.id, rootId)
})
test("changing a container's type rebuilds its descendants safely", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, root, node } = fixture()
  const child = node("group", "CONTAINER", {}, [
    node("label", "TEXT", { text: "Hi", font: "Inter" }),
  ])
  root.children = [child]
  await importDesign(studio, design, state)
  const oldChild = state.scopes["scene:screen"].nodes.label.id
  child.type = "RECT"
  child.children = []
  const result = await importDesign(studio, design, state)
  assert.deepEqual(result.report.errors, [])
  assert.equal(studio.nodes.has(oldChild), false)
  assert.equal(state.scopes["scene:screen"].nodes.label, undefined)
})
test("a selected child updates within the existing parent and scene", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  await importDesign(studio, design, state)
  button.props.width = 130
  const result = await importDesign(
    studio,
    { ...design, units: [{ id: "button", scene: false, parent: "screen", root: button }] },
    state,
  )
  assert.deepEqual(result.report.errors, [])
  assert.equal(studio.scenes.size, 1)
  assert.equal(state.scopes["scene:screen"].nodes.button.props.width, 130)
})

test("a rejected deletion never creates a replacement beside the old layer", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  await importDesign(studio, design, state)
  const id = state.scopes["scene:screen"].nodes.button.id,
    write = studio.write.bind(studio)
  studio.write = async (ops) =>
    ops.some((o) => o.input.action === "delete")
      ? {
          results: ops.map(() => ({ success: false, errors: [{ error: "Deletion rejected" }] })),
          failureCount: 1,
        }
      : write(ops)
  button.type = "OVAL"
  const result = await importDesign(studio, design, state)
  assert.ok(result.report.errors.length)
  assert.equal(studio.nodes.size, 2)
  assert.equal(state.scopes["scene:screen"].nodes.button.id, id)
})
test("resources shared by many layers are uploaded once", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, root, node } = fixture()
  design.assets = [
    { key: "asset", mimeType: "image/svg+xml", data: '<svg width="10" height="10"/>' },
  ]
  root.children = [node("image1", "IMAGE"), node("image2", "IMAGE")]
  root.children.forEach((n) => {
    n.asset = "asset"
  })
  const result = await importDesign(studio, design, state)
  assert.deepEqual(result.report.errors, [])
  assert.equal(studio.assets.size, 1)
})
test("component dependency order handles nested masters and rejects cycles", () => {
  const { node } = fixture(),
    a = { id: "a", name: "A", root: node("rootA", "CONTAINER") },
    b = { id: "b", name: "B", root: node("rootB", "CONTAINER") }
  a.root.component = "b"
  assert.deepEqual(
    componentOrder([a, b]).map((c) => c.id),
    ["b", "a"],
  )
  b.root.component = "a"
  assert.throws(() => componentOrder([a, b]), /Circular/)
})
test("cancellation releases the editing lock and keeps the acknowledged scene", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design } = fixture(),
    controller = new AbortController()
  const write = studio.write.bind(studio)
  studio.write = async (ops) => {
    const r = await write(ops)
    controller.abort()
    return r
  }
  const result = await importDesign(studio, design, state, { signal: controller.signal })
  assert.equal(studio.locked, false)
  assert.ok(result.report.errors.some((e) => /cancelled/.test(e)))
  assert.equal(studio.scenes.size, 1)
})

test("every scoped write persists an uncertainty marker before sending and clears it after acknowledgement", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design } = fixture(),
    snapshots = []
  const original = studio.write.bind(studio)
  studio.write = async (ops) => {
    assert.ok(Object.values(snapshots.at(-1).scopes).some((s) => s.recoveryRequired))
    return original(ops)
  }
  await importDesign(
    studio,
    design,
    state,
    {},
    () => {},
    async (s) => snapshots.push(structuredClone(s)),
  )
  assert.ok(snapshots.length > 2)
  assert.ok(Object.values(snapshots.at(-1).scopes).every((s) => !s.recoveryRequired))
})

test("an interrupted write is blocked on retry even if the source has not changed", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design } = fixture()
  await importDesign(studio, design, state)
  state.scopes["scene:screen"].recoveryRequired = "A write was interrupted"
  const result = await importDesign(studio, design, state)
  assert.equal(result.report.calls, 0)
  assert.match(result.report.conflicts[0], /interrupted/)
})

test("a failed response creation retries without duplicating its trigger", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  button.reactions = [
    {
      key: "button:0:0",
      trigger: "tap",
      triggerProps: {},
      action: "url",
      props: { url: "https://example.com" },
    },
  ]
  const write = studio.write.bind(studio)
  let fail = true
  studio.write = async (ops) => {
    if (fail && ops.some((o) => o.tool === "response_manage")) {
      const results = []
      for (const op of ops) {
        if (op.tool === "response_manage")
          results.push({ success: false, errors: [{ error: "Injected response failure" }] })
        else results.push((await write([op])).results[0])
      }
      return { results, failureCount: 1 }
    }
    return write(ops)
  }
  const first = await importDesign(studio, design, state)
  assert.ok(first.report.errors.length)
  assert.equal(studio.triggers.size, 1)
  fail = false
  const second = await importDesign(studio, design, state)
  assert.deepEqual(second.report.errors, [])
  assert.equal(studio.triggers.size, 1)
  assert.equal([...studio.triggers.values()][0].directResponses.length, 1)
})

test("per-import Studio metrics exclude earlier runs while timing acknowledged checkpoints", async () => {
  const studio = new FakeStudio(),
    { design } = fixture(),
    state = emptyState()
  studio.metrics = { compose_pie: { calls: 7, milliseconds: 70 } }
  const write = studio.write.bind(studio)
  studio.write = async (...args) => {
    studio.metrics.compose_pie.calls++
    studio.metrics.compose_pie.milliseconds += 10
    return write(...args)
  }
  const first = await importDesign(studio, design, state)
  assert.equal(first.report.studioCalls.compose_pie.calls, first.report.calls)
  assert.equal(first.report.studioCalls.compose_pie.milliseconds, first.report.calls * 10)
  assert.ok(first.report.linkSaveMilliseconds >= 0)
  const unchanged = await importDesign(studio, design, state)
  assert.equal(unchanged.report.calls, 0)
  assert.equal(unchanged.report.studioCalls.compose_pie, undefined)
})

test("a large nested table imports through bulk arrays with correct parent links and stable update IDs", async () => {
  const { design, root, node } = fixture(),
    studio = new FakeStudio(),
    state = emptyState()
  root.children = Array.from({ length: 80 }, (_, row) =>
    node(
      "row" + row,
      "CONTAINER",
      {},
      Array.from({ length: 8 }, (_, col) =>
        node(`cell${row}_${col}`, "CONTAINER", {}, [
          node(`text${row}_${col}`, "TEXT", { text: `Field ${row} ${col}` }),
        ]),
      ),
    ),
  )
  const first = await importDesign(studio, design, state)
  assert.deepEqual(first.report.errors, [])
  assert.equal(studio.nodes.size, 1361)
  assert.ok(
    studio.operations.filter((op) => op.tool === "layer_manage").length <= 12,
    "nested containers must not regress to per-layer native dispatch",
  )
  const nodes = state.scopes["scene:screen"].nodes
  for (const record of Object.values(nodes))
    if (record.parent) assert.equal(studio.nodes.get(record.id).parent, nodes[record.parent].id)
  assert.equal((await importDesign(studio, design, state)).report.calls, 0)
  const original = nodes.text0_0.id
  root.children[0].children[0].children[0].props.text = "Updated"
  assert.deepEqual((await importDesign(studio, design, state)).report.errors, [])
  assert.equal(nodes.text0_0.id, original)
  assert.equal(studio.nodes.get(original).props.text, "Updated")
})

test("deleted masters and interrupted scenes block updates but a fresh import creates separate links", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, root, node } = fixture()
  design.components = [
    {
      id: "master",
      name: "Master",
      root: node("master-root", "CONTAINER", {}, [node("label", "TEXT", { text: "Label" })]),
    },
  ]
  const instance = node("instance", "COMPONENT_INSTANCE")
  instance.component = "master"
  root.children = [instance]
  await importDesign(studio, design, state)
  const sceneId = state.scopes["scene:screen"].id,
    masterId = state.scopes["component:master"].id
  studio.components.delete(masterId)
  state.scopes["component:master"].hash = "changed"
  state.scopes["scene:screen"].recoveryRequired = "An earlier write was interrupted"
  const before = studio.operations.length
  const blocked = await importDesign(studio, design, state)
  assert.ok(blocked.report.conflicts.length)
  assert.equal(blocked.report.calls, 0)
  assert.equal(studio.operations.length, before)
  const next = await importDesign(studio, design, emptyState())
  assert.deepEqual(next.report.errors, [])
  assert.deepEqual(next.report.conflicts, [])
  assert.notEqual(next.state.scopes["scene:screen"].id, sceneId)
  assert.notEqual(next.state.scopes["component:master"].id, masterId)
  assert.ok(studio.scenes.has(sceneId), "existing content must be preserved")
  assert.equal(
    studio.operations.slice(before).some((op) => op.input.action === "delete"),
    false,
  )
})

test("fresh variable collisions create independent bindings and keep names stable on updates", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  design.variables = [{ id: "count", name: "F2P_Count", dataType: "NUMBER", value: 1 }]
  button.reactions = [
    {
      key: "button:set",
      trigger: "tap",
      triggerProps: {},
      action: "variable",
      destination: "count",
      props: { value: 2 },
    },
  ]
  studio.variables.set("existing", {
    id: "existing",
    name: "F2P_Count",
    dataType: "NUMBER",
    value: 1,
  })
  studio.variables.set("occupied", {
    id: "occupied",
    name: "F2P_Count_2",
    dataType: "STRING",
    value: "manual",
  })
  const result = await importDesign(studio, design, state, { newImport: true })
  assert.deepEqual(result.report.errors, [])
  assert.deepEqual(result.report.conflicts, [])
  assert.equal(result.report.canImportAsNew, false)
  assert.match(result.report.notes.join("\n"), /F2P_Count_3/)
  const record = structuredClone(state.variables.count)
  assert.equal(record.name, "F2P_Count_3")
  assert.equal(record.sourceName, "F2P_Count")
  assert.equal(studio.variables.get("existing").value, 1)
  assert.equal(studio.variables.get("occupied").value, "manual")
  const response = studio.operations.find((op) => op.tool === "response_manage")
  assert.equal(response.input.responses[0].properties.varName, "F2P_Count_3")
  assert.equal((await importDesign(studio, design, state)).report.calls, 0)
  design.variables[0].value = 5
  const changed = await importDesign(studio, design, state)
  assert.deepEqual(changed.report.conflicts, [])
  assert.equal(state.variables.count.id, record.id)
  assert.equal(state.variables.count.name, record.name)
  assert.equal(studio.variables.get(record.id).value, 5)
  assert.equal(studio.variables.get("existing").value, 1)
  const fresh = await importDesign(studio, design, emptyState(), { newImport: true })
  assert.equal(fresh.state.variables.count.name, "F2P_Count_4")
  assert.deepEqual(fresh.report.conflicts, [])
})

for (const field of ["value", "name", "dataType"])
  test(`a manually changed linked variable ${field} is protected without a fresh-import suggestion`, async () => {
    const studio = new FakeStudio(),
      state = emptyState(),
      { design, button } = fixture()
    design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
    await importDesign(studio, design, state)
    const variable = studio.variables.get(state.variables.count.id)
    variable[field] = field === "value" ? 77 : field === "name" ? "ManualCount" : "STRING"
    design.variables[0].value = 2
    button.reactions = [
      {
        key: "button:set",
        trigger: "tap",
        triggerProps: {},
        action: "variable",
        destination: "count",
        props: { value: 2 },
      },
    ]
    const before = studio.operations.length
    const result = await importDesign(studio, design, state)
    assert.equal(result.report.conflicts.length, 1)
    assert.equal(result.report.canImportAsNew, false)
    assert.match(result.report.conflicts[0], /Restore it in ProtoPie/)
    assert.equal(
      studio.operations
        .slice(before)
        .some((op) => op.tool === "variable_manage" || op.tool === "response_manage"),
      false,
    )
    assert.equal(
      variable[field],
      field === "value" ? 77 : field === "name" ? "ManualCount" : "STRING",
    )
  })

test("a deleted linked variable is recreated and its reaction binding is refreshed", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  button.reactions = [
    {
      key: "button:set",
      trigger: "tap",
      triggerProps: {},
      action: "variable",
      destination: "count",
      props: { value: 2 },
    },
  ]
  await importDesign(studio, design, state)
  const oldId = state.variables.count.id
  studio.variables.delete(oldId)
  studio.variables.set("manual", { id: "manual", name: "count", dataType: "NUMBER", value: 99 })
  const before = studio.operations.length
  const next = await importDesign(studio, design, state, {
    resolveVariableCollisions: async () => ({ count: "create" }),
  })
  assert.deepEqual(next.report.errors, [])
  assert.deepEqual(next.report.conflicts, [])
  assert.notEqual(state.variables.count.id, oldId)
  assert.equal(state.variables.count.name, "count_2")
  const response = studio.operations.slice(before).find((op) => op.tool === "response_manage")
  assert.equal(response.input.responses[0].properties.varName, "count_2")
  assert.equal(studio.variables.get("manual").value, 99)
})

test("source variable renames avoid collisions and preserve the owned native ID", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design } = fixture()
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  await importDesign(studio, design, state)
  const oldId = state.variables.count.id
  delete state.variables.count.sourceName
  delete state.variables.count.dataType
  studio.variables.set("manual", { id: "manual", name: "renamed", dataType: "NUMBER", value: 99 })
  design.variables[0].name = "renamed"
  const next = await importDesign(studio, design, state)
  assert.deepEqual(next.report.conflicts, [])
  assert.deepEqual(next.report.errors, [])
  assert.equal(state.variables.count.name, "renamed_2")
  assert.equal(state.variables.count.id, oldId)
  assert.equal(state.variables.count.sourceName, "renamed")
  assert.equal((await importDesign(studio, design, state)).report.calls, 0)
})

test("a normal import with an unlinked name collision makes no writes without a choice", async () => {
  const studio = new FakeStudio(),
    { design } = fixture()
  studio.variables.set("manual", { id: "manual", name: "count", dataType: "NUMBER", value: 8 })
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  const result = await importDesign(studio, design)
  assert.equal(result.report.calls, 0)
  assert.equal(result.report.variableCollisions[0].existing.id, "manual")
  assert.equal(result.report.canImportAsNew, false)
  assert.equal(studio.operations.length, 0)
  assert.equal(studio.locked, false)
  assert.equal(studio.variables.size, 1)
})

test("choosing an existing variable keeps its value and never makes it importer-owned", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  studio.variables.set("manual", { id: "manual", name: "count", dataType: "NUMBER", value: 8 })
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  button.reactions = [
    {
      key: "button:set",
      trigger: "tap",
      triggerProps: {},
      action: "variable",
      destination: "count",
      props: { value: 2 },
    },
  ]
  const first = await importDesign(studio, design, state, {
    resolveVariableCollisions: async (collisions) => {
      assert.equal(studio.locked, false, "choice must precede the editing lock")
      assert.equal(studio.operations.length, 0)
      assert.equal(collisions[0].existing.value, 8)
      return { count: "existing" }
    },
  })
  assert.deepEqual(first.report.conflicts, [])
  assert.equal(state.variables.count.id, "manual")
  assert.equal(state.variables.count.external, true)
  assert.equal(studio.variables.get("manual").value, 8)
  assert.equal(
    studio.operations.some((op) => op.tool === "variable_manage"),
    false,
  )
  assert.equal(
    studio.operations.find((op) => op.tool === "response_manage").input.responses[0].properties
      .varName,
    "count",
  )
  design.variables[0].value = 55
  studio.variables.get("manual").value = 99
  assert.equal((await importDesign(studio, design, state)).report.calls, 0)
  assert.equal(studio.variables.get("manual").value, 99)
  design.variables[0].dataType = "STRING"
  design.variables[0].value = "changed"
  const incompatible = await importDesign(studio, design, state)
  assert.ok(incompatible.report.conflicts.length)
  assert.equal(studio.variables.get("manual").dataType, "NUMBER")
  assert.equal(studio.variables.get("manual").value, 99)
})

test("explicit skip omits a variable and its actions without changing the existing variable", async () => {
  const studio = new FakeStudio(),
    { design, button } = fixture()
  studio.variables.set("manual", { id: "manual", name: "count", dataType: "NUMBER", value: 8 })
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  button.reactions = [
    {
      key: "button:set",
      trigger: "tap",
      triggerProps: {},
      action: "variable",
      destination: "count",
      props: { value: 2 },
    },
  ]
  const result = await importDesign(studio, design, emptyState(), {
    resolveVariableCollisions: async () => ({ count: "skip" }),
  })
  assert.deepEqual(result.report.conflicts, [])
  assert.equal(result.state.variables.count, undefined)
  assert.equal(studio.variables.size, 1)
  assert.equal(
    studio.operations.some((op) => op.tool === "variable_manage" || op.tool === "response_manage"),
    false,
  )
})

test("cancelling or rejecting an incompatible reuse choice sends no writes", async () => {
  const studio = new FakeStudio(),
    { design } = fixture()
  studio.variables.set("manual", {
    id: "manual",
    name: "count",
    dataType: "STRING",
    value: "manual",
  })
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  await importDesign(studio, design, emptyState(), { resolveVariableCollisions: async () => null })
  assert.equal(studio.operations.length, 0)
  await assert.rejects(
    importDesign(studio, design, emptyState(), {
      resolveVariableCollisions: async (collisions) => {
        assert.equal(collisions[0].canReuse, false)
        return { count: "existing" }
      },
    }),
    /Choose a valid action/,
  )
  assert.equal(studio.operations.length, 0)
  assert.equal(studio.locked, false)
})

test("reuse choices are revalidated after the user responds before any write", async () => {
  const studio = new FakeStudio(),
    { design } = fixture()
  studio.variables.set("manual", { id: "manual", name: "count", dataType: "NUMBER", value: 8 })
  design.variables = [{ id: "count", name: "count", dataType: "NUMBER", value: 1 }]
  await assert.rejects(
    importDesign(studio, design, emptyState(), {
      resolveVariableCollisions: async () => {
        studio.variables.delete("manual")
        return { count: "existing" }
      },
    }),
    /changed while you were choosing/,
  )
  assert.equal(studio.operations.length, 0)
  assert.equal(studio.locked, false)
})

test("preloaded images keep mixed image/text siblings in bulk arrays and use acknowledged resources", async () => {
  const { design, root, node } = fixture(),
    studio = new FakeStudio(),
    state = emptyState()
  design.assets = Array.from({ length: 60 }, (_, i) => ({
    key: `asset${i}`,
    mimeType: "image/svg+xml",
    data: `<svg id="${i}"/>`,
  }))
  root.children = design.assets.flatMap((asset, i) => {
    const image = node(`image${i}`, "IMAGE")
    image.asset = asset.key
    return [image, node(`label${i}`, "TEXT", { text: `Row ${i}` })]
  })
  const write = studio.write.bind(studio)
  let writes = 0
  studio.write = async (ops) => {
    writes++
    for (const op of ops)
      if (op.tool === "layer_manage" && op.input.action === "batch_add") {
        for (const item of op.input.layers)
          if (item.layerType === "IMAGE") {
            assert.ok(
              studio.assets.has(item.properties.resourceId),
              "resources must be acknowledged in an earlier request",
            )
          }
      }
    return write(ops)
  }
  const result = await importDesign(studio, design, state)
  assert.deepEqual(result.report.errors, [])
  assert.equal(studio.assets.size, 60)
  assert.equal(studio.nodes.size, 121)
  assert.ok(writes <= 4, `expected bulk requests, received ${writes}`)
})

for (const malformed of [false, true])
  test(`a ${malformed ? "missing resource ID" : "failed image upload"} cannot replace existing layers`, async () => {
    const { design, root, node } = fixture(),
      studio = new FakeStudio(),
      state = emptyState()
    await importDesign(studio, design, state)
    const previous = [...studio.nodes.keys()]
    const image = node("replacement", "IMAGE")
    image.asset = "photo"
    root.children = [image]
    design.assets = [{ key: "photo", mimeType: "image/svg+xml", data: "<svg/>" }]
    const write = studio.write.bind(studio)
    studio.write = async (ops) =>
      ops.some((op) => op.tool === "resource_manage")
        ? {
            results: ops.map(() =>
              malformed
                ? { success: true }
                : { success: false, errors: [{ error: "Rejected resource" }] },
            ),
          }
        : write(ops)
    const result = await importDesign(studio, design, state)
    assert.ok(result.report.errors.length)
    assert.deepEqual([...studio.nodes.keys()], previous)
    assert.equal(state.assets.photo, undefined)
    assert.equal(
      studio.operations.some((op) => op.input.action === "delete"),
      false,
    )
  })

function layoutFixture() {
  const f = fixture()
  f.root.props.layoutMode = "HORIZONTAL"
  f.root.props.layoutSizingHorizontal = "HUG"
  f.root.children = Array.from({ length: 140 }, (_, i) =>
    f.node(
      `row${i}`,
      "CONTAINER",
      {
        layoutMode: "VERTICAL",
        primaryAxisSizingMode: "AUTO",
        counterAxisSizingMode: "FIXED",
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "HUG",
        itemSpacing: 8,
      },
      [f.node(`text${i}`, "TEXT", { text: `Row ${i}` })],
    ),
  )
  return f
}

test("large live layouts activate bottom-up after all layers exist and keep final properties and IDs", async () => {
  const { design, root } = layoutFixture(),
    studio = new FakeStudio(),
    state = emptyState()
  const write = studio.write.bind(studio),
    restored = [],
    snapshots = []
  studio.write = async (ops) => {
    for (const op of ops) {
      if (op.input.action === "batch_add" && op.tool === "layer_manage") {
        for (const item of op.input.layers)
          if (item.layerType === "CONTAINER") {
            assert.equal(
              item.properties.layoutMode,
              item.properties.name === "screen" ? "NONE" : "VERTICAL",
            )
            if (item.properties.name === "screen")
              assert.equal(item.properties.layoutSizingHorizontal, "FIXED")
          }
      }
      if (op.input.action === "batch_edit") {
        assert.equal(studio.nodes.size, 281)
        restored.push(...op.input.layers.map((item) => item.id))
      }
    }
    return write(ops)
  }
  const result = await importDesign(
    studio,
    design,
    state,
    {},
    () => {},
    async (s) => snapshots.push(structuredClone(s)),
  )
  assert.deepEqual(result.report.errors, [])
  const scope = state.scopes["scene:screen"]
  assert.equal(
    restored.length,
    1,
    "tiny wrappers must not incur a separate layout-restoration edit",
  )
  assert.equal(restored.at(-1), scope.nodes.screen.id)
  assert.equal(studio.nodes.get(scope.nodes.screen.id).props.layoutMode, "HORIZONTAL")
  assert.equal(studio.nodes.get(scope.nodes.row0.id).props.layoutSizingVertical, "HUG")
  assert.deepEqual(scope.nodes.row0.props, root.children[0].props)
  assert.equal(scope.recoveryRequired, undefined)
  assert.ok(snapshots.some((s) => /layout/.test(s.scopes["scene:screen"].recoveryRequired ?? "")))
  assert.equal((await importDesign(studio, design, state)).report.calls, 0)
})

test("a rejected deferred layout remains protected on retry instead of accepting temporary geometry", async () => {
  const { design } = layoutFixture(),
    studio = new FakeStudio(),
    state = emptyState()
  const write = studio.write.bind(studio)
  studio.write = async (ops) =>
    ops.some((op) => op.input.action === "batch_edit")
      ? {
          results: ops.map(() => ({
            success: false,
            errors: [{ error: "Layout restore rejected" }],
          })),
        }
      : write(ops)
  const first = await importDesign(studio, design, state)
  assert.ok(first.report.errors.length)
  assert.match(state.scopes["scene:screen"].recoveryRequired, /layout/)
  assert.equal(
    studio.nodes.get(state.scopes["scene:screen"].nodes.screen.id).props.layoutMode,
    "NONE",
  )
  const next = await importDesign(studio, design, state)
  assert.equal(next.report.calls, 0)
  assert.ok(next.report.conflicts.length)
  assert.equal(studio.locked, false)
})

test("multi-batch writes retain one durable marker while saving every acknowledgement and preserve uncertainty on timeout", async () => {
  const { design, root, node } = fixture(),
    studio = new FakeStudio(),
    state = emptyState(),
    snapshots = []
  root.children = Array.from({ length: 60 }, (_, i) => node(`rect${i}`, "RECT"))
  const write = studio.write.bind(studio)
  let previousAcknowledged = 0,
    scopedBatches = 0
  studio.write = async (ops) => {
    const saved = snapshots.at(-1).scopes["scene:screen"]
    assert.ok(saved.recoveryRequired)
    assert.equal(Object.keys(saved.nodes).length, previousAcknowledged)
    const result = await write(ops)
    previousAcknowledged = studio.nodes.size
    scopedBatches++
    return result
  }
  await importDesign(
    studio,
    design,
    state,
    { limits: { operations: 10, bytes: 100000 } },
    () => {},
    async (s) => snapshots.push(structuredClone(s)),
  )
  assert.ok(snapshots.length < scopedBatches * 2 + 3)
  assert.equal(snapshots.at(-1).scopes["scene:screen"].recoveryRequired, undefined)
  root.children[0].props.width = 999
  studio.write = async () => {
    throw new Error("Connection timeout after dispatch")
  }
  const result = await importDesign(
    studio,
    design,
    state,
    {},
    () => {},
    async (s) => snapshots.push(structuredClone(s)),
  )
  assert.ok(result.report.errors.length)
  assert.ok(snapshots.at(-1).scopes["scene:screen"].recoveryRequired)
})

test("a failed acknowledged checkpoint retains its marker and prevents an unsafe retry", async () => {
  const { design } = fixture(),
    studio = new FakeStudio(),
    state = emptyState(),
    snapshots = []
  let rejected = false
  const result = await importDesign(
    studio,
    design,
    state,
    {},
    () => {},
    async (s) => {
      if (!rejected && studio.nodes.size) {
        rejected = true
        throw new Error("Figma checkpoint unavailable")
      }
      snapshots.push(structuredClone(s))
    },
  )
  assert.ok(result.report.errors.length)
  assert.ok(snapshots.at(-1).scopes["scene:screen"].recoveryRequired)
  const retry = await importDesign(studio, design, state)
  assert.equal(retry.report.calls, 0)
  assert.ok(retry.report.conflicts.length)
  assert.equal(studio.locked, false)
})

test("cancelling between acknowledged batches clears ordinary uncertainty without sending another write", async () => {
  const { design, root, node } = fixture(),
    studio = new FakeStudio(),
    state = emptyState(),
    controller = new AbortController()
  root.children = Array.from({ length: 60 }, (_, i) => node(`rect${i}`, "RECT"))
  const write = studio.write.bind(studio)
  let writes = 0
  studio.write = async (ops) => {
    const result = await write(ops)
    if (++writes === 3) controller.abort()
    return result
  }
  const snapshots = []
  const result = await importDesign(
    studio,
    design,
    state,
    { signal: controller.signal, limits: { operations: 10, bytes: 100000 } },
    () => {},
    async (s) => snapshots.push(structuredClone(s)),
  )
  assert.equal(writes, 3)
  assert.ok(result.report.errors.some((e) => /cancelled/.test(e)))
  const scope = snapshots.at(-1).scopes["scene:screen"]
  assert.equal(scope.recoveryRequired, undefined)
  assert.equal(Object.keys(scope.nodes).length, studio.nodes.size)
  assert.equal(studio.locked, false)
})

test("missing verification is distinguished from a manual edit and verification-only sends no writes", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  await importDesign(studio, design, state)
  state.scopes["scene:screen"].fingerprint = ""
  button.props.width = 999
  const before = studio.operations.length
  const result = await importDesign(studio, design, state, { verifyOnly: true })
  assert.equal(result.report.calls, 0)
  assert.equal(studio.operations.length, before)
  assert.match(result.report.conflicts[0], /no verified baseline/)
  assert.equal(
    result.report.conflicts.some((message) => message.includes("ProtoPie changed since")),
    false,
  )
  assert.equal(studio.locked, false)
})

test("a previously unverified capture is trusted only when reproduced, never replaced with an unrelated new image", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design, button } = fixture()
  await importDesign(studio, design, state)
  const scope = state.scopes["scene:screen"],
    expected = scope.fingerprint
  scope.fingerprint = ""
  scope.verificationCandidates = [expected]
  let checkpoints = 0
  const recovered = await importDesign(
    studio,
    design,
    state,
    { verifyOnly: true },
    () => {},
    async () => {
      checkpoints++
    },
  )
  assert.deepEqual(recovered.report.conflicts, [])
  assert.equal(recovered.report.calls, 0)
  assert.equal(scope.fingerprint, expected)
  assert.equal(checkpoints, 1)
  scope.fingerprint = ""
  scope.verificationCandidates = [expected]
  studio.nodes.get(scope.nodes.button.id).props.fillColor = "#FF0000"
  button.props.width = 999
  const blocked = await importDesign(studio, design, state, { verifyOnly: true })
  assert.equal(blocked.report.calls, 0)
  assert.ok(blocked.report.verificationPending.length)
  assert.equal(scope.fingerprint, "")
})

test("unstable captures retain bounded recovery evidence and do not silently skip an unchanged unverified import", async () => {
  const studio = new FakeStudio(),
    state = emptyState(),
    { design } = fixture(),
    view = studio.view.bind(studio)
  let serial = 0
  studio.view = async (...args) => ({
    ...(await view(...args)),
    fingerprint: `unstable-${++serial}`,
  })
  const result = await importDesign(studio, design, state)
  assert.ok(result.report.verificationPending.length)
  assert.equal(result.report.verification[0].captures.length, 6)
  assert.equal(result.report.verification[0].status, "pending")
  assert.equal(state.scopes["scene:screen"].verificationCandidates.length, 4)
  const next = await importDesign(studio, design, state)
  assert.equal(next.report.calls, 0)
  assert.ok(next.report.verificationPending.length)
  assert.equal(next.report.skipped.length, 0)
})
