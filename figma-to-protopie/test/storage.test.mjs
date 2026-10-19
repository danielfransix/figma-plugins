import { checkpointTracker, applyPatch } from "./.compiled/checkpoint.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { readState, writeState, writePatch, compactState } from "./.compiled/storage.mjs"
import { digest, emptyState } from "./.compiled/design.mjs"
function store() {
  const data = new Map()
  return {
    data,
    getPluginData: (k) => data.get(k) ?? "",
    setPluginData: (k, v) => {
      assert.ok(Buffer.byteLength(v) < 100000)
      if (v) data.set(k, Buffer.from(v, "utf8").toString("utf8"))
      else data.delete(k)
    },
  }
}

test("every storage interruption leaves a complete committed state and permits retry", () => {
  const previous = emptyState(),
    next = emptyState(),
    other = emptyState()
  previous.scopes.screen = {
    id: "S",
    fingerprint: "pixels2:old:" + "ABCD".repeat(14000),
    nodes: {},
    reactions: {},
  }
  next.scopes.screen = {
    id: "S",
    fingerprint: "pixels2:new:" + "EFGH".repeat(16000),
    nodes: {},
    reactions: {},
  }
  for (let i = 0; i < 180; i++) {
    previous.scopes.screen.nodes["n" + i] = {
      id: "N" + i,
      props: { text: "Previous \u{1f600}".repeat(30) },
    }
    next.scopes.screen.nodes["n" + i] = {
      id: "N" + i,
      props: { text: "Updated \u{1f600}".repeat(30) },
    }
  }
  other.assets.untouched = "R-other"
  for (const mode of ["snapshot", "journal", "reset", "compaction"]) {
    const base = store()
    writeState(base, "pie", previous)
    writeState(base, "other-pie", other)
    if (mode === "compaction") {
      const changed = structuredClone(previous)
      changed.assets.old = "R-old"
      writePatch(base, "pie", checkpointTracker(previous).prepare(changed).patch)
    }
    const before = readState(base, "pie")
    const write = (s) => {
      if (mode === "snapshot" || mode === "compaction") writeState(s, "pie", next)
      else
        writePatch(
          s,
          "pie",
          checkpointTracker(mode === "reset" ? emptyState() : before).prepare(next).patch,
          mode === "reset",
        )
    }
    let steps = 0
    const dry = store(),
      drySet = dry.setPluginData
    for (const [k, v] of base.data) dry.data.set(k, v)
    dry.setPluginData = (k, v) => {
      steps++
      drySet(k, v)
    }
    write(dry)
    assert.ok(steps > 3, mode)
    for (let failure = 1; failure <= steps; failure++) {
      const s = store(),
        set = s.setPluginData
      for (const [k, v] of base.data) s.data.set(k, v)
      let calls = 0
      s.setPluginData = (k, v) => {
        if (++calls === failure) throw Error("Injected storage interruption")
        set(k, v)
      }
      try {
        write(s)
      } catch (error) {
        assert.match(error.message, /Injected storage interruption/)
      }
      const actual = readState(s, "pie")
      assert.ok(
        JSON.stringify(actual) === JSON.stringify(before) ||
          JSON.stringify(actual) === JSON.stringify(next),
        `${mode} interruption ${failure} returned partial data`,
      )
      assert.deepEqual(readState(s, "other-pie"), other)
      s.setPluginData = set
      if (JSON.stringify(actual) !== JSON.stringify(next)) write(s)
      assert.deepEqual(readState(s, "pie"), next)
    }
  }
})
test("large Unicode import state is chunked below Figma's per-entry limit and isolated by target", () => {
  const s = store(),
    state = emptyState()
  state.scopes.test = { id: "S", text: "😀é漢".repeat(30000) }
  writeState(s, "pie-a", state)
  assert.deepEqual(readState(s, "pie-a"), state)
  assert.deepEqual(readState(s, "pie-b"), emptyState())
})
test("interrupted persistence keeps the previous generation readable", () => {
  const s = store(),
    previous = emptyState()
  writeState(s, "pie", previous)
  const next = emptyState()
  next.assets.a = "new"
  const original = s.setPluginData
  s.setPluginData = (key, value) => {
    if (value.includes('"generation"')) throw new Error("storage failure")
    original(key, value)
  }
  assert.throws(() => writeState(s, "pie", next), /storage failure/)
  assert.deepEqual(readState(s, "pie"), previous)
})

