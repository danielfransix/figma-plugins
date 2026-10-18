import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { importDesign } from "./.compiled/importer.mjs"
import { FakeStudio } from "./fixtures/studio.mjs"
import { readDesign } from "./.compiled/read-design.mjs"
const mixed = Symbol("mixed")
function node(id, type, extra = {}) {
  const n = {
    id,
    type,
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    rotation: 0,
    opacity: 1,
    visible: true,
    fills: [],
    strokes: [],
    effects: [],
    strokeWeight: 0,
    arcData: { innerRadius: 0, startAngle: 0, endingAngle: Math.PI * 2 },
    parent: { id: "page", type: "PAGE" },
    ...extra,
  }
  if (n.children) for (const c of n.children) c.parent = n
  return n
}
const api = { mixed, variables: { getLocalVariablesAsync: async () => [] } }
function truncatedText(id = "email", extra = {}) {
  return node(id, "TEXT", {
    characters: "ava.morgan@example.com",
    width: 120,
    height: 20,
    x: 8,
    y: 6,
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 14,
    letterSpacing: { unit: "PIXELS", value: 0 },
    lineHeight: { unit: "PIXELS", value: 20 },
    textAutoResize: "HEIGHT",
    textTruncation: "ENDING",
    maxLines: 1,
    textAlignHorizontal: "LEFT",
    textAlignVertical: "CENTER",
    layoutSizingHorizontal: "FILL",
    layoutSizingVertical: "HUG",
    layoutGrow: 1,
    layoutPositioning: "AUTO",
    ...extra,
  })
}
test("truncated text uses a Fill clipping viewport and editable unwrapped content; off keeps native text", async () => {
  for (const liveAutoLayout of [true, false]) {
    const source = truncatedText("email", { opacity: 0.5, rotation: 15 }),
      screen = node("screen", "FRAME", { children: [source] })
    const design = await readDesign(api, [screen], undefined, { liveAutoLayout }),
      wrapper = design.units[0].root.children[0],
      text = wrapper.children[0]
    assert.equal(
      wrapper.id,
      source.id,
      "source identity and interaction target stay on the viewport",
    )
    assert.equal(wrapper.type, "CONTAINER")
    assert.equal(wrapper.props.clipChildren, true)
    assert.equal(wrapper.props.layoutSizingHorizontal, liveAutoLayout ? "FILL" : "FIXED")
    assert.equal(wrapper.props.layoutSizingVertical, "FIXED")
    assert.equal(wrapper.props.rotation, -15)
    assert.equal(wrapper.props.opacity, 50)
    assert.equal(wrapper.props.width, 120)
    assert.equal(wrapper.props.height, 20)
    assert.equal(wrapper.props.counterAxisAlignItems, "CENTER")
    assert.equal(text.props.text, source.characters)
    assert.equal(text.type, "TEXT")
    assert.equal(text.props.sizeMode, "AUTO_WIDTH")
    assert.equal(text.props.layoutSizingHorizontal, "HUG")
    assert.equal(text.props.layoutGrow, 0)
    assert.equal(text.props.rotation, 0)
    assert.equal(text.props.opacity, 100, "opacity is not multiplied twice")
    assert.equal(text.props.x, 0)
    assert.equal(text.props.y, 0)
    assert.equal(design.assets.length, 0)
    assert.match(design.notes.join("\n"), /1 single-line truncated text/)
    const disabled = await readDesign(api, [screen], undefined, {
      liveAutoLayout,
      clipTruncatedText: false,
    })
    assert.equal(disabled.units[0].root.children[0].type, "TEXT")
    assert.equal(disabled.units[0].root.children[0].props.text, source.characters)
    assert.equal(disabled.units[0].root.children[0].children.length, 0)
  }
})
test("clipping recognizes fixed-height and legacy truncation, preserving ordinary and multi-line text", async () => {
  for (const [extra, clipped] of [
    [{ textTruncation: "DISABLED" }, false],
    [{ maxLines: 2 }, false],
    [{ characters: "First\nSecond" }, false],
    [{ maxLines: null, textAutoResize: "NONE" }, true],
    [{ maxLines: null, textAutoResize: "NONE", height: 40 }, false],
    [{ maxLines: null, textAutoResize: "HEIGHT" }, false],
    [{ maxLines: null, textAutoResize: "NONE", lineHeight: { unit: "AUTO" } }, true],
    [{ maxLines: null, textAutoResize: "NONE", lineHeight: { unit: "PERCENT", value: 150 } }, true],
    [{ maxLines: null, textAutoResize: "TRUNCATE", textTruncation: undefined }, true],
  ]) {
    const design = await readDesign(api, [truncatedText("email", extra)])
    assert.equal(design.units[0].root.type, clipped ? "CONTAINER" : "TEXT", JSON.stringify(extra))
  }
  for (const [textAlignHorizontal, expected] of [
    ["LEFT", "MIN"],
    ["CENTER", "CENTER"],
    ["RIGHT", "MAX"],
  ]) {
    const root = (await readDesign(api, [truncatedText("email", { textAlignHorizontal })])).units[0]
      .root
    assert.equal(root.props.primaryAxisAlignItems, expected)
  }
})
test("clipping can be toggled on, off and on during updates without extra scenes or stale wrappers", async () => {
  const { emptyState } = await import("./.compiled/design.mjs")
  const screen = node("screen", "FRAME", { children: [truncatedText()] }),
    state = emptyState(),
    studio = new FakeStudio()
  let sceneId
  for (const clipTruncatedText of [false, true, false, true]) {
    const design = await readDesign(api, [screen], undefined, {
      clipTruncatedText,
      liveAutoLayout: true,
    })
    const { report } = await importDesign(studio, design, state)
    assert.deepEqual(report.errors, [])
    assert.deepEqual(report.conflicts, [])
    const scope = state.scopes["scene:screen"]
    sceneId ??= scope.id
    assert.equal(scope.id, sceneId)
    assert.equal(studio.scenes.size, 1)
    assert.equal(Object.keys(scope.nodes).length, clipTruncatedText ? 3 : 2)
    assert.equal(studio.nodes.size, clipTruncatedText ? 3 : 2)
    assert.equal(scope.nodes.email.type, clipTruncatedText ? "CONTAINER" : "TEXT")
    assert.equal(Boolean(scope.nodes["email:text-content"]), clipTruncatedText)
    const writes = studio.operations.length
    await importDesign(studio, design, state)
    assert.equal(studio.operations.length, writes, "unchanged re-import sends no native mutations")
  }
})
test("shared-component text overrides target the wrapped editable text, and setting differences resolve instances", async () => {
  const main = node("master", "COMPONENT", { children: [truncatedText("source")] }),
    instance = node("instance", "INSTANCE", {
      children: [truncatedText("Iinstance;source", { characters: "Different email" })],
      overrides: [],
      getMainComponentAsync: async () => main,
    })
  const screen = node("screen", "FRAME", { children: [instance] })
  const { emptyState } = await import("./.compiled/design.mjs")
  for (const clipTruncatedText of [true, false]) {
    const design = await readDesign(api, [screen], undefined, { clipTruncatedText }),
      state = emptyState(),
      studio = new FakeStudio()
    const override = design.units[0].root.children[0].overrides[0]
    assert.equal(override.sourceId, clipTruncatedText ? "source:text-content" : "source")
    const { report } = await importDesign(studio, design, state)
    assert.deepEqual(report.errors, [])
    const textId = state.scopes["component:master"].nodes[override.sourceId].id
    const native = studio.operations.find((op) => op.input.action === "instance_override")
    assert.ok(native.input.layers[0].id.endsWith(`_${textId}`))
    assert.equal(native.input.layers[0].properties.text, "Different email")
  }
  const state = emptyState(),
    studio = new FakeStudio()
  for (const clipTruncatedText of [true, false, true]) {
    const design = await readDesign(api, [screen], undefined, { clipTruncatedText })
    const { report } = await importDesign(studio, design, state, { allowSharedComponents: true })
    assert.deepEqual(report.errors, [])
    assert.deepEqual(report.conflicts, [])
    assert.equal(studio.components.size, 1)
    assert.equal(
      state.scopes["component:master"].nodes.source.type,
      clipTruncatedText ? "CONTAINER" : "TEXT",
    )
  }
  instance.children[0].textTruncation = "DISABLED"
  const resolved = await readDesign(api, [screen])
  assert.equal(resolved.components.length, 0)
  assert.equal(resolved.units[0].root.children[0].children[0].type, "TEXT")
})
test("actual reader maps rectangles and ellipses, preserving paint alpha independently from layer opacity", async () => {
  const rect = node("rect", "RECTANGLE", {
    opacity: 0.5,
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 0.4 }],
  })
  const frame = node("screen", "FRAME", { children: [rect, node("oval", "ELLIPSE")] })
  const design = await readDesign(api, [frame])
  assert.equal(design.units[0].root.children[0].type, "RECT")
  assert.equal(design.units[0].root.children[1].type, "OVAL")
  assert.equal(design.units[0].root.children[0].props.fillOpacity, 40)
  assert.equal(design.units[0].root.children[0].props.opacity, 50)
})
test("section selection expands frames and overlapping selections import once", async () => {
  const frame = node("screen", "FRAME", { children: [node("rect", "RECTANGLE")] })
  const section = node("section", "SECTION", { children: [frame] })
  assert.equal((await readDesign(api, [section, frame])).units.length, 1)
})
test("mixed text uses an explicit SVG fallback instead of losing its styling", async () => {
  const text = node("text", "TEXT", {
    fontName: mixed,
    characters: "Mixed text",
    exportAsync: async () => '<svg viewBox="0 0 100 30"></svg>',
  })
  const design = await readDesign(api, [text])
  assert.equal(design.units[0].root.type, "IMAGE")
  assert.match(design.notes[0], /mixed text/)
})
test("Smart Animate links and delays map to native transitions in seconds", async () => {
  const rect = node("button", "RECTANGLE", {
    reactions: [
      {
        trigger: { type: "AFTER_TIMEOUT", timeout: 0.5 },
        actions: [
          {
            type: "NODE",
            navigation: "NAVIGATE",
            destinationId: "dest",
            transition: { type: "SMART_ANIMATE", duration: 0.3, easing: { type: "EASE_OUT" } },
          },
        ],
      },
    ],
  })
  const r = (await readDesign(api, [rect])).units[0].root.reactions[0]
  assert.equal(r.trigger, "start")
  assert.equal(r.props.transition, "SMART")
  assert.equal(r.props.delay, 0.5)
  assert.equal(r.props.duration, 0.3)
  assert.equal(r.props.easingFunction, "CUBIC_BEZIER")
  assert.equal(r.props.cubicBezierX2, 0.58)
})
test("native text uses the canonical font field and converts pixel line-height to em", async () => {
  const text = node("text", "TEXT", {
    characters: "Hello",
    textAutoResize: "WIDTH_AND_HEIGHT",
    fontName: { family: "Inter", style: "Bold" },
    fontSize: 20,
    letterSpacing: { unit: "PIXELS", value: 1 },
    lineHeight: { unit: "PIXELS", value: 30 },
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
  })
  const props = (await readDesign(api, [text])).units[0].root.props
  assert.equal(props.font, "Inter-Bold")
  assert.equal(props.lineHeight, 1.5)
  assert.equal(props.letterSpacing, 5)
  assert.equal(props.fillEnabled, false)
  assert.equal(props.sizeMode, "FIXED_SIZE")
})

