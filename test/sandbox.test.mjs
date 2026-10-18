import { readState } from "./.compiled/storage.mjs"
import { emptyState } from "./.compiled/design.mjs"
import { checkpointTracker } from "./.compiled/checkpoint.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"

test("sandbox loads every page only for an explicit whole-file import", async () => {
  const loads = [],
    messages = [],
    data = new Map()
  const pages = ["A", "B"].map((id) => ({
    id,
    type: "PAGE",
    name: id,
    selection: [],
    children: [],
    loadAsync: async () => loads.push(id),
  }))
  for (const page of pages)
    page.children = [
      {
        id: "frame" + page.id,
        name: "Frame " + page.id,
        type: "FRAME",
        parent: page,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        children: [],
        fills: [],
        strokes: [],
        effects: [],
        opacity: 1,
        getPluginData: () => "",
      },
    ]
  const figma = {
    root: {
      children: pages,
      getPluginData: (k) => data.get(k) ?? "",
      setPluginData: (k, v) => data.set(k, v),
    },
    currentPage: pages[0],
    mixed: Symbol(),
    ui: { postMessage: (m) => messages.push(m) },
    on: () => {},
    showUI: () => {},
    variables: { getLocalVariablesAsync: async () => [] },
  }
  runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), {
    figma,
    __html__: "",
    setTimeout,
    clearTimeout,
  })
  await figma.ui.onmessage({ type: "run", target: "test", wholeFile: true })
  assert.deepEqual(loads, ["A", "B"])
  assert.equal(figma.currentPage, pages[0])
  const design = messages.find((m) => m.type === "design").design
  assert.equal(design.units.length, 2)
  assert.deepEqual(
    Array.from(design.units, (u) => u.id),
    ["frameA", "frameB"],
  )
})

test("sandbox forwards the clipping setting to the reader and defaults it on", async () => {
  const messages = [],
    text = {
      id: "email",
      name: "Email",
      type: "TEXT",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      rotation: 0,
      opacity: 1,
      visible: true,
      fills: [],
      strokes: [],
      effects: [],
      characters: "employee@example.com",
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 14,
      letterSpacing: { unit: "PIXELS", value: 0 },
      lineHeight: { unit: "AUTO" },
      textAutoResize: "HEIGHT",
      textTruncation: "ENDING",
      maxLines: 1,
      textAlignHorizontal: "LEFT",
      textAlignVertical: "TOP",
      getPluginData: () => "",
    },
    page = { id: "page", type: "PAGE", selection: [text], children: [text] }
  text.parent = page
  const figma = {
    root: { getPluginData: () => "", setPluginData() {} },
    currentPage: page,
    mixed: Symbol(),
    ui: { postMessage: (m) => messages.push(m) },
    on() {},
    showUI() {},
    variables: { getLocalVariablesAsync: async () => [] },
  }
  runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), {
    figma,
    __html__: "",
    setTimeout,
    clearTimeout,
  })
  for (const clipTruncatedText of [undefined, false, true]) {
    messages.length = 0
    await figma.ui.onmessage({ type: "run", target: "test", fresh: true, clipTruncatedText })
    const response = messages.find((m) => m.type === "design")
    assert.ok(response, JSON.stringify(messages))
    assert.equal(
      response.design.units[0].root.type,
      clipTruncatedText === false ? "TEXT" : "CONTAINER",
    )
  }
})

test("a queued disconnect is persisted after an earlier grant save and acknowledged last", async () => {
  const messages = [],
    writes = []
  let release, started, stored
  const firstStarted = new Promise((resolve) => (started = resolve))
  const barrier = new Promise((resolve) => (release = resolve))
  const figma = {
    currentPage: { selection: [] },
    ui: { postMessage: (message) => messages.push(message) },
    clientStorage: {
      async setAsync(key, value) {
        writes.push(value)
        if (writes.length === 1) {
          started()
          await barrier
        }
        stored = value
      },
      async getAsync() {
        return stored
      },
    },
    on() {},
    showUI() {},
  }
  runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), {
    figma,
    __html__: "",
    setTimeout,
    clearTimeout,
  })
  const endpoint = "http://127.0.0.1:9982/mcp"
  const first = figma.ui.onmessage({
    type: "save-connection-settings",
    requestId: 1,
    settings: { endpoint, connection: { endpoint, connectionId: "late-grant", contextId: "pie" } },
  })
  await firstStarted
  const second = figma.ui.onmessage({
    type: "save-connection-settings",
    requestId: 2,
    settings: { endpoint, connection: null, disconnected: true },
  })
  assert.equal(writes.length, 1, "disconnect must not be overtaken by a slow earlier save")
  release()
  await Promise.all([first, second])
  assert.equal(stored.connection, null)
  assert.equal(stored.disconnected, true)
  assert.deepEqual(
    messages.filter((m) => m.type === "connection-settings-saved").map((m) => m.requestId),
    [1, 2],
  )
  await figma.ui.onmessage({ type: "load-connection-settings" })
  assert.equal(messages.find((m) => m.type === "connection-settings").settings.disconnected, true)
})

