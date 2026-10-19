import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { listContexts, callToolContent } from "./.compiled/protopie-client.mjs"
import { Studio, flattenTree } from "./.compiled/studio.mjs"
import { importDesign } from "./.compiled/importer.mjs"
import { emptyState } from "./.compiled/design.mjs"
import { readDesign } from "./.compiled/read-design.mjs"
import { readFontCatalog } from "../scripts/local-ui.mjs"

test(
  "live native text: natural run widths, clipping, font faces, parent moves and cleanup",
  { skip: !process.env.F2P_LIVE_CONNECTION },
  async () => {
    const connection = JSON.parse(await readFile(process.env.F2P_LIVE_CONNECTION, "utf8"))
    const contexts = await listContexts(connection.endpoint, connection.connectionId)
    const scratch = contexts.find(
      (c) =>
        c.contextId === connection.contextId &&
        c.isActiveTab &&
        c.tabName === "Untitled" &&
        !c.filePath,
    )
    assert.ok(scratch, "Focus the approved unsaved Untitled scratch Pie")
    const studio = new Studio({ ...connection, contextId: scratch.contextId })
    const original = await studio.tool("studio_session_init", { include_op_kinds: false })
    const state = emptyState(),
      prefix = `F2P_TEXT_QA_${Date.now()}`
    const node = (id, type, props = {}, children = []) => ({
      id,
      type,
      props: { name: id, x: 0, y: 0, width: 160, height: 21, ...props },
      children,
    })
    const root = node(prefix, "CONTAINER", {
      width: 500,
      height: 520,
      fillEnabled: true,
      fillColor: "#FFFFFF",
      layoutMode: "NONE",
    })
    const design = {
      version: 2,
      units: [{ id: root.id, scene: true, root }],
      components: [],
      variables: [],
      assets: [],
      notes: [],
    }
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/step-label-source.json", import.meta.url), "utf8"),
    )
    const mixed = Symbol("mixed"),
      api = { mixed, variables: { getLocalVariablesAsync: async () => [] } }
    const labelIds = []
    for (const [index, { source, segments }] of fixture.labels.entries()) {
      const label = {
        ...source,
        id: `${prefix}_label_${index}`,
        fills: mixed,
        strokes: [],
        effects: [],
        parent: { id: "page", type: "PAGE" },
        getStyledTextSegments: () => structuredClone(segments),
        exportAsync: async () => {
          throw Error("Text must stay native")
        },
      }
      const read = await readDesign(api, [label], undefined, {
        liveAutoLayout: true,
        clipTruncatedText: true,
      })
      const native = read.units[0].root
      Object.assign(native.props, {
        x: 24,
        y: 24 + index * 36,
        layoutSizingHorizontal: "FIXED",
        layoutGrow: 0,
        layoutPositioning: "ABSOLUTE",
      })
      root.children.push(native)
      labelIds.push(native.id)
    }
    const clip = node(
      `${prefix}_clip`,
      "CONTAINER",
      {
        x: 24,
        y: 150,
        width: 120,
        clipChildren: true,
        fillEnabled: false,
        layoutMode: "HORIZONTAL",
        primaryAxisSizingMode: "FIXED",
        counterAxisSizingMode: "FIXED",
        itemSpacing: 0,
      },
      [
        node(`${prefix}_long`, "TEXT", {
          text: "a.very.long.email.address@example.com",
          font: "Gilroy-Regular",
          fontSize: 14,
          textColor: "#111111",
          textOpacity: 100,
          sizeMode: "AUTO_WIDTH",
          width: undefined,
          height: undefined,
          layoutSizingHorizontal: "HUG",
          layoutSizingVertical: "HUG",
          layoutGrow: 0,
        }),
      ],
    )
    root.children.push(clip)
    const styles = [
      ["Gilroy", "Regular", 400],
      ["Gilroy", "Medium", 500],
      ["Gilroy", "Semibold", 600],
      ["Gilroy", "Bold", 700],
      ["Circular Std", "Book", 450],
      ["Circular Std", "Bold", 700],
    ]
    for (const [index, [family, style, weight]] of styles.entries()) {
      const text = node(`${prefix}_weight_${weight}_${index}`, "TEXT", {
        x: 24,
        y: 190 + index * 32,
        width: 340,
        height: 28,
        text: `${family} ${style} ${weight}`,
        font: `${family}-${style}`,
        fontSize: 20,
        textColor: "#111111",
        textOpacity: 100,
        sizeMode: "AUTO_WIDTH",
      })
      text.font = { family, style, weight }
      root.children.push(text)
    }
    const movable = node(`${prefix}_moving`, "TEXT", {
      text: "Move without replacing",
      font: "Gilroy-Regular",
      fontSize: 14,
      textColor: "#111111",
      textOpacity: 100,
    })
    const left = node(`${prefix}_left`, "CONTAINER", { x: 24, y: 410, width: 210, height: 40 }, [
        movable,
      ]),
      right = node(`${prefix}_right`, "CONTAINER", { x: 250, y: 410, width: 210, height: 40 })
    root.children.push(left, right)
    const { fonts: fontFaces } = await readFontCatalog()
    assert.ok(
      fontFaces.length,
      "Native face verification requires Studio's installed font metadata",
    )
    const run = () => importDesign(studio, design, state, { fontFaces })
    const clean = (result) => {
      assert.deepEqual(result.report.errors, [])
      assert.deepEqual(result.report.conflicts, [])
    }
    const evidence = {}
    try {
      const first = await run()
      clean(first)
      const scope = state.scopes[`scene:${root.id}`]
      const view = await studio.view(scope.id),
        tree = flattenTree(view.tree)
      evidence.runWidths = labelIds.map((id) => {
        const label = root.children.find((n) => n.id === id)
        const widths = label.children.map((n) => tree.get(scope.nodes[n.id].id)?.bbox[2])
        assert.ok(
          widths.every((w) => Number.isFinite(w) && w > 0 && w < 160),
          "Native text runs must hug their contents",
        )
        return widths
      })
      assert.equal(tree.get(scope.nodes[clip.id].id).bbox[2], 120)
      assert.ok(
        tree.get(scope.nodes[clip.children[0].id].id).bbox[2] > 120,
        "Long text must remain unwrapped behind the clip",
      )
      const catalog = await studio.tool("query_design_system", {
        sceneId: scope.id,
        include: ["styles"],
      })
      evidence.nativeStyles = catalog.styles
      evidence.faces = styles.map((_, index) => scope.nodes[root.children[4 + index].id].props.font)
      assert.deepEqual(evidence.faces, [
        "Gilroy-Regular",
        "Gilroy-Medium",
        "Gilroy-SemiBold",
        "Gilroy-Bold",
        "CircularStd-Book",
        "CircularStd-Bold",
      ])
      assert.deepEqual([...catalog.styles.fontFamilies].sort(), [...evidence.faces].sort())
      const oldId = scope.nodes[movable.id].id
      for (const [from, to] of [
        [left, right],
        [right, left],
      ]) {
        from.children = []
        to.children = [movable]
        clean(await run())
        assert.equal(scope.nodes[movable.id].id, oldId)
        assert.equal(scope.nodes[movable.id].parent, to.id)
        const moved = flattenTree((await studio.view(scope.id, false, false)).tree)
        assert.ok(
          moved.get(scope.nodes[to.id].id)?.children?.some((n) => n.id === oldId),
          "The native layer tree must place the text inside its new parent",
        )
        assert.equal(moved.get(oldId).bbox[0], movable.props.x)
        assert.equal(moved.get(oldId).bbox[1], movable.props.y)
      }
      const unchanged = await run()
      clean(unchanged)
      assert.equal(unchanged.report.calls, 0)
      const preview = await callToolContent(connection.endpoint, "capture_preview", {
        connectionId: connection.connectionId,
        contextId: scratch.contextId,
        sceneId: scope.id,
      })
      const image = preview.find((c) => c.type === "image")
      assert.ok(image)
      await mkdir(".scratch-qa", { recursive: true })
      await writeFile(".scratch-qa/native-text-qa.png", Buffer.from(image.data, "base64"))
      await writeFile(".scratch-qa/native-text-qa.json", JSON.stringify(evidence, null, 2))
    } finally {
      await studio.tool("start_editing")
      try {
        if (original.currentSceneId)
          assert.equal(
            (
              await studio.write([
                {
                  tool: "scene_manage",
                  input: { action: "select", sceneIdList: [original.currentSceneId] },
                },
              ])
            ).failureCount,
            0,
          )
        const ids = Object.values(state.scopes)
          .filter((s) => s.kind === "scene" && s.id)
          .map((s) => s.id)
        if (ids.length)
          assert.equal(
            (
              await studio.write([
                { tool: "scene_manage", input: { action: "delete", sceneIdList: ids } },
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