test("raster bytes are read once and image opacity and rounded corners survive", async () => {
  let reads = 0
  const imageApi = {
    ...api,
    getImageByHash: () => ({
      getBytesAsync: async () => {
        reads++
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      },
    }),
  }
  const make = (id) =>
    node(id, "RECTANGLE", {
      opacity: 0.5,
      cornerRadius: 8,
      fills: [{ type: "IMAGE", imageHash: "shared", scaleMode: "FILL", opacity: 0.4 }],
    })
  const design = await readDesign(imageApi, [make("a"), make("b")])
  assert.equal(reads, 1)
  assert.equal(design.assets.length, 1)
  assert.equal(design.units[0].root.props.opacity, 20)
  assert.equal(design.units[0].root.props.radiusTopLeft, 8)
})

test("empty SVG artwork does not abort its visible siblings or trigger an export", async () => {
  let exports = 0
  const empty = node("empty-icon", "VECTOR", {
    absoluteRenderBounds: null,
    exportAsync: async () => {
      exports++
      throw new Error("Failed to export node. This node may not have any visible layers.")
    },
  })
  const screen = node("screen", "FRAME", { children: [empty, node("visible", "RECTANGLE")] })
  const design = await readDesign(api, [screen])
  assert.equal(exports, 0)
  assert.equal(design.units[0].root.children[0].props.invisible, true)
  assert.equal(design.units[0].root.children[1].id, "visible")
  assert.equal(design.assets.length, 0)
  assert.match(design.notes.join("\n"), /empty-icon.*no rendered artwork/)
})

