/// <reference types="@figma/plugin-typings" />
import {
  digest,
  type Design,
  type DesignNode,
  type DesignReaction,
  type DesignUnit,
  type Properties,
  type ReadFailure,
} from "./design"

export class ReadDesignError extends Error {
  constructor(readonly diagnostic: ReadFailure) {
    super(diagnostic.message)
    this.name = "ReadDesignError"
  }
}
function hiddenInDocument(node: BaseNode | null): boolean {
  for (let current = node; current && current.type !== "DOCUMENT"; current = current.parent) {
    if (
      ("visible" in current && !current.visible) ||
      ("opacity" in current && current.opacity === 0)
    )
      return true
  }
  return false
}
function readFailure(node: SceneNode, error: unknown, reason?: string): ReadDesignError {
  const path: string[] = []
  for (
    let current: BaseNode | null = node;
    current && current.type !== "PAGE" && current.type !== "DOCUMENT";
    current = current.parent
  )
    path.unshift(current.name)
  const message = error instanceof Error ? error.message : String(error)
  return new ReadDesignError({
    stage: reason ? "figma-export" : "figma-read",
    message: `${reason ? "Cannot export" : "Cannot read"} "${node.name}" (${node.type}, ${node.id}): ${message}`,
    reason,
    node: {
      id: node.id,
      name: node.name,
      type: node.type,
      path,
      width: node.width,
      height: node.height,
      visible: node.visible,
      opacity: "opacity" in node ? node.opacity : 1,
      renderBounds: "absoluteRenderBounds" in node ? node.absoluteRenderBounds : undefined,
    },
  })
}
function hex(c: RGB): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((n) =>
        Math.round(Math.max(0, Math.min(1, n)) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  )
}
function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i],
      b = bytes[i + 1],
      c = bytes[i + 2]
    chunks.push(
      alphabet[a >> 2] +
        alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] +
        (b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]) +
        (c === undefined ? "=" : alphabet[c & 63]),
    )
  }
  return chunks.join("")
}
function trimExportPadding(svg: string, width: number, height: number): string {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!root) return svg
  const attribute = (name: string) =>
    root.match(new RegExp(`\\s${name}=["']([^"']+)["']`, "i"))?.[1]
  const box = attribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  const exportedWidth = Number(attribute("width")),
    exportedHeight = Number(attribute("height"))
  // Figma rounds the exported viewport up, leaving transparent right/bottom padding. Scaling
  // that padded viewport into fractional render bounds shrinks each glyph by a different ratio.
  // Trim only this recognized rounding case; retain intentional viewBox offsets and scaling.
  if (
    !box ||
    box.length !== 4 ||
    box[0] !== 0 ||
    box[1] !== 0 ||
    box[2] !== exportedWidth ||
    box[3] !== exportedHeight ||
    !Number.isInteger(exportedWidth) ||
    !Number.isInteger(exportedHeight) ||
    width <= 0 ||
    height <= 0 ||
    ![width, height, exportedWidth, exportedHeight].every(Number.isFinite) ||
    exportedWidth < width ||
    exportedWidth - width >= 1 ||
    exportedHeight < height ||
    exportedHeight - height >= 1
  )
    return svg
  const next = root
    .replace(/(\s)width=["'][^"']*["']/i, `$1width="${width}"`)
    .replace(/(\s)height=["'][^"']*["']/i, `$1height="${height}"`)
    .replace(/(\s)viewBox=["'][^"']*["']/i, `$1viewBox="0 0 ${width} ${height}"`)
  return svg.replace(root, next)
}
function geometry(node: SceneNode, liveAutoLayout = false): Properties {
  const p: Properties = {
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: -("rotation" in node ? node.rotation : 0),
    anchorX: 0,
    anchorY: 0,
    opacity: Math.round(("opacity" in node ? node.opacity : 1) * 100),
    invisible: node.visible === false,
  }
  // Figma skips GROUP and BOOLEAN_OPERATION ancestors in x/y and relativeTransform.
  // We retain those ancestors as native containers, so their children need immediate-parent
  // coordinates. Absolute transforms also handle nested and rotated groups correctly.
  const parent = node.parent
  if (
    parent &&
    (parent.type === "GROUP" || parent.type === "BOOLEAN_OPERATION") &&
    node.absoluteTransform &&
    parent.absoluteTransform
  ) {
    const t = parent.absoluteTransform,
      n = node.absoluteTransform
    const determinant = t[0][0] * t[1][1] - t[0][1] * t[1][0]
    if (Math.abs(determinant) < 0.000001)
      throw new Error("Cannot resolve coordinates inside a group with a singular transform")
    const x = n[0][2] - t[0][2],
      y = n[1][2] - t[1][2]
    p.x = (t[1][1] * x - t[0][1] * y) / determinant
    p.y = (-t[1][0] * x + t[0][0] * y) / determinant
    const axisX = (t[1][1] * n[0][0] - t[0][1] * n[1][0]) / determinant
    const axisY = (-t[1][0] * n[0][0] + t[0][0] * n[1][0]) / determinant
    p.rotation = (Math.atan2(axisY, axisX) * 180) / Math.PI
  }
  if ("layoutPositioning" in node) p.layoutPositioning = node.layoutPositioning
  if ("layoutGrow" in node) p.layoutGrow = node.layoutGrow
  if ("layoutSizingHorizontal" in node) {
    p.layoutSizingHorizontal = node.layoutSizingHorizontal
    p.layoutSizingVertical = node.layoutSizingVertical
  }
  if ("constraints" in node) {
    const c = node.constraints
    p.fixLeft = ["MIN", "STRETCH"].includes(c.horizontal)
    p.fixRight = ["MAX", "STRETCH"].includes(c.horizontal)
    p.fixTop = ["MIN", "STRETCH"].includes(c.vertical)
    p.fixBottom = ["MAX", "STRETCH"].includes(c.vertical)
  }
  if (!liveAutoLayout) {
    p.layoutGrow = 0
    p.layoutPositioning = "ABSOLUTE"
    p.layoutSizingHorizontal = "FIXED"
    p.layoutSizingVertical = "FIXED"
  }
  return p
}

