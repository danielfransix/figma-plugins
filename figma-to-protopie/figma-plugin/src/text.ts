/// <reference types="@figma/plugin-typings" />
import { type DesignNode, type Properties } from "./design"

export const TEXT_STYLE_FIELDS = [
  "fontName",
  "fontWeight",
  "fontSize",
  "fills",
  "letterSpacing",
  "lineHeight",
  "textCase",
  "textDecoration",
] as const
type TextRun = Pick<
  StyledTextSegment,
  (typeof TEXT_STYLE_FIELDS)[number] | "characters" | "start" | "end"
>

export function hasMixedTextStyle(node: TextNode, api: PluginAPI): boolean {
  return TEXT_STYLE_FIELDS.some((key) => node[key] === api.mixed)
}
export function displayText(text: string, textCase: TextNode["textCase"]): string {
  if (["UPPER", "SMALL_CAPS", "SMALL_CAPS_FORCED"].includes(String(textCase)))
    return text.toUpperCase()
  if (textCase === "LOWER") return text.toLowerCase()
  if (textCase === "TITLE")
    return text.replace(
      /(^|[^\p{L}\p{N}])(\p{L})/gu,
      (_, prefix, letter) => prefix + letter.toUpperCase(),
    )
  return text
}

export function nativeText(
  node: TextNode,
  api: PluginAPI,
  geometry: Properties,
  clip: boolean,
  liveAutoLayout: boolean,
  note: (message: string) => void,
): DesignNode {
  if (!node.characters.length)
    return {
      id: node.id,
      type: "CONTAINER",
      props: {
        ...geometry,
        invisible: true,
        fillEnabled: false,
        borderEnabled: false,
        shadowEnabled: false,
        layoutMode: "NONE",
      },
      children: [],
    }
  const notes = new Set<string>()
  const mixed = hasMixedTextStyle(node, api)
  if (mixed && typeof node.getStyledTextSegments !== "function")
    throw new Error(
      "Figma did not provide the styled text runs. Text was not converted to an image.",
    )
  const runs: TextRun[] = mixed
    ? node.getStyledTextSegments([...TEXT_STYLE_FIELDS])
    : [
        {
          characters: node.characters,
          start: 0,
          end: node.characters.length,
          fontName: node.fontName as FontName,
          fontWeight: node.fontWeight as number,
          fontSize: node.fontSize as number,
          fills: node.fills as Paint[],
          letterSpacing: node.letterSpacing as LetterSpacing,
          lineHeight: node.lineHeight as LineHeight,
          textCase: node.textCase as TextCase,
          textDecoration: node.textDecoration as TextDecoration,
        },
      ]
  let end = 0
  for (const run of runs) {
    if (
      run.start !== end ||
      run.end <= run.start ||
      run.characters !== node.characters.slice(run.start, run.end)
    )
      throw new Error(
        "Figma returned incomplete styled text runs. Text was not converted to an image.",
      )
    end = run.end
  }
  if (end !== node.characters.length)
    throw new Error(
      "Figma returned incomplete styled text runs. Text was not converted to an image.",
    )
  const textProps = (run: TextRun): Properties => {
    if (!run.fontName?.family || !Number.isFinite(run.fontSize) || run.fontSize <= 0)
      throw new Error("Figma did not provide a usable font for editable text.")
    const fills = (run.fills ?? []).filter((paint) => paint.visible !== false)
    let color = "#000000",
      opacity = fills.length ? 100 : 0
    const paint = fills[0]
    const hex = (color: RGB) =>
      "#" +
      [color.r, color.g, color.b]
        .map((n) =>
          Math.round(Math.max(0, Math.min(1, n)) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
        .toUpperCase()
    if (paint?.type === "SOLID") {
      color = hex(paint.color)
      opacity = Math.round((paint.opacity ?? 1) * 100)
    } else if (paint && "gradientStops" in paint && paint.gradientStops.length) {
      color = hex(paint.gradientStops[0].color)
      opacity = Math.round((paint.opacity ?? 1) * paint.gradientStops[0].color.a * 100)
      notes.add("gradient text uses its first gradient color; text stays editable")
    } else if (paint) notes.add("unsupported text paint uses a solid color; text stays editable")
    if (fills.length > 1)
      notes.add("multiple text paints use the first visible paint; text stays editable")
    if (run.textDecoration && run.textDecoration !== "NONE")
      notes.add(
        "text decoration is not supported by the Studio text API; editable text was kept without the decoration",
      )
    if (["SMALL_CAPS", "SMALL_CAPS_FORCED"].includes(String(run.textCase)))
      notes.add("small caps use full-size capitals; text stays editable")
    const spacing = run.letterSpacing ?? { unit: "PIXELS", value: 0 }
    const line = run.lineHeight ?? { unit: "AUTO" }
    const props: Properties = {
      text: displayText(run.characters, run.textCase),
      fontSize: run.fontSize,
      font: `${run.fontName.family}-${run.fontName.style.replace(/\s+/g, "")}`,
      fillEnabled: false,
      textColor: color,
      textOpacity: opacity,
      textAlign: node.textAlignHorizontal === "JUSTIFIED" ? "LEFT" : node.textAlignHorizontal,
      verticalAlign: node.textAlignVertical === "CENTER" ? "MIDDLE" : node.textAlignVertical,
      letterSpacing:
        spacing.unit === "PIXELS" ? (spacing.value / run.fontSize) * 100 : spacing.value,
      autoLineHeight: line.unit === "AUTO",
    }
    if (line.unit !== "AUTO")
      props.lineHeight = line.unit === "PIXELS" ? line.value / run.fontSize : line.value / 100
    return props
  }
  const styles = runs.map(textProps)
  const fonts = runs.map((run) => ({
    family: run.fontName.family,
    style: run.fontName.style,
    ...(Number.isFinite(run.fontWeight) ? { weight: run.fontWeight } : {}),
    ...(run.fontName.variationSettings
      ? { variationSettings: { ...run.fontName.variationSettings } }
      : {}),
  }))
  if (node.textAlignHorizontal === "JUSTIFIED")
    notes.add("justified text uses left alignment; text stays editable")
  if (
    node.effects?.some(
      (effect) =>
        effect.visible !== false && (effect.type !== "DROP_SHADOW" || (effect.spread ?? 0) !== 0),
    ) ||
    node.effects?.filter((effect) => effect.visible !== false).length > 1
  )
    notes.add("unsupported text effects were simplified; text stays editable")
  if (node.strokes?.some((paint) => paint.visible !== false))
    notes.add("text outlines are not supported by the Studio text API; text stays editable")
  const lineHeight = Math.max(
    ...styles.map((p) => Number(p.fontSize) * (Number(p.lineHeight) || 1.5)),
  )
  const singleLine =
    !/[\r\n\u2028\u2029]/.test(node.characters) &&
    (clip || node.textAutoResize === "WIDTH_AND_HEIGHT" || node.height <= lineHeight + 0.5)
  const segmented = runs.length > 1 && singleLine
  if (runs.length > 1 && !segmented)
    notes.add(
      "mixed styling in multi-line text uses the first run's style; full text and wrapping stay editable",
    )
  for (const message of notes) note(message)
  const props: Properties = {
    ...geometry,
    ...styles[0],
    text: runs.map((run) => displayText(run.characters, run.textCase)).join(""),
    sizeMode: !liveAutoLayout
      ? "FIXED_SIZE"
      : node.textAutoResize === "WIDTH_AND_HEIGHT"
        ? "AUTO_WIDTH"
        : node.textAutoResize === "HEIGHT"
          ? "AUTO_HEIGHT"
          : "FIXED_SIZE",
    borderEnabled: false,
  }
  if (!clip && !segmented) return { id: node.id, type: "TEXT", props, font: fonts[0], children: [] }
  const childStyles = segmented ? styles : [{ ...styles[0], text: props.text }]
  return {
    id: node.id,
    type: "CONTAINER",
    props: {
      ...geometry,
      name: clip ? `${node.name} (text clip)` : node.name,
      fillEnabled: false,
      borderEnabled: false,
      shadowEnabled: false,
      clipChildren: clip,
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
        liveAutoLayout && geometry.layoutSizingVertical === "FILL" ? "FILL" : "FIXED",
    },
    children: childStyles.map((style, index) => {
      const inner: Properties = {
        ...props,
        ...style,
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
      }
      delete inner.width
      delete inner.height
      return {
        id: segmented ? `${node.id}:text-run:${runs[index].start}` : `${node.id}:text-content`,
        type: "TEXT",
        font: fonts[segmented ? index : 0],
        props: inner,
        children: [],
      }
    }),
  }
}