test("a visible instance with a hidden master exports the instance rather than invisible source layers", async () => {
  let sourceExports = 0,
    instanceExports = 0
  const main = node("master", "COMPONENT", {
    visible: false,
    children: [
      node("source-icon", "VECTOR", {
        absoluteRenderBounds: null,
        exportAsync: async () => {
          sourceExports++
          throw new Error("Failed to export node. This node may not have any visible layers.")
        },
      }),
    ],
  })
  const instance = node("visible-instance", "INSTANCE", {
    children: [],
    overrides: [],
    getMainComponentAsync: async () => main,
    exportAsync: async () => {
      instanceExports++
      return '<svg viewBox="0 0 100 30"><path d="M0 0h100v30z"/></svg>'
    },
  })
  const design = await readDesign(api, [instance])
  assert.equal(sourceExports, 0)
  assert.equal(instanceExports, 1)
  assert.equal(design.units[0].root.type, "IMAGE")
  assert.equal(design.components.length, 0)
  assert.match(design.notes.join("\n"), /hidden component master/)
  main.visible = true
  node("hidden-library", "FRAME", { visible: false, children: [main] })
  const fromHiddenParent = await readDesign(api, [instance])
  assert.equal(sourceExports, 0)
  assert.equal(instanceExports, 2)
  assert.equal(fromHiddenParent.units[0].root.type, "IMAGE")
})