test("sandbox relays the failing export node in its error diagnostic", async () => {
  const messages = [],
    data = new Map()
  const page = { id: "page", type: "PAGE", name: "Page", selection: [] }
  page.selection.push({
    id: "broken:1",
    name: "Broken icon",
    type: "VECTOR",
    parent: page,
    x: 0,
    y: 0,
    width: 24,
    height: 24,
    visible: true,
    opacity: 1,
    absoluteRenderBounds: { x: 0, y: 0, width: 24, height: 24 },
    getPluginData: () => "",
    exportAsync: async () => {
      throw new Error("Failed to export node. This node may not have any visible layers.")
    },
  })
  const figma = {
    currentPage: page,
    mixed: Symbol(),
    root: { getPluginData: (key) => data.get(key) ?? "" },
    ui: { postMessage: (message) => messages.push(message) },
    on() {},
    showUI() {},
  }
  runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), {
    figma,
    __html__: "",
    setTimeout,
    clearTimeout,
  })
  await figma.ui.onmessage({ type: "run", target: "test" })
  const error = messages.find((message) => message.type === "error")
  assert.match(error.message, /Broken icon.*broken:1.*Failed to export node/)
  assert.equal(error.diagnostic.stage, "figma-export")
  assert.equal(error.diagnostic.node.id, "broken:1")
  assert.deepEqual(Array.from(error.diagnostic.node.path), ["Broken icon"])
  assert.equal(
    messages.some((message) => message.type === "design"),
    false,
  )
})

test("fresh imports bypass stale target, previous-target, and legacy links", async () => {
  const messages = []
  const page = { id: "page", type: "PAGE", name: "Page", selection: [] }
  page.selection.push({
    id: "frame",
    name: "Frame",
    type: "FRAME",
    parent: page,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    children: [],
    fills: [],
    strokes: [],
    effects: [],
    opacity: 1,
    getPluginData: () => "legacy-link",
  })
  let indexReads = 0
  const figma = {
    currentPage: page,
    mixed: Symbol(),
    root: {
      getPluginData() {
        indexReads++
        throw Error("Stale import index must not be read")
      },
    },
    ui: { postMessage: (message) => messages.push(message) },
    on() {},
    showUI() {},
    variables: { getLocalVariablesAsync: async () => [] },
  }
  runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), {
    figma,
    __html__: "",
    setTimeout,
    clearTimeout,
  })
  await figma.ui.onmessage({
    type: "run",
    target: "deleted-target",
    previousTarget: "older-target",
    fresh: true,
  })
  assert.equal(indexReads, 0)
  const result = messages.find((message) => message.type === "design")
  assert.ok(result, JSON.stringify(messages))
  assert.equal(result.design.units.length, 1)
  assert.deepEqual(Object.keys(result.state.scopes), [])
  assert.deepEqual(Object.keys(result.state.assets), [])
  assert.deepEqual(Object.keys(result.state.variables), [])
})

test("the sandbox forwards disabled component creation to the real reader", async () => {
  const messages = [],
    page = { id: "page", type: "PAGE", name: "Page", selection: [] }
  const instance = {
    id: "instance",
    name: "Instance",
    type: "INSTANCE",
    parent: page,
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    children: [],
    fills: [],
    strokes: [],
    effects: [],
    opacity: 1,
    getPluginData: () => "",
    getMainComponentAsync: async () => {
      throw Error("Must not request a master")
    },
  }
  page.selection.push(instance)
  const figma = {
    currentPage: page,
    mixed: Symbol(),
    root: { getPluginData: () => "" },
    ui: { postMessage: (message) => messages.push(message) },
    on() {},
    showUI() {},
    variables: { getLocalVariablesAsync: async () => [] },
  }
  runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), {
    figma,
    __html__: "",
    setTimeout,
    clearTimeout,
  })
  await figma.ui.onmessage({ type: "run", target: "test", createComponents: false })
  const result = messages.find((message) => message.type === "design")
  assert.ok(result, JSON.stringify(messages))
  assert.equal(result.design.components.length, 0)
  assert.equal(result.design.units[0].root.type, "CONTAINER")
})

test("sandbox checkpoints are ordered, durable, session-bound and verification skips all Figma exports", async () => {
  const data = new Map(),
    messages = []
  const figma = {
    currentPage: { selection: [] },
    root: { getPluginData: (k) => data.get(k) ?? "", setPluginData: (k, v) => data.set(k, v) },
    ui: { postMessage: (m) => messages.push(structuredClone(m)) },
    on() {},
    showUI() {},
  }
  runInNewContext(await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8"), {
    figma,
    __html__: "",
    setTimeout,
    clearTimeout,
  })
  await figma.ui.onmessage({ type: "run", target: "pie", verifyOnly: true })
  const design = messages.find((m) => m.type === "design")
  assert.equal(design.readMilliseconds, 0)
  assert.equal(design.design.units.length, 0)
  const state = emptyState(),
    tracker = checkpointTracker(state)
  state.assets.first = "R1"
  const change = tracker.prepare(state)
  await figma.ui.onmessage({
    type: "persist",
    target: "pie",
    session: design.checkpointSession,
    sequence: 1,
    patch: change.patch,
    requestId: 1,
  })
  assert.ok(messages.find((m) => m.type === "persisted" && m.requestId === 1))
  assert.deepEqual(readState(figma.root, "pie"), state)
  await figma.ui.onmessage({
    type: "persist",
    target: "pie",
    session: design.checkpointSession,
    sequence: 1,
    patch: change.patch,
    requestId: 2,
  })
  assert.match(messages.find((m) => m.requestId === 2).message, /out-of-order/)
  await figma.ui.onmessage({
    type: "compact-checkpoints",
    target: "pie",
    session: design.checkpointSession,
    sequence: 1,
    requestId: 3,
  })
  assert.ok(messages.find((m) => m.type === "persisted" && m.requestId === 3))
  assert.deepEqual(readState(figma.root, "pie"), state)
  await figma.ui.onmessage({ type: "run", target: "pie", verifyOnly: true })
  await figma.ui.onmessage({
    type: "persist",
    target: "pie",
    session: design.checkpointSession,
    sequence: 2,
    patch: change.patch,
    requestId: 4,
  })
  assert.match(messages.find((m) => m.requestId === 4).message, /Stale/)
})
