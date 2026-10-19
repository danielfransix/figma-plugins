import { test } from "node:test"
import assert from "node:assert/strict"
import { executeBatches, replaceReferences } from "./.compiled/batch.mjs"
test("dependencies resolve across both operation and byte-bounded chunks", async () => {
  const operations = [
    { tool: "scene_manage", name: "scene", input: {} },
    { tool: "layer_manage", name: "parent", input: { sceneId: "${scene.sceneIds[0]}" } },
    { tool: "layer_manage", input: { parentId: "${parent.layerId}", text: "✓" } },
  ]
  let call = 0
  const result = await executeBatches(
    operations,
    async (ops) => {
      assert.equal(ops.length, 1)
      if (call === 1) assert.equal(ops[0].input.sceneId, "S")
      if (call === 2) assert.equal(ops[0].input.parentId, "P")
      return { results: [call++ === 0 ? { sceneIds: ["S"] } : { layerId: "P" }] }
    },
    undefined,
    { operations: 1, bytes: 1000 },
  )
  assert.equal(result.calls, 3)
  assert.ok(result.results.every((r) => r.ok))
})
test("a failed dependency never gets sent in a subsequent batch", async () => {
  let calls = 0
  const result = await executeBatches(
    [
      { tool: "x", name: "bad", input: {} },
      { tool: "y", input: { id: "${bad.layerId}" } },
    ],
    async () => {
      calls++
      return { results: [null], errors: [{ operationIndex: 0, error: "failed" }] }
    },
    undefined,
    { operations: 1, bytes: 1000 },
  )
  assert.equal(calls, 1)
  assert.equal(result.results[1].ok, false)
})
test("byte limits count UTF-8 and do not retry oversized mutations", async () => {
  let sent = false
  const result = await executeBatches(
    [{ tool: "x", input: { text: "😀".repeat(100) } }],
    async () => {
      sent = true
    },
    undefined,
    { operations: 10, bytes: 200 },
  )
  assert.equal(sent, false)
  assert.equal(result.results[0].ok, false)
})
test("a network error is surfaced without retrying an ambiguous write", async () => {
  let calls = 0
  await assert.rejects(
    executeBatches([{ tool: "x", input: {} }], async () => {
      calls++
      throw new Error("connection lost")
    }),
    /connection lost/,
  )
  assert.equal(calls, 1)
})
test("references preserve arbitrary text and array-valued result paths", () => {
  assert.deepEqual(
    replaceReferences(
      { a: "literal ${user.text}", b: "${op.ids[1]}" },
      new Map([["op", { ids: ["a", "b"] }]]),
    ),
    { a: "literal ${user.text}", b: "b" },
  )
})
test("independent leaf creates compact into array operations without losing per-layer failure identities", async () => {
  const ops = Array.from({ length: 5 }, (_, i) => ({
    tool: "layer_manage",
    name: `leaf${i}`,
    input: {
      sceneId: "S",
      action: "batch_add",
      layers: [{ layerType: "RECT", sceneId: "S", properties: { name: `node${i}` } }],
    },
  }))
  let entries = 0
  const result = await executeBatches(
    ops,
    async (batch) => {
      assert.ok(batch.reduce((n, op) => n + op.input.layers.length, 0) <= 2)
      const results = batch.map((op) => {
        entries++
        const createdLayers = op.input.layers
          .filter((n) => n.properties.name !== "node1")
          .map((n) => ({ id: n.properties.name }))
        const errors = op.input.layers.flatMap((n, i) =>
          n.properties.name === "node1" ? [{ index: i, error: "bad node" }] : [],
        )
        return {
          createdLayers,
          errors,
          failedCount: errors.length,
          layerId: createdLayers[0]?.id,
          layerIds: createdLayers.map((n) => n.id),
        }
      })
      return { results }
    },
    undefined,
    { operations: 2, bytes: 10000 },
  )
  assert.equal(entries, 3)
  assert.equal(result.results.length, 5)
  assert.equal(result.results[0].value.layerId, "node0")
  assert.equal(result.results[1].ok, false)
  assert.equal(result.results[2].value.layerId, "node2")
  assert.equal(result.results[4].value.layerId, "node4")
})