test("zero geometry alone does not discard a visible stroked vector", async () => {
  let exports = 0
  const line = node("line", "LINE", {
    height: 0,
    absoluteRenderBounds: { x: 0, y: -1, width: 100, height: 2 },
    exportAsync: async () => {
      exports++
      return '<svg><path d="M0 0h100" stroke="black"/></svg>'
    },
  })
  const design = await readDesign(api, [line])
  assert.equal(exports, 1)
  assert.equal(design.units[0].root.type, "IMAGE")
})

test("visible export failures keep the failing layer and export reason instead of silently dropping artwork", async () => {
  const icon = node("icon:42", "VECTOR", {
    name: "Search icon",
    absoluteRenderBounds: { x: 0, y: 0, width: 24, height: 24 },
    exportAsync: async () => {
      throw new Error("Figma exporter failed")
    },
  })
  const screen = node("screen", "FRAME", { name: "Employees", children: [icon] })
  await assert.rejects(readDesign(api, [screen]), (error) => {
    assert.match(error.message, /Search icon.*icon:42.*Figma exporter failed/)
    assert.equal(error.diagnostic.stage, "figma-export")
    assert.equal(error.diagnostic.node.id, "icon:42")
    assert.deepEqual(error.diagnostic.node.path, ["Employees", "Search icon"])
    assert.match(error.diagnostic.reason, /unsupported primitive VECTOR/)
    return true
  })
})

test("empty decorated text keeps its layout placeholder without exporting outlines", async () => {
  const text = node("empty-text", "TEXT", {
    characters: "",
    fontName: mixed,
    exportAsync: async () => {
      throw new Error("No visible layers")
    },
  })
  const design = await readDesign(api, [text])
  assert.equal(design.units[0].root.props.invisible, true)
  assert.equal(design.assets.length, 0)
})

test("resolved layout keeps the sidebar and table at their Figma coordinates without reflow", async () => {
  const sidebar = node("sidebar", "FRAME", {
    x: 0,
    width: 256,
    height: 1200,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FILL",
    layoutGrow: 1,
    children: [],
  })
  const table = node("table", "FRAME", {
    x: 256,
    width: 1184,
    height: 1200,
    layoutSizingHorizontal: "FILL",
    layoutSizingVertical: "HUG",
    layoutGrow: 1,
    children: [],
  })
  const screen = node("screen", "FRAME", {
    width: 1440,
    height: 1200,
    layoutMode: "HORIZONTAL",
    primaryAxisSizingMode: "AUTO",
    children: [sidebar, table],
  })
  const design = await readDesign(api, [screen])
  assert.equal(design.units[0].root.props.layoutMode, "NONE")
  assert.equal(design.units[0].root.props.width, 1440)
  const [left, right] = design.units[0].root.children
  assert.equal(left.props.x, 0)
  assert.equal(right.props.x, 256)
  for (const child of [left, right]) {
    assert.equal(child.props.layoutGrow, 0)
    assert.equal(child.props.layoutSizingHorizontal, "FIXED")
    assert.equal(child.props.layoutSizingVertical, "FIXED")
  }
  const live = await readDesign(api, [screen], undefined, { liveAutoLayout: true })
  assert.equal(live.units[0].root.props.layoutMode, "HORIZONTAL")
  assert.equal(live.units[0].root.children[1].props.layoutSizingHorizontal, "FILL")
})