test("visual baselines are stored once and reused between acknowledged checkpoints", () => {
  const s = store(),
    state = emptyState(),
    write = s.setPluginData
  let visualWrites = 0
  s.setPluginData = (key, value) => {
    if (key.includes("_visual_")) visualWrites++
    write(key, value)
  }
  state.scopes.one = { id: "S", fingerprint: "pixels2:tree:" + "ABCD".repeat(10000) }
  writeState(s, "pie", state)
  const initial = visualWrites
  state.scopes.one.hash = "changed"
  writeState(s, "pie", state)
  assert.equal(visualWrites, initial)
  assert.deepEqual(readState(s, "pie"), state)
})

test("an interrupted visual blob write preserves the previous committed baseline", () => {
  const s = store(),
    state = emptyState(),
    write = s.setPluginData
  state.scopes.one = { id: "S", fingerprint: "pixels2:tree:" + "ABCD".repeat(10000) }
  writeState(s, "pie", state)
  const previous = structuredClone(state)
  state.scopes.one.fingerprint = "pixels2:tree:" + "EFGH".repeat(10000)
  s.setPluginData = (key, value) => {
    if (key.includes("_visual_") && key.endsWith("_1")) throw Error("blob failure")
    write(key, value)
  }
  assert.throws(() => writeState(s, "pie", state), /blob failure/)
  assert.deepEqual(readState(s, "pie"), previous)
  s.setPluginData = write
  writeState(s, "pie", state)
  assert.deepEqual(readState(s, "pie"), state)
})

test("large checkpoints reuse unchanged chunks and commit only changed content", () => {
  const s = store(),
    state = emptyState()
  state.scopes.one = { id: "S", kind: "scene", hash: "", fingerprint: "", nodes: {}, reactions: {} }
  for (let i = 0; i < 1400; i++)
    state.scopes.one.nodes["node" + i] = {
      id: "N" + i,
      type: "CONTAINER",
      props: { text: "sample ".repeat(30) },
    }
  const write = s.setPluginData
  let chunkWrites = 0
  s.setPluginData = (key, value) => {
    if (key.includes("_data_") && value) chunkWrites++
    write(key, value)
  }
  writeState(s, "pie", state)
  const initial = chunkWrites
  assert.ok(initial > 20)
  state.scopes.one.recoveryRequired = "Pending native batch"
  writeState(s, "pie", state)
  assert.ok(chunkWrites - initial <= 2, "a journal marker must not rewrite the whole large index")
  assert.deepEqual(readState(s, "pie"), state)
})

test("legacy generation chunks migrate atomically without losing links", () => {
  const s = store(),
    state = emptyState(),
    key = "f2p_v2_" + digest("pie")
  state.assets.old = "R1"
  s.setPluginData(key + "_legacy_0", JSON.stringify(state))
  s.setPluginData(key, JSON.stringify({ target: "pie", generation: "legacy", chunks: 1 }))
  assert.deepEqual(readState(s, "pie"), state)
  state.assets.new = "R2"
  writeState(s, "pie", state)
  assert.deepEqual(readState(s, "pie"), state)
  assert.equal(s.getPluginData(key + "_legacy_0"), "")
})

test("incremental checkpoints keep acknowledged nodes, removals, metadata and variables across compaction", () => {
  const s = store(),
    state = emptyState(),
    tracker = checkpointTracker(state)
  state.scopes.one = {
    id: "S",
    kind: "scene",
    hash: "",
    fingerprint: "pixels2:tree:" + "ABCD".repeat(10000),
    nodes: {},
    reactions: {},
  }
  for (let i = 0; i < 300; i++)
    state.scopes.one.nodes["n" + i] = {
      id: "N" + i,
      type: "TEXT",
      props: { text: "unicode \u{1f600}".repeat(40) },
    }
  let next = tracker.prepare(state)
  writePatch(s, "pie", next.patch)
  next.acknowledge()
  const full = JSON.stringify(state).length
  state.scopes.one.recoveryRequired = "Pending write"
  next = tracker.prepare(state)
  assert.ok(JSON.stringify(next.patch).length < full / 50)
  writePatch(s, "pie", next.patch)
  next.acknowledge()
  delete state.scopes.one.nodes.n3
  state.scopes.one.nodes.n4.props.text = "changed"
  state.assets.a = "R1"
  state.variables.v = { id: "V", name: "Existing", value: 8, external: true }
  delete state.scopes.one.recoveryRequired
  next = tracker.prepare(state)
  writePatch(s, "pie", next.patch)
  next.acknowledge()
  assert.deepEqual(readState(s, "pie"), state)
  writeState(s, "pie", state)
  assert.deepEqual(readState(s, "pie"), state)
  assert.equal(tracker.prepare(state).changed, false)
  assert.equal(JSON.parse(s.getPluginData("f2p_v2_" + digest("pie"))).journal, undefined)
})