test("bulk named parents keep independent acknowledgements and block only failed descendants", async () => {
  const create = (name, parentId) => ({
    tool: "layer_manage",
    name,
    input: {
      sceneId: "S",
      action: "batch_add",
      layers: [
        {
          layerType: "CONTAINER",
          ...(parentId ? { parentId } : { sceneId: "S" }),
          properties: { name },
        },
      ],
    },
  })
  const sent = []
  const result = await executeBatches(
    [
      create("good"),
      create("bad"),
      create("childGood", "${good.layerId}"),
      create("childBad", "${bad.layerId}"),
    ],
    async (batch) => {
      sent.push(batch)
      return {
        results: batch.map((op) => {
          const createdLayers = [],
            errors = []
          for (const [index, layer] of op.input.layers.entries()) {
            if (layer.properties.name === "bad") errors.push({ index, error: "Rejected parent" })
            else createdLayers.push({ id: "id_" + layer.properties.name })
          }
          return {
            createdLayers,
            errors,
            failedCount: errors.length,
            layerId: createdLayers[0]?.id,
          }
        }),
      }
    },
  )
  assert.equal(sent[0].length, 1)
  assert.equal(sent[0][0].input.layers.length, 2)
  assert.equal(sent[1][0].input.layers[0].parentId, "id_good")
  assert.equal(
    sent
      .flatMap((batch) => batch.flatMap((op) => op.input.layers))
      .some((layer) => layer.properties.name === "childBad"),
    false,
  )
  assert.deepEqual(
    result.results.map((r) => r.ok),
    [true, false, true, false],
  )
})

test("independent layers for different acknowledged parents share a native array within UTF-8 bounds", async () => {
  const ops = Array.from({ length: 12 }, (_, i) => ({
    tool: "layer_manage",
    name: "item" + i,
    input: {
      action: "batch_add",
      sceneId: "S",
      layers: [
        {
          parentId: "P" + (i % 2),
          layerType: "TEXT",
          properties: { name: "label" + i, text: "\u{1f600}".repeat(25) },
        },
      ],
    },
  }))
  let merged = false
  const result = await executeBatches(
    ops,
    async (batch) => {
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 1400)
      assert.ok(batch.reduce((n, op) => n + op.input.layers.length, 0) <= 5)
      merged ||= batch.some(
        (op) => new Set(op.input.layers.map((layer) => layer.parentId)).size > 1,
      )
      return {
        results: batch.map((op) => ({
          createdLayers: op.input.layers.map((layer) => ({ id: layer.properties.name })),
          errors: [],
        })),
      }
    },
    undefined,
    { operations: 5, bytes: 1400 },
  )
  assert.equal(merged, true)
  assert.ok(result.results.every((r) => r.ok))
})

test("ambiguous bulk acknowledgements stop without retry or completed checkpoint", async () => {
  let calls = 0,
    checkpoints = 0
  const ops = ["one", "two"].map((name) => ({
    tool: "layer_manage",
    name,
    input: {
      sceneId: "S",
      action: "batch_add",
      layers: [{ layerType: "RECT", sceneId: "S", properties: { name } }],
    },
  }))
  await assert.rejects(
    executeBatches(
      ops,
      async () => {
        calls++
        return { results: [{ createdLayers: [{ id: "only-one" }], errors: [] }] }
      },
      undefined,
      undefined,
      async () => {
        checkpoints++
      },
    ),
    /Ambiguous grouped/,
  )
  assert.equal(calls, 1)
  assert.equal(checkpoints, 0)
})

test("invalid limits and an oversized native array never send a mutation", async () => {
  await assert.rejects(
    executeBatches([], async () => assert.fail(), undefined, { operations: 0, bytes: 100 }),
    /Batch limits/,
  )
  const result = await executeBatches(
    [{ tool: "layer_manage", input: { action: "batch_add", layers: [{}, {}] } }],
    async () => assert.fail(),
    undefined,
    { operations: 1, bytes: 1000 },
  )
  assert.equal(result.results[0].ok, false)
})

test("malformed bulk responses never assign guessed layer IDs", async () => {
  const ops = ["one", "two"].map((name) => ({
    tool: "layer_manage",
    name,
    input: {
      sceneId: "S",
      action: "batch_add",
      layers: [{ layerType: "RECT", properties: { name } }],
    },
  }))
  for (const value of [
    { createdLayers: [{ id: "A" }], errors: [{ index: 8, error: "bad" }] },
    { createdLayers: [{ id: "A" }, { id: "A" }], errors: [] },
    { createdLayers: [{}, { id: "B" }], errors: [] },
    { createdLayers: [{ id: "A" }, { id: "B" }], errors: [], failedCount: 1 },
    { createdLayers: {}, errors: [] },
  ]) {
    let committed = 0
    await assert.rejects(
      executeBatches(
        ops,
        async () => ({ results: [value] }),
        () => committed++,
      ),
      /Ambiguous grouped/,
    )
    assert.equal(committed, 0)
  }
})