test("unsupported instance overrides import their resolved visible children without building a wrong master", async () => {
  let masterReads = 0
  const actual = node("Irow;label", "TEXT", {
    name: "Actual employee",
    characters: "Employee name",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 14,
    textAutoResize: "WIDTH_AND_HEIGHT",
    letterSpacing: { unit: "PIXELS", value: 0 },
    lineHeight: { unit: "AUTO" },
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
  })
  const instance = node("row", "INSTANCE", {
    children: [actual],
    overrides: [{ id: actual.id, overriddenFields: ["fills", "characters", "visible"] }],
    getMainComponentAsync: async () => {
      masterReads++
      throw new Error("The source master should not be read")
    },
  })
  const design = await readDesign(api, [instance])
  assert.equal(masterReads, 0)
  assert.equal(design.components.length, 0)
  assert.equal(design.units[0].root.type, "CONTAINER")
  assert.equal(design.units[0].root.children[0].props.text, "Employee name")
  assert.equal(design.units[0].root.children[0].props.textColor, "#FF0000")
  assert.match(design.notes.join("\n"), /resolved instance/)
})

test("compatible text instances still share their master and match overrides by source ID", async () => {
  const text = (id, characters) =>
    node(id, "TEXT", {
      characters,
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 14,
      letterSpacing: { unit: "PIXELS", value: 0 },
      lineHeight: { unit: "AUTO" },
      textAutoResize: "NONE",
      textAlignHorizontal: "LEFT",
      textAlignVertical: "TOP",
    })
  const main = node("master", "COMPONENT", {
    children: [text("source-a", "A"), text("source-b", "B")],
  })
  const instance = node("instance", "INSTANCE", {
    children: [text("Iinstance;source-b", "New B"), text("Iinstance;source-a", "New A")],
    overrides: [],
    getMainComponentAsync: async () => main,
  })
  const design = await readDesign(api, [instance])
  assert.equal(design.components.length, 1)
  assert.equal(design.units[0].root.type, "COMPONENT_INSTANCE")
  assert.deepEqual(
    design.units[0].root.overrides.map((o) => [o.sourceId, o.props.text]),
    [
      ["source-b", "New B"],
      ["source-a", "New A"],
    ],
  )
})

test("a resized instance keeps actual child geometry instead of importing its default-size master", async () => {
  const main = node("master", "COMPONENT", { children: [node("source", "RECTANGLE", { x: 20 })] })
  const instance = node("instance", "INSTANCE", {
    width: 200,
    children: [node("Iinstance;source", "RECTANGLE", { x: 120 })],
    overrides: [],
    getMainComponentAsync: async () => main,
  })
  const design = await readDesign(api, [instance])
  assert.equal(design.components.length, 0)
  assert.equal(design.units[0].root.type, "CONTAINER")
  assert.equal(design.units[0].root.props.width, 200)
  assert.equal(design.units[0].root.children[0].props.x, 120)
})

test("disabling component creation reads visible nested instance content without resolving masters", async () => {
  const label = node("nested;label", "TEXT", {
    characters: "Overridden label",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 14,
    letterSpacing: { unit: "PIXELS", value: 0 },
    lineHeight: { unit: "AUTO" },
    textAutoResize: "NONE",
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
  })
  const master = () => {
    throw Error("Component creation is off: masters must not be requested")
  }
  const inner = node("nested", "INSTANCE", { children: [label], getMainComponentAsync: master })
  const outer = node("outer", "INSTANCE", { children: [inner], getMainComponentAsync: master })
  const direct = node("direct", "COMPONENT", { children: [node("rect", "RECTANGLE")] })
  const screen = node("screen", "FRAME", { children: [outer, direct] })
  const design = await readDesign(api, [screen], undefined, { createComponents: false })
  assert.equal(design.components.length, 0)
  const [resolved, component] = design.units[0].root.children
  assert.equal(resolved.type, "CONTAINER")
  assert.equal(resolved.children[0].type, "CONTAINER")
  assert.equal(resolved.children[0].children[0].props.text, "Overridden label")
  assert.equal(component.type, "CONTAINER")
  assert.equal(component.children[0].type, "RECT")
  assert.equal(design.assets.length, 0, "ordinary content stays editable without image flattening")
})

