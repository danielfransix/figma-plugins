import type { FontRequest } from "./design"

export interface InstalledFont {
  family: string
  style: string
  postscriptName: string
  weight: number
  italic: boolean
}
const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
const italicStyle = (value: string) => /italic|oblique/i.test(value)
export function fontWeight(request: FontRequest): number {
  const weight = request.variationSettings?.wght ?? request.weight
  if (typeof weight === "number" && Number.isFinite(weight) && weight > 0 && weight <= 1000)
    return weight
  const style = normalize(request.style)
  for (const [pattern, value] of [
    [/extra(?:black|heavy)|ultra(?:black|heavy)/, 950],
    [/extrabold|ultrabold/, 800],
    [/semibold|demibold/, 600],
    [/black|heavy/, 900],
    [/bold/, 700],
    [/medium/, 500],
    [/book/, 450],
    [/extralight|ultralight/, 200],
    [/thin|hairline/, 100],
    [/light/, 300],
  ] as const)
    if (pattern.test(style)) return value
  return 400
}
function requestFromName(name: string, families: readonly string[]): FontRequest {
  if (families.some((family) => normalize(family) === normalize(name)))
    return { family: name, style: "Regular" }
  const split = name.lastIndexOf("-")
  return split > 0
    ? { family: name.slice(0, split), style: name.slice(split + 1) }
    : { family: name, style: "Regular" }
}
export function resolveFont(
  original: string,
  source: FontRequest | undefined,
  families: readonly string[],
  installed: readonly InstalledFont[] = [],
): { font: string; note?: string } {
  if (!source && /^SYSTEM_DEFAULT(?:-|$)/.test(original))
    return { font: original === "SYSTEM_DEFAULT" ? "SYSTEM_DEFAULT-Regular" : original }
  const request = source ?? requestFromName(original, families)
  const family = normalize(request.family),
    style = normalize(request.style)
  const weight = fontWeight(request),
    italic = italicStyle(request.style)
  const listed = new Set(families.map(normalize))
  const candidates = installed.filter((face) => {
    if (
      !face ||
      typeof face.family !== "string" ||
      typeof face.style !== "string" ||
      typeof face.postscriptName !== "string" ||
      !Number.isFinite(face.weight)
    )
      return false
    if (
      families.length &&
      !listed.has(normalize(face.family)) &&
      !listed.has(normalize(face.postscriptName))
    )
      return false
    return (
      normalize(face.family) === family ||
      normalize(face.postscriptName.split("-")[0]) === family ||
      normalize(face.family) === normalize(request.family + " " + request.style)
    )
  })
  const score = (face: InstalledFont) =>
    ((face.italic || italicStyle(face.style + " " + face.postscriptName)) !== italic ? 1e7 : 0) +
    Math.abs(face.weight - weight) * 1000 -
    (normalize(face.postscriptName) === normalize(request.family + request.style) ? 200 : 0) -
    (normalize(face.style) === style ? 100 : 0)
  candidates.sort((a, b) => score(a) - score(b) || a.postscriptName.localeCompare(b.postscriptName))
  if (candidates.length) {
    const face = candidates[0]
    const exactWeight = face.weight === weight
    const exactItalic =
      (face.italic || italicStyle(face.style + " " + face.postscriptName)) === italic
    const axes = Object.entries(request.variationSettings ?? {}).filter(([axis]) => axis !== "wght")
    const notes: string[] = []
    if (!exactWeight || !exactItalic)
      notes.push(
        `${request.family} ${request.style} (weight ${weight}${italic ? ", italic" : ""}) is unavailable; used ${face.postscriptName} (weight ${face.weight})`,
      )
    if (axes.length)
      notes.push(
        `variable font axes ${axes.map(([axis, value]) => `${axis}=${value}`).join(", ")} are not supported by Studio; used the installed font face`,
      )
    return { font: face.postscriptName, ...(notes.length ? { note: notes.join("; ") + "." } : {}) }
  }
  const variant = families.find(
    (name) => normalize(name) === normalize(request.family + " " + request.style),
  )
  if (variant)
    return {
      font: variant,
      note: `${request.family} ${request.style}: Studio lists this family but its exact font face could not be verified. Restart the local helper if it is still running an older build.`,
    }
  const matched = families.find((name) => normalize(name) === family)
  if (matched || !families.length) {
    const namedStyle =
      normalize(request.style) === "regular" && weight !== 400
        ? weight >= 700
          ? "Bold"
          : weight >= 600
            ? "SemiBold"
            : weight >= 500
              ? "Medium"
              : "Light"
        : request.style
    const font = `${matched ?? request.family}-${namedStyle}`
    return {
      font,
      ...(weight !== 400 || italic || request.variationSettings
        ? {
            note: `${request.family} ${request.style} (weight ${weight}): the installed face could not be verified; Studio may substitute a different weight. Restart the local helper and confirm the required face is installed.`,
          }
        : {}),
    }
  }
  return {
    font: weight >= 600 ? "SYSTEM_DEFAULT-Bold" : "SYSTEM_DEFAULT-Regular",
    note: `${request.family} ${request.style} (weight ${weight}) is not installed in Studio; used its system default ${weight >= 600 ? "bold" : "regular"} font.`,
  }
}