export interface ReadOptions {
  createComponents?: boolean
  liveAutoLayout?: boolean
  clipTruncatedText?: boolean
}

function singleLineTruncation(node: TextNode): boolean {
  if (
    (node.textTruncation !== "ENDING" && node.textAutoResize !== "TRUNCATE") ||
    /[\r\n\u2028\u2029]/.test(node.characters) ||
    (node.maxLines != null && node.maxLines !== 1)
  )
    return false
  if (node.maxLines === 1) return true
  // Fixed-height truncation has no line limit. Only infer one line when the resolved
  // box fits a single line; never turn an ordinary multi-line paragraph into a strip.
  if (!["NONE", "TRUNCATE"].includes(node.textAutoResize) || typeof node.fontSize !== "number")
    return false
  const line = node.lineHeight
  const height =
    line && typeof line === "object" && line.unit !== "AUTO"
      ? line.unit === "PIXELS"
        ? line.value
        : (line.value / 100) * node.fontSize
      : node.fontSize * 1.5
  return node.height > 0 && node.height <= height + 0.5
}

export async function readDesign(
  api: PluginAPI,
  selection: readonly SceneNode[],
  onProgress: (count: number) => void = () => {},
  options: ReadOptions = {},
): Promise<Design> {
  const design: Design = {
    version: 2,
    units: [],
    components: [],
    assets: [],
    variables: [],
    notes: [],
  }
  const assets = new Map<string, Design["assets"][number]>()
  const rasterCache = new Map<string, Promise<Design["assets"][number]>>()
  let exporting = 0
  const exportQueue: (() => void)[] = []
  async function exportArtwork<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => {
        exporting++
        resolve()
      }
      if (exporting < 4) start()
      else exportQueue.push(start)
    })
    try {
      return await task()
    } finally {
      exporting--
      exportQueue.shift()?.()
    }
  }
  const components = new Map<string, Design["components"][number]>()
  const clippedSources = new Set<string>()
  const resolving = new Set<string>()
  let count = 0,
    resolvedLayouts = 0,
    clippedTexts = 0
  const clipsText = (node: TextNode) =>
    options.clipTruncatedText !== false && singleLineTruncation(node)
  function note(node: { name: string }, message: string) {
    design.notes.push(`${node.name}: ${message}`)
  }
  async function flattened(node: SceneNode, reason: string): Promise<DesignNode> {
    const bounds = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : undefined
    // Keep an empty layer's position without asking Figma to export nonexistent artwork.
    // A zero-height LINE can still have a visible stroke, so use render bounds, not geometry.
    if (
      hiddenInDocument(node) ||
      bounds === null ||
      (bounds && (bounds.width <= 0 || bounds.height <= 0)) ||
      (node.type === "TEXT" && node.characters.length === 0)
    ) {
      note(node, "no rendered artwork; kept as an invisible placeholder")
      return {
        id: node.id,
        type: "CONTAINER",
        props: {
          ...geometry(node, options.liveAutoLayout),
          invisible: true,
          fillEnabled: false,
          borderEnabled: false,
          shadowEnabled: false,
          layoutMode: "NONE",
        },
        children: [],
        reactions: reactions(node),
      }
    }
    let svg: string
    try {
      svg = await exportArtwork(() =>
        node.exportAsync({ format: "SVG_STRING", svgOutlineText: true }),
      )
    } catch (error) {
      throw readFailure(node, error, reason)
    }
    let data = svg,
      mimeType: "image/svg+xml" | "image/png" = "image/svg+xml"
    // A tiny avatar may otherwise embed its entire multi-megapixel JPEG inside an SVG.
    // Keep ordinary vector exports sharp; resample only oversized embedded raster artwork.
    if (svg.length > 64 * 1024 && /data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(svg)) {
      const width = bounds?.width ?? node.width,
        height = bounds?.height ?? node.height
      const scale = Math.min(2, 4096 / Math.max(width, height, 1))
      try {
        const png = base64(
          await exportArtwork(() =>
            node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } }),
          ),
        )
        if (png.length < svg.length) {
          data = png
          mimeType = "image/png"
        }
      } catch {
        note(node, "raster optimization unavailable; retained the full SVG artwork")
      }
    }
    note(
      node,
      `${reason}; imported as ${mimeType === "image/png" ? "a PNG at up to 2x display size" : "an SVG image"} to preserve its appearance.`,
    )
    const props = geometry(node, options.liveAutoLayout)
    // Export already contains the node's transform and effects; use its exported visual bounds.
    if (bounds && node.parent && "absoluteTransform" in node.parent) {
      const t = node.parent.absoluteTransform,
        determinant = t[0][0] * t[1][1] - t[0][1] * t[1][0]
      if (Math.abs(determinant) > 0.000001) {
        const x = bounds.x - t[0][2],
          y = bounds.y - t[1][2]
        props.x = (t[1][1] * x - t[0][1] * y) / determinant
        props.y = (-t[1][0] * x + t[0][0] * y) / determinant
        props.width = bounds.width
        props.height = bounds.height
      }
    }
    props.rotation = 0
    props.opacity = 100
    if (mimeType === "image/svg+xml") {
      const transform =
        node.parent && "absoluteTransform" in node.parent
          ? node.parent.absoluteTransform
          : undefined
      if (
        !transform ||
        (Math.abs(transform[0][1]) < 0.000001 && Math.abs(transform[1][0]) < 0.000001)
      )
        data = trimExportPadding(data, Number(props.width), Number(props.height))
    }
    const key = digest(data)
    assets.set(key, { key, mimeType, data })
    return {
      id: node.id,
      type: "IMAGE",
      props,
      children: [],
      asset: key,
      reactions: reactions(node),
    }
  }
  function style(node: SceneNode, props: Properties) {
    if ("fills" in node) {
      const fills = node.fills === api.mixed ? [] : node.fills.filter((p) => p.visible !== false)
      const fill = fills[0]
      props.fillEnabled = !!fill
      props.fillColor = fill?.type === "SOLID" ? hex(fill.color) : "#FFFFFF"
      props.fillOpacity = fill?.type === "SOLID" ? Math.round((fill.opacity ?? 1) * 100) : 0
    }
    if ("strokes" in node) {
      const stroke = node.strokes.find((p) => p.visible !== false)
      props.borderEnabled = !!stroke
      props.borderColor = stroke?.type === "SOLID" ? hex(stroke.color) : "#000000"
      props.borderOpacity = stroke?.type === "SOLID" ? Math.round((stroke.opacity ?? 1) * 100) : 100
      props.borderWidth = typeof node.strokeWeight === "number" ? node.strokeWeight : 0
      props.borderPosition =
        node.strokeAlign === "OUTSIDE"
          ? "OUTSIDE"
          : node.strokeAlign === "CENTER"
            ? "CENTER"
            : "INSIDE"
    }
    if ("cornerRadius" in node) {
      const n = node as RectangleNode
      props.useIndividualCorners = true
      props.radiusTopLeft =
        typeof node.cornerRadius === "number" ? node.cornerRadius : n.topLeftRadius
      props.radiusTopRight =
        typeof node.cornerRadius === "number" ? node.cornerRadius : n.topRightRadius
      props.radiusBottomLeft =
        typeof node.cornerRadius === "number" ? node.cornerRadius : n.bottomLeftRadius
      props.radiusBottomRight =
        typeof node.cornerRadius === "number" ? node.cornerRadius : n.bottomRightRadius
    }
    if ("effects" in node) {
      const shadow = node.effects.find(
        (e): e is DropShadowEffect => e.visible !== false && e.type === "DROP_SHADOW",
      )
      props.shadowEnabled = !!shadow
      if (shadow) {
        props.shadowColor = hex(shadow.color)
        props.shadowOpacity = Math.round(shadow.color.a * 100)
        props.shadowOffsetX = shadow.offset.x
        props.shadowOffsetY = shadow.offset.y
        props.shadowBlur = shadow.radius
      }
    }
  }
  function reactions(node: SceneNode): DesignReaction[] {
    if (!("reactions" in node)) return []
    const results: DesignReaction[] = []
    for (const [ri, reaction] of node.reactions.entries()) {
      const trigger = reaction.trigger
      if (!trigger) continue
      const mapping: Record<string, string> = {
        ON_CLICK: "tap",
        ON_HOVER: "mouseover",
        ON_PRESS: "touchdown",
        MOUSE_ENTER: "mouseover",
        MOUSE_LEAVE: "mouseout",
        MOUSE_DOWN: "touchdown",
        MOUSE_UP: "touchup",
        AFTER_TIMEOUT: "start",
        ON_KEY_DOWN: "press",
      }
      const type = mapping[trigger.type]
      if (!type) {
        note(node, `prototype trigger ${trigger.type} has no supported one-shot mapping`)
        continue
      }
      const triggerProps: Properties = {}
      if (trigger.type === "ON_KEY_DOWN") {
        if (trigger.keyCodes.length !== 1) {
          note(node, "multi-key prototype shortcuts are unsupported")
          continue
        }
        const code = trigger.keyCodes[0]
        const keys: Record<number, string> = {
          13: "ENTER",
          27: "ESC",
          32: "SPACE",
          37: "LEFT",
          38: "UP",
          39: "RIGHT",
          40: "DOWN",
        }
        triggerProps.key = keys[code] ?? String.fromCharCode(code)
      }
      const actions = reaction.actions ?? (reaction.action ? [reaction.action] : [])
      for (const [ai, action] of actions.entries()) {
        const key = `${node.id}:${ri}:${ai}`
        const props: Properties = {
          delay:
            trigger.type === "AFTER_TIMEOUT"
              ? trigger.timeout
              : "delay" in trigger
                ? trigger.delay
                : 0,
        }
        if (action.type === "NODE" && action.navigation === "NAVIGATE" && action.destinationId) {
          const t = action.transition
          const direction =
            t && "direction" in t
              ? { TOP: "UP", BOTTOM: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" }[t.direction]
              : "LEFT"
          props.transition = !t
            ? "NONE"
            : t.type === "SMART_ANIMATE" || ("matchLayers" in t && t.matchLayers)
              ? "SMART"
              : t.type === "DISSOLVE"
                ? "FADE"
                : `${t.type === "SLIDE_OUT" || t.type === "MOVE_OUT" ? "SLIDEOUT" : "SLIDE"}_${direction}`
          props.duration = t?.duration ?? 0
          const easing = t?.easing.type
          const curves: Record<string, number[]> = {
            EASE_IN: [0.42, 0, 1, 1],
            EASE_OUT: [0, 0, 0.58, 1],
            EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
          }
          const custom = t?.easing.easingFunctionCubicBezier
          const curve = custom
            ? [custom.x1, custom.y1, custom.x2, custom.y2]
            : easing
              ? curves[easing]
              : undefined
          props.easingFunction =
            easing === "LINEAR" || !t ? "LINEAR" : curve ? "CUBIC_BEZIER" : "EASE_IN_OUT_CUBIC"
          if (curve)
            Object.assign(props, {
              cubicBezierX1: curve[0],
              cubicBezierY1: curve[1],
              cubicBezierX2: curve[2],
              cubicBezierY2: curve[3],
            })
          if (easing && easing !== "LINEAR" && !curve)
            note(node, `prototype easing ${easing} uses the closest supported cubic easing`)
          results.push({
            key,
            trigger: type,
            triggerProps,
            action: "navigate",
            destination: action.destinationId,
            props,
          })
        } else if (action.type === "URL") {
          results.push({
            key,
            trigger: type,
            triggerProps,
            action: "url",
            props: { ...props, url: action.url },
          })
        } else if (
          action.type === "NODE" &&
          action.navigation === "SCROLL_TO" &&
          action.destinationId
        ) {
          results.push({
            key,
            trigger: type,
            triggerProps,
            action: "scroll",
            destination: action.destinationId,
            props,
          })
        } else if (
          action.type === "SET_VARIABLE" &&
          action.variableId &&
          action.variableValue?.value !== undefined
        ) {
          const value = action.variableValue.value
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            results.push({
              key,
              trigger: type,
              triggerProps,
              action: "variable",
              destination: action.variableId,
              props: { ...props, value: typeof value === "boolean" ? Number(value) : value },
            })
          else
            note(
              node,
              "variable expressions and aliases in prototype actions are not yet supported",
            )
        } else
          note(
            node,
            `prototype action ${action.type}${action.type === "NODE" ? `/${action.navigation}` : ""} is unsupported and was not approximated`,
          )
      }
    }
    return results
  }
  async function read(node: SceneNode): Promise<DesignNode> {
    try {
      return await readNode(node)
    } catch (error) {
      if (error instanceof ReadDesignError) throw error
      throw readFailure(node, error)
    }
  }
  async function readNode(node: SceneNode): Promise<DesignNode> {
    onProgress(++count)
    const props = geometry(node, options.liveAutoLayout)
    const fills =
      "fills" in node && node.fills !== api.mixed
        ? node.fills.filter((p) => p.visible !== false)
        : []
    const effects = "effects" in node ? node.effects.filter((e) => e.visible !== false) : []
    const strokes = "strokes" in node ? node.strokes.filter((p) => p.visible !== false) : []
    if (
      strokes.length > 1 ||
      strokes.some((p) => p.type !== "SOLID") ||
      (strokes.length && "strokeWeight" in node && node.strokeWeight === api.mixed) ||
      (strokes.length && "dashPattern" in node && node.dashPattern.length > 0) ||
      ("cornerSmoothing" in node && node.cornerSmoothing > 0) ||
      (node.type === "ELLIPSE" &&
        (node.arcData.innerRadius > 0 ||
          Math.abs(node.arcData.endingAngle - node.arcData.startingAngle - Math.PI * 2) > 0.001)) ||
      effects.some((e) => e.type === "DROP_SHADOW" && (e.spread ?? 0) !== 0)
    )
      return flattened(node, "unsupported stroke, corner, arc, or shadow geometry")
    if (
      fills.length === 1 &&
      fills[0].type === "IMAGE" &&
      fills[0].imageHash &&
      ["FILL", "FIT", "STRETCH"].includes(fills[0].scaleMode) &&
      node.type === "RECTANGLE" &&
      !effects.length &&
      !("strokes" in node && node.strokes.some((s) => s.visible !== false))
    ) {
      const image = api.getImageByHash(fills[0].imageHash)
      if (image) {
        let pending = rasterCache.get(fills[0].imageHash)
        if (!pending) {
          pending = (async () => {
            const bytes = await exportArtwork(() => image.getBytesAsync()),
              data = base64(bytes),
              key = digest(data)
            const mimeType =
              bytes[0] === 0xff && bytes[1] === 0xd8
                ? "image/jpeg"
                : bytes[0] === 0x52 && bytes[8] === 0x57
                  ? "image/webp"
                  : "image/png"
            return { key, mimeType, data } as Design["assets"][number]
          })()
          rasterCache.set(fills[0].imageHash, pending)
        }
        const asset = await pending
        assets.set(asset.key, asset)
        style(node, props)
        delete props.fillEnabled
        delete props.fillColor
        delete props.fillOpacity
        props.opacity = Math.round(Number(props.opacity) * (fills[0].opacity ?? 1))
        props.fillScaleMode = fills[0].scaleMode
        return {
          id: node.id,
          type: "IMAGE",
          props,
          children: [],
          asset: asset.key,
          reactions: reactions(node),
        }
      }
    }
    if (
      fills.some((p) => p.type !== "SOLID") ||
      fills.length > 1 ||
      effects.some((e) => e.type !== "DROP_SHADOW") ||
      effects.length > 1 ||
      ("blendMode" in node && !["NORMAL", "PASS_THROUGH"].includes(node.blendMode)) ||
      ("children" in node && node.children.some((c) => "isMask" in c && c.isMask))
    ) {
      return flattened(node, "complex paint, effect, blend, or mask")
    }
    style(node, props)
    if (node.type === "RECTANGLE" || node.type === "ELLIPSE")
      return {
        id: node.id,
        type: node.type === "RECTANGLE" ? "RECT" : "OVAL",
        props,
        children: [],
        reactions: reactions(node),
      }
    if (node.type === "TEXT") {
      if (
        node.fontName === api.mixed ||
        node.fontSize === api.mixed ||
        node.fills === api.mixed ||
        node.letterSpacing === api.mixed ||
        node.lineHeight === api.mixed
      )
        return flattened(node, "mixed text styling")
      if (
        ("textDecoration" in node && node.textDecoration !== "NONE") ||
        ("textCase" in node && node.textCase !== "ORIGINAL")
      )
        return flattened(node, "text decoration or transformed case")
      props.text = node.characters
      props.fontSize = node.fontSize
      props.fillEnabled = false
      props.font = `${node.fontName.family}-${node.fontName.style.replace(/\s+/g, "")}`
      props.textColor = fills[0]?.type === "SOLID" ? hex(fills[0].color) : "#000000"
      props.textOpacity =
        fills[0]?.type === "SOLID" ? Math.round((fills[0].opacity ?? 1) * 100) : 100
      props.textAlign =
        node.textAlignHorizontal === "JUSTIFIED" ? "JUSTIFY" : node.textAlignHorizontal
      props.verticalAlign = node.textAlignVertical === "CENTER" ? "MIDDLE" : node.textAlignVertical
      props.sizeMode = !options.liveAutoLayout
        ? "FIXED_SIZE"
        : node.textAutoResize === "WIDTH_AND_HEIGHT"
          ? "AUTO_WIDTH"
          : node.textAutoResize === "HEIGHT"
            ? "AUTO_HEIGHT"
            : "FIXED_SIZE"
      props.letterSpacing =
        node.letterSpacing.unit === "PIXELS"
          ? (node.letterSpacing.value / node.fontSize) * 100
          : node.letterSpacing.value
      props.autoLineHeight = node.lineHeight.unit === "AUTO"
      if (node.lineHeight.unit !== "AUTO")
        props.lineHeight =
          node.lineHeight.unit === "PIXELS"
            ? node.lineHeight.value / node.fontSize
            : node.lineHeight.value / 100
      if (clipsText(node)) {
        clippedTexts++
        clippedSources.add(node.id.split(";").pop()!)
        return {
          id: node.id,
          type: "CONTAINER",
          props: {
            ...geometry(node, options.liveAutoLayout),
            name: `${node.name} (text clip)`,
            fillEnabled: false,
            borderEnabled: false,
            shadowEnabled: false,
            clipChildren: true,
            layoutMode: "HORIZONTAL",
            layoutWrap: "NO_WRAP",
            primaryAxisSizingMode: "FIXED",
            counterAxisSizingMode: "FIXED",
            primaryAxisAlignItems:
              node.textAlignHorizontal === "CENTER"
                ? "CENTER"
                : node.textAlignHorizontal === "RIGHT"
                  ? "MAX"
                  : "MIN",
            counterAxisAlignItems:
              node.textAlignVertical === "CENTER"
                ? "CENTER"
                : node.textAlignVertical === "BOTTOM"
                  ? "MAX"
                  : "MIN",
            itemSpacing: 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            layoutSizingVertical:
              options.liveAutoLayout && props.layoutSizingVertical === "FILL" ? "FILL" : "FIXED",
          },
          children: [
            {
              id: `${node.id}:text-content`,
              type: "TEXT",
              props: {
                ...props,
                x: 0,
                y: 0,
                rotation: 0,
                opacity: 100,
                invisible: false,
                sizeMode: "AUTO_WIDTH",
                layoutPositioning: "AUTO",
                layoutGrow: 0,
                layoutSizingHorizontal: "HUG",
                layoutSizingVertical: "HUG",
                fixLeft: false,
                fixRight: false,
                fixTop: false,
                fixBottom: false,
              },
              children: [],
            },
          ],
          reactions: reactions(node),
        }
      }
      return { id: node.id, type: "TEXT", props, children: [], reactions: reactions(node) }
    }
    if (node.type === "INSTANCE" || node.type === "COMPONENT") {
      if (options.createComponents === false) return readContainer(node)
      if (node.type === "INSTANCE") {
        const fields = new Set(
          node.overrides
            .filter((o) => o.id !== node.id)
            .flatMap((o) => o.overriddenFields)
            .filter((field) => !["characters", "name", "styledTextSegments"].includes(field)),
        )
        if (fields.size) {
          note(
            node,
            `overrides for ${[...fields].join(", ")}; imported the resolved instance as editable layers instead of a shared master`,
          )
          return readContainer(node)
        }
      }
      const main = node.type === "COMPONENT" ? node : await node.getMainComponentAsync()
      if (!main) return flattened(node, "unresolved component master")
      if (node.type === "INSTANCE" && hiddenInDocument(main))
        return flattened(node, "hidden component master; exporting the visible instance")
      if (resolving.has(main.id)) throw new Error(`Circular component dependency: ${main.name}`)
      let resolvedReason: string | undefined
      const overrides: NonNullable<DesignNode["overrides"]> = []
      async function compare(instance: SceneNode, source: SceneNode, instancePath: string[] = []) {
        const sourceId = source.id.split(";").pop()!
        if (
          instance.visible !== source.visible ||
          Math.abs(instance.width - source.width) > 0.01 ||
          Math.abs(instance.height - source.height) > 0.01 ||
          (instance !== node &&
            (Math.abs(instance.x - source.x) > 0.01 || Math.abs(instance.y - source.y) > 0.01))
        )
          resolvedReason = "instance visibility or resolved geometry differs from its master"
        if (instance.type === "TEXT" && source.type === "TEXT") {
          const styles = [
            "fontName",
            "fontSize",
            "fills",
            "letterSpacing",
            "lineHeight",
            "textDecoration",
            "textCase",
            "textAlignHorizontal",
            "textAlignVertical",
            "textAutoResize",
            "textTruncation",
            "maxLines",
          ] as const
          if (styles.some((key) => JSON.stringify(instance[key]) !== JSON.stringify(source[key])))
            resolvedReason = `text styling differs on ${instance.name}`
        }
        if (
          instance.type === "TEXT" &&
          source.type === "TEXT" &&
          instance.characters !== source.characters
        ) {
          if (
            source.fontName === api.mixed ||
            source.fontSize === api.mixed ||
            source.fills === api.mixed ||
            source.letterSpacing === api.mixed ||
            source.lineHeight === api.mixed
          )
            resolvedReason = "overridden mixed text requires the resolved artwork"
          overrides.push({ sourceId, instancePath, props: { text: instance.characters } })
        }
        if ("children" in instance && "children" in source) {
          if (instance.children.length !== source.children.length) {
            resolvedReason = "instance structure differs from its master"
            return
          }
          const nextPath = source.type === "INSTANCE" ? [...instancePath, sourceId] : instancePath
          const sources = new Map(
            source.children.map((child) => [child.id.split(";").pop()!, child]),
          )
          for (const child of instance.children) {
            const original = sources.get(child.id.split(";").pop()!)
            if (!original) {
              resolvedReason = "instance contains swapped children"
              return
            }
            await compare(child, original, nextPath)
          }
        }
      }
      await compare(node, main)
      if (node.type === "INSTANCE" && resolvedReason) {
        note(
          node,
          `${resolvedReason}; imported the resolved instance as editable layers instead of a shared master`,
        )
        return readContainer(node)
      }
      if (!components.has(main.id)) {
        resolving.add(main.id)
        const root = await readContainer(main)
        root.props.x = 0
        root.props.y = 0
        components.set(main.id, { id: main.id, name: main.name, root })
        resolving.delete(main.id)
      }
      return {
        id: node.id,
        type: "COMPONENT_INSTANCE",
        props,
        component: main.id,
        overrides: overrides.map((override) => ({
          ...override,
          sourceId: clippedSources.has(override.sourceId)
            ? `${override.sourceId}:text-content`
            : override.sourceId,
        })),
        children: [],
        reactions:
          node.type === "COMPONENT" ||
          JSON.stringify(node.reactions) === JSON.stringify(main.reactions)
            ? []
            : reactions(node),
      }
    }
    if ("children" in node) return readContainer(node)
    return flattened(node, `vector or unsupported primitive ${node.type}`)
  }
  async function readContainer(node: SceneNode & ChildrenMixin): Promise<DesignNode> {
    const props = geometry(node, options.liveAutoLayout)
    style(node, props)
    props.layoutMode = "NONE"
    props.clipChildren = "clipsContent" in node ? node.clipsContent : false
    if ("layoutMode" in node && node.layoutMode !== "NONE") resolvedLayouts++
    if (
      options.liveAutoLayout &&
      "layoutMode" in node &&
      node.layoutMode !== "NONE" &&
      node.layoutMode !== "GRID"
    ) {
      const a = node as FrameNode
      Object.assign(props, {
        layoutMode: a.layoutMode,
        layoutWrap: a.layoutWrap,
        primaryAxisSizingMode: a.primaryAxisSizingMode,
        counterAxisSizingMode: a.counterAxisSizingMode,
        primaryAxisAlignItems: a.primaryAxisAlignItems,
        counterAxisAlignItems: a.counterAxisAlignItems,
        counterAxisAlignContent: a.counterAxisAlignContent,
        strokesIncludedInLayout: a.strokesIncludedInLayout,
        itemSpacing: a.itemSpacing,
        counterAxisSpacing: a.counterAxisSpacing ?? 0,
        paddingLeft: a.paddingLeft,
        paddingRight: a.paddingRight,
        paddingTop: a.paddingTop,
        paddingBottom: a.paddingBottom,
      })
    }
    if ("layoutMode" in node && node.layoutMode === "GRID")
      note(
        node,
        "grid layout uses its resolved child positions; native grid rules are not preserved",
      )
    if ("overflowDirection" in node && node.overflowDirection !== "NONE") {
      if (node.overflowDirection === "BOTH")
        note(
          node,
          "two-axis scrolling uses vertical scrolling; horizontal scrolling must be configured in Studio",
        )
      props.scrollType = "SCROLL"
      props.scrollDirection = node.overflowDirection === "HORIZONTAL" ? "HORIZONTAL" : "VERTICAL"
    }
    const children: DesignNode[] = []
    const visible = node.children.filter((child) => child.visible !== false)
    if (options.createComponents === false) {
      // No master resolution can race in this mode. Keep source order while overlapping exports.
      const results = await Promise.allSettled(visible.map(read))
      for (const result of results) {
        if (result.status === "rejected") throw result.reason
        children.push(result.value)
      }
    } else for (const child of visible) children.push(await read(child))
    return { id: node.id, type: "CONTAINER", props, children, reactions: reactions(node) }
  }
  const selected = new Set(selection.map((n) => n.id))
  async function select(node: SceneNode): Promise<void> {
    let ancestor = node.parent
    while (ancestor && ancestor.type !== "PAGE") {
      if (selected.has(ancestor.id)) return
      ancestor = ancestor.parent
    }
    if (node.type === "SECTION" || node.type === "COMPONENT_SET") {
      for (const child of node.children) await selectUnit(child)
      return
    }
    await selectUnit(node)
  }
  async function selectUnit(node: SceneNode): Promise<void> {
    if (node.type === "SECTION" || node.type === "COMPONENT_SET") {
      for (const c of node.children) await selectUnit(c)
      return
    }
    let parent = node.parent,
      promoted = node
    while (parent && parent.type !== "PAGE") {
      if (parent.type === "INSTANCE") promoted = parent
      parent = parent.parent
    }
    node = promoted
    if (design.units.some((u) => u.id === node.id)) return
    const scene = node.type === "FRAME"
    const root = await read(node)
    if (scene) {
      root.props.x = 0
      root.props.y = 0
      root.props.rotation = 0
    }
    const unit: DesignUnit = {
      id: node.id,
      scene,
      parent: scene ? undefined : node.parent?.id,
      root,
    }
    design.units.push(unit)
  }
  for (const node of selection) await select(node)
  if (clippedTexts)
    design.notes.push(
      `${clippedTexts} single-line truncated text layers use clipping containers. Full text stays editable; ellipses are not added.`,
    )
  if (resolvedLayouts && !options.liveAutoLayout)
    design.notes.push(
      `${resolvedLayouts} auto-layout containers use resolved Figma positions and fixed sizes. Live auto layout is disabled.`,
    )
  design.components = [...components.values()]
  design.assets = [...assets.values()].sort((a, b) => a.key.localeCompare(b.key))
  // Values use the active variable mode for the selected file; unresolved aliases are reported.
  try {
    const variables = await api.variables.getLocalVariablesAsync()
    const byId = new Map(variables.map((v) => [v.id, v]))
    const modeCache = new Map<string, string | undefined>()
    async function modeFor(collectionId: string) {
      if (!modeCache.has(collectionId)) {
        const collection = await api.variables.getVariableCollectionByIdAsync(collectionId)
        modeCache.set(
          collectionId,
          selection[0]?.resolvedVariableModes?.[collectionId] ?? collection?.defaultModeId,
        )
      }
      return modeCache.get(collectionId)
    }
    for (const variable of variables) {
      const mode = await modeFor(variable.variableCollectionId)
      if (!mode) continue
      let value = variable.valuesByMode[mode] ?? Object.values(variable.valuesByMode)[0]
      const seen = new Set([variable.id])
      while (typeof value === "object" && "type" in value && value.type === "VARIABLE_ALIAS") {
        if (seen.has(value.id)) throw new Error(`Circular variable alias ${variable.name}`)
        seen.add(value.id)
        const target = byId.get(value.id) ?? (await api.variables.getVariableByIdAsync(value.id))
        if (!target) throw new Error(`Unresolved variable alias ${variable.name}`)
        const targetMode = await modeFor(target.variableCollectionId)
        value =
          (targetMode && target.valuesByMode[targetMode]) ?? Object.values(target.valuesByMode)[0]
      }
      if (value === undefined) continue
      const name = `F2P_${variable.name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 50)}_${digest(variable.id).slice(0, 8)}`
      design.variables.push({
        id: variable.id,
        name,
        dataType:
          variable.resolvedType === "COLOR"
            ? "COLOR"
            : variable.resolvedType === "STRING"
              ? "STRING"
              : "NUMBER",
        value:
          typeof value === "boolean"
            ? Number(value)
            : typeof value === "object"
              ? hex(value as RGB)
              : value,
      })
    }
  } catch (error) {
    design.notes.push(`Variables: ${error instanceof Error ? error.message : String(error)}`)
  }
  return design
}