test("an interrupted journal commit preserves the last acknowledged checkpoint and can be retried", () => {
  const s = store(),
    state = emptyState(),
    tracker = checkpointTracker(state)
  state.assets.first = "R1"
  let change = tracker.prepare(state)
  writePatch(s, "pie", change.patch)
  change.acknowledge()
  const previous = structuredClone(state)
  state.assets.second = "R2"
  change = tracker.prepare(state)
  const write = s.setPluginData
  s.setPluginData = (key, value) => {
    if (key === "f2p_v2_" + digest("pie")) throw Error("manifest failure")
    write(key, value)
  }
  assert.throws(() => writePatch(s, "pie", change.patch), /manifest failure/)
  assert.deepEqual(readState(s, "pie"), previous)
  assert.equal(
    tracker.prepare(state).changed,
    true,
    "unacknowledged changes must not advance the tracker",
  )
  s.setPluginData = write
  writePatch(s, "pie", change.patch)
  change.acknowledge()
  assert.deepEqual(readState(s, "pie"), state)
})

test("fresh journal reset is atomic and drops old links only after commit", () => {
  const s = store(),
    previous = emptyState()
  previous.assets.old = "old"
  writeState(s, "pie", previous)
  const state = emptyState()
  state.assets.new = "new"
  const patch = checkpointTracker(emptyState()).prepare(state).patch
  const write = s.setPluginData
  s.setPluginData = (key, value) => {
    if (key === "f2p_v2_" + digest("pie")) throw Error("failed fresh reset")
    write(key, value)
  }
  assert.throws(() => writePatch(s, "pie", patch, true), /failed fresh reset/)
  assert.deepEqual(readState(s, "pie"), previous)
  s.setPluginData = write
  writePatch(s, "pie", patch, true)
  assert.deepEqual(readState(s, "pie"), state)
})

test("a journal based on legacy index data remains readable and rejects missing chunks", () => {
  const s = store(),
    state = emptyState()
  state.assets.legacy = "L"
  writeState(s, "pie", state)
  const tracker = checkpointTracker(state)
  state.assets.next = "N"
  const change = tracker.prepare(state)
  writePatch(s, "pie", change.patch)
  assert.deepEqual(readState(s, "pie"), state)
  const manifest = JSON.parse(s.getPluginData("f2p_v2_" + digest("pie")))
  s.setPluginData(manifest.journal[0][0], "")
  assert.throws(() => readState(s, "pie"), /journal chunk is missing/)
})

test("failed compaction preserves the readable journal and older clients cannot ignore it", () => {
  const s = store(),
    state = emptyState()
  state.assets.a = "R1"
  writePatch(s, "pie", checkpointTracker(emptyState()).prepare(state).patch)
  const key = "f2p_v2_" + digest("pie"),
    manifest = JSON.parse(s.getPluginData(key))
  assert.equal(manifest.chunks, 0)
  assert.equal(manifest.baseChunks, 1)
  const write = s.setPluginData
  s.setPluginData = (k, v) => {
    if (k === key) throw Error("compaction failed")
    write(k, v)
  }
  assert.throws(() => writeState(s, "pie", state), /compaction failed/)
  assert.deepEqual(readState(s, "pie"), state)
})

test("explicit fresh checkpoints can replace a corrupt index without erasing it before commit", () => {
  const s = store(),
    key = "f2p_v2_" + digest("pie"),
    state = emptyState()
  state.assets.new = "R1"
  s.setPluginData(key, "invalid JSON")
  const patch = checkpointTracker(emptyState()).prepare(state).patch
  assert.throws(() => writePatch(s, "pie", patch))
  assert.equal(s.getPluginData(key), "invalid JSON")
  writePatch(s, "pie", patch, true)
  assert.deepEqual(readState(s, "pie"), state)
})

test("small journals avoid full compaction and bounded journals compact without losing records", () => {
  const s = store(),
    state = emptyState(),
    tracker = checkpointTracker(state)
  for (let i = 0; i < 128; i++) {
    state.assets.resource = "R" + i
    const change = tracker.prepare(state)
    writePatch(s, "pie", change.patch)
    change.acknowledge()
    if (i === 0) assert.equal(compactState(s, "pie", state), false)
  }
  assert.equal(compactState(s, "pie", state), true)
  assert.deepEqual(readState(s, "pie"), state)
  assert.equal(JSON.parse(s.getPluginData("f2p_v2_" + digest("pie"))).journal, undefined)
})