test("component mode can switch off and back on without creating extra masters", async () => {
  const { importDesign } = await import("./.compiled/importer.mjs")
  const { emptyState } = await import("./.compiled/design.mjs")
  const { FakeStudio } = await import("./fixtures/studio.mjs")
  const main = node("master", "COMPONENT", { children: [node("source", "RECTANGLE")] })
  const instance = node("instance", "INSTANCE", {
    children: [node("Iinstance;source", "RECTANGLE")],
    overrides: [],
    getMainComponentAsync: async () => main,
  })
  const screen = node("screen", "FRAME", { children: [instance] })
  const studio = new FakeStudio(),
    state = emptyState()
  const enabled = await readDesign(api, [screen])
  assert.equal(enabled.components.length, 1)
  assert.deepEqual((await importDesign(studio, enabled, state)).report.errors, [])
  const masterId = state.scopes["component:master"].id,
    sceneId = state.scopes["scene:screen"].id
  const before = studio.operations.length
  const disabled = await readDesign(api, [screen], undefined, { createComponents: false })
  assert.equal(disabled.components.length, 0)
  const off = await importDesign(studio, disabled, state)
  assert.deepEqual(off.report.errors, [])
  assert.deepEqual(off.report.conflicts, [])
  assert.equal(
    studio.operations.slice(before).some((op) => op.tool === "component_manage"),
    false,
  )
  assert.equal(state.scopes["scene:screen"].nodes.instance.type, "CONTAINER")
  assert.equal(state.scopes["scene:screen"].nodes["Iinstance;source"].type, "RECT")
  assert.equal(studio.components.has(masterId), true, "existing masters must be preserved")
  assert.equal((await importDesign(studio, disabled, state)).report.calls, 0)
  const on = await importDesign(studio, enabled, state)
  assert.deepEqual(on.report.errors, [])
  assert.deepEqual(on.report.conflicts, [])
  assert.equal(state.scopes["component:master"].id, masterId)
  assert.equal(state.scopes["scene:screen"].id, sceneId)
  assert.equal(studio.components.size, 1)
})

test("oversized embedded photos export at 2x display size while normal vector artwork stays SVG", async () => {
  const oversized = '<svg><image href="data:image/jpeg;base64,' + "A".repeat(100000) + '"/></svg>'
  const calls = []
  const avatar = node("avatar", "FRAME", {
    width: 38,
    height: 38,
    fills: [{ type: "IMAGE" }],
    exportAsync: async (settings) => {
      calls.push(settings)
      return settings.format === "PNG" ? new Uint8Array([137, 80, 78, 71]) : oversized
    },
  })
  const result = await readDesign(api, [avatar])
  assert.equal(result.assets[0].mimeType, "image/png")
  assert.deepEqual(calls[1].constraint, { type: "SCALE", value: 2 })
  assert.equal(result.units[0].root.props.width, 38)
  assert.match(result.notes.join("\n"), /2x display size/)
  const vector = node("vector", "VECTOR", {
    exportAsync: async (settings) => {
      assert.equal(settings.format, "SVG_STRING")
      return '<svg><path d="M0 0"/>' + " ".repeat(100000) + "</svg>"
    },
  })
  assert.equal((await readDesign(api, [vector])).assets[0].mimeType, "image/svg+xml")
})

test("raster optimization failure retains valid artwork and constrains unusually large renders", async () => {
  const svg = '<svg><image href="data:image/png;base64,' + "A".repeat(100000) + '"/></svg>'
  const large = node("large", "VECTOR", {
    width: 8000,
    height: 4000,
    exportAsync: async (settings) => {
      if (settings.format === "PNG") {
        assert.equal(settings.constraint.value, 4096 / 8000)
        throw new Error("PNG export unavailable")
      }
      return svg
    },
  })
  const result = await readDesign(api, [large])
  assert.equal(result.assets[0].mimeType, "image/svg+xml")
  assert.equal(result.assets[0].data, svg)
  assert.match(result.notes.join("\n"), /retained the full SVG/)
})

for (const liveAutoLayout of [false, true])
  test(`recorded production logo keeps its frame-relative position with live layout ${liveAutoLayout ? "on" : "off"}`, async () => {
    const source = JSON.parse(
      await readFile(new URL("./fixtures/grouped-logo-source.json", import.meta.url), "utf8"),
    )
    function hydrate(n, parent) {
      n.parent = parent
      n.fills = []
      n.strokes = []
      n.effects = []
      n.exportAsync = async () => "<svg/>"
      for (const child of n.children ?? []) hydrate(child, n)
    }
    hydrate(source, { type: "PAGE", id: "page" })
    const design = await readDesign(api, [source], undefined, {
      createComponents: false,
      liveAutoLayout,
    })
    const logo = design.units[0].root.children[0],
      group = logo.children[0],
      nested = group.children[0]
    assert.equal(group.props.x, 20)
    assert.equal(nested.props.x, 0)
    assert.equal(nested.props.y, 0)
    assert.equal(nested.children.length, 10)
    const studio = new FakeStudio()
    const { report, state } = await importDesign(studio, design)
    assert.deepEqual(report.errors, [])
    const records = Object.values(state.scopes)[0].nodes
    for (const [index, child] of nested.children.entries()) {
      let x = 0,
        y = 0,
        current = records[child.id]
      while (current) {
        const native = studio.nodes.get(current.id)
        x += native.props.x
        y += native.props.y
        current = current.parent ? records[current.parent] : undefined
      }
      const original = source.children[0].children[0].children[0].children[index]
      assert.ok(
        Math.abs(x - (original.absoluteRenderBounds.x - source.absoluteTransform[0][2])) < 0.0001,
      )
      assert.ok(
        Math.abs(y - (original.absoluteRenderBounds.y - source.absoluteTransform[1][2])) < 0.0001,
      )
    }
    assert.equal((await importDesign(studio, design, state)).report.calls, 0)
  })

test("native rectangles and text normalize group coordinates and rotation instead of repeating the group's transform", async () => {
  const a = Math.PI / 6,
    c = Math.cos(a),
    s = Math.sin(a)
  const rect = node("rect", "RECTANGLE", {
    x: 10 + c * 8 + s * 12,
    y: 20 - s * 8 + c * 12,
    rotation: 30,
    absoluteTransform: [
      [c, s, 100 + c * 8 + s * 12],
      [-s, c, 200 - s * 8 + c * 12],
    ],
  })
  const text = node("text", "TEXT", {
    x: 10,
    y: 20,
    rotation: 30,
    absoluteTransform: [
      [c, s, 100],
      [-s, c, 200],
    ],
    characters: "Grouped label",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    letterSpacing: { unit: "PIXELS", value: 0 },
    lineHeight: { unit: "AUTO" },
  })
  const group = node("group", "GROUP", {
    x: 10,
    y: 20,
    rotation: 30,
    absoluteTransform: [
      [c, s, 100],
      [-s, c, 200],
    ],
    children: [rect, text],
  })
  const design = await readDesign(api, [group])
  const [r, t] = design.units[0].root.children
  assert.ok(Math.abs(r.props.x - 8) < 1e-8)
  assert.ok(Math.abs(r.props.y - 12) < 1e-8)
  assert.ok(Math.abs(r.props.rotation) < 1e-8)
  assert.ok(Math.abs(t.props.x) < 1e-8)
  assert.ok(Math.abs(t.props.y) < 1e-8)
  assert.ok(Math.abs(t.props.rotation) < 1e-8)
  assert.equal(design.units[0].root.props.rotation, -30)
})

test("an ordinary frame child retains its own local geometry and rotation", async () => {
  const rect = node("rect", "RECTANGLE", {
    x: 3,
    y: 5,
    rotation: 15,
    absoluteTransform: [
      [1, 0, 103],
      [0, 1, 105],
    ],
  })
  const frame = node("frame", "FRAME", {
    absoluteTransform: [
      [1, 0, 100],
      [0, 1, 100],
    ],
    children: [rect],
  })
  const result = (await readDesign(api, [frame])).units[0].root.children[0].props
  assert.equal(result.x, 3)
  assert.equal(result.y, 5)
  assert.equal(result.rotation, -15)
})

test("fractional vector bounds trim only rounded export padding without shrinking the glyph", async () => {
  const svg =
    '<svg stroke-width="2" width="3" height="13" viewBox="0 0 3 13"><path d="M0 0h2.0587v12.3913"/></svg>'
  const vector = node("glyph", "VECTOR", {
    width: 2.0587,
    height: 12.3913,
    exportAsync: async () => svg,
  })
  const result = await readDesign(api, [vector])
  assert.match(result.assets[0].data, /viewBox="0 0 2.0587 12.3913"/)
  assert.match(result.assets[0].data, /width="2.0587"/)
  assert.match(result.assets[0].data, /stroke-width="2"/)
  assert.match(result.assets[0].data, /d="M0 0h2.0587v12.3913"/)
  assert.equal(result.units[0].root.props.width, 2.0587)
  const unchanged = [
    '<svg width="3" height="13" viewBox="-1 -1 3 13"/>',
    '<svg width="30" height="130" viewBox="0 0 3 13"/>',
    '<svg width="24" height="24" viewBox="0 0 24 24"/>',
  ]
  for (const svg of unchanged) {
    vector.exportAsync = async () => svg
    assert.equal((await readDesign(api, [vector])).assets[0].data, svg)
  }
})

for (const type of ["GROUP", "BOOLEAN_OPERATION"])
  test(`${type} child transforms stay local beneath a rotated frame`, async () => {
    function transform(angle, x, y) {
      const r = (angle * Math.PI) / 180
      return [
        [Math.cos(r), -Math.sin(r), x],
        [Math.sin(r), Math.cos(r), y],
      ]
    }
    function product(a, b) {
      return [
        [
          a[0][0] * b[0][0] + a[0][1] * b[1][0],
          a[0][0] * b[0][1] + a[0][1] * b[1][1],
          a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
        ],
        [
          a[1][0] * b[0][0] + a[1][1] * b[1][0],
          a[1][0] * b[0][1] + a[1][1] * b[1][1],
          a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
        ],
      ]
    }
    const frameTransform = transform(20, 100, -200),
      groupTransform = product(frameTransform, transform(-30, 10, 20))
    const child = node("rect", "RECTANGLE", {
      x: 99,
      y: 99,
      rotation: 42,
      absoluteTransform: product(groupTransform, transform(-12, 8, 12)),
    })
    const group = node("group", type, {
      x: 10,
      y: 20,
      rotation: 30,
      absoluteTransform: groupTransform,
      children: [child],
    })
    const frame = node("frame", "FRAME", { absoluteTransform: frameTransform, children: [group] })
    const p = (await readDesign(api, [frame])).units[0].root.children[0].children[0].props
    assert.ok(Math.abs(p.x - 8) < 1e-8)
    assert.ok(Math.abs(p.y - 12) < 1e-8)
    assert.ok(Math.abs(p.rotation + 12) < 1e-8)
  })

test("shared component masters use the same corrected group coordinates", async () => {
  function children(prefix, origin) {
    const rectangle = node(`${prefix}rect`, "RECTANGLE", {
      x: 20,
      y: 20,
      absoluteTransform: [
        [1, 0, origin + 20],
        [0, 1, origin + 20],
      ],
    })
    return [
      node(`${prefix}group`, "GROUP", {
        x: 20,
        y: 20,
        absoluteTransform: [
          [1, 0, origin + 20],
          [0, 1, origin + 20],
        ],
        children: [rectangle],
      }),
    ]
  }
  const main = node("main", "COMPONENT", {
    x: 500,
    y: 500,
    absoluteTransform: [
      [1, 0, 500],
      [0, 1, 500],
    ],
    children: children("", 500),
  })
  const instance = node("instance", "INSTANCE", {
    x: 1000,
    y: 1000,
    absoluteTransform: [
      [1, 0, 1000],
      [0, 1, 1000],
    ],
    overrides: [],
    getMainComponentAsync: async () => main,
    children: children("Iinstance;", 1000),
  })
  const design = await readDesign(api, [instance], undefined, { createComponents: true })
  assert.equal(design.components.length, 1)
  assert.equal(design.units[0].root.component, "main")
  const group = design.components[0].root.children[0]
  assert.equal(group.props.x, 20)
  assert.equal(group.children[0].props.x, 0)
  assert.equal(group.children[0].props.y, 0)
  const studio = new FakeStudio()
  const { report } = await importDesign(studio, design)
  assert.deepEqual(report.errors, [])
})

test("editable instance mode overlaps at most four exports and preserves source order", async () => {
  let active = 0,
    maximum = 0
  const nodes = Array.from({ length: 12 }, (_, i) =>
    node("v" + i, "VECTOR", {
      exportAsync: async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, ((12 - i) % 4) + 1))
        active--
        return `<svg id="${i}"/>`
      },
    }),
  )
  const source = node("screen", "FRAME", { children: nodes })
  const result = await readDesign(api, [source], undefined, { createComponents: false })
  assert.equal(maximum, 4)
  assert.equal(active, 0)
  assert.deepEqual(
    result.units[0].root.children.map((n) => n.id),
    nodes.map((n) => n.id),
  )
  assert.equal(result.assets.length, 12)
})

test("parallel raster siblings share one original read and failed exports finish draining before returning", async () => {
  let reads = 0,
    active = 0
  const imageApi = {
    ...api,
    getImageByHash: () => ({
      getBytesAsync: async () => {
        reads++
        await new Promise((resolve) => setTimeout(resolve, 2))
        return new Uint8Array([137, 80, 78, 71])
      },
    }),
  }
  const image = (id) =>
    node(id, "RECTANGLE", { fills: [{ type: "IMAGE", imageHash: "same", scaleMode: "FILL" }] })
  await readDesign(
    imageApi,
    [node("screen", "FRAME", { children: [image("a"), image("b")] })],
    undefined,
    { createComponents: false },
  )
  assert.equal(reads, 1)
  const vector = (id, fail) =>
    node(id, "VECTOR", {
      exportAsync: async () => {
        active++
        await new Promise((resolve) => setTimeout(resolve, 3))
        active--
        if (fail) throw Error("export failed")
        return "<svg/>"
      },
    })
  await assert.rejects(
    readDesign(
      api,
      [node("screen", "FRAME", { children: [vector("bad", true), vector("good", false)] })],
      undefined,
      { createComponents: false },
    ),
    /export failed/,
  )
  assert.equal(active, 0)
})
