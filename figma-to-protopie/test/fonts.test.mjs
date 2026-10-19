import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolveFont, fontWeight } from "./.compiled/fonts.mjs"
const faces = JSON.parse(
  await readFile(new URL("./fixtures/installed-font-faces.json", import.meta.url), "utf8"),
)
const families = [...new Set(faces.map((f) => f.family))]
test("real installed face metadata resolves all weights used in the reported Figma screen", () => {
  for (const [family, style, weight, expected] of [
    ["Gilroy", "Regular", 400, "Gilroy-Regular"],
    ["Gilroy", "Semibold", 600, "Gilroy-SemiBold"],
    ["Gilroy", "Medium", 500, "Gilroy-Medium"],
    ["Gilroy", "Bold", 700, "Gilroy-Bold"],
    ["Circular Std", "Book", 450, "CircularStd-Book"],
    ["Circular Std", "Bold", 700, "CircularStd-Bold"],
  ]) {
    assert.deepEqual(
      resolveFont(`${family}-${style}`, { family, style, weight }, families, faces),
      { font: expected },
    )
  }
})
test("weight aliases and spaces resolve to verified installed identifiers instead of a guessed face", () => {
  for (const style of ["Semi Bold", "Semibold", "SemiBold", "Semi-Bold"])
    assert.equal(
      resolveFont(`Gilroy-${style}`, { family: "Gilroy", style }, families, faces).font,
      "Gilroy-SemiBold",
    )
  assert.equal(
    resolveFont(
      "Gilroy Bold-Regular",
      { family: "Gilroy Bold", style: "Regular", weight: 700 },
      families,
      faces,
    ).font,
    "Gilroy-Bold",
  )
})
test("numeric variable-font weight takes precedence over the Regular named instance", () => {
  assert.deepEqual(
    resolveFont(
      "Gilroy-Regular",
      { family: "Gilroy", style: "Regular", weight: 400, variationSettings: { wght: 700 } },
      families,
      faces,
    ),
    { font: "Gilroy-Bold" },
  )
  const approximate = resolveFont(
    "Gilroy-Regular",
    { family: "Gilroy", style: "Regular", variationSettings: { wght: 550 } },
    families,
    faces,
  )
  assert.match(approximate.note, /weight 550.*unavailable/)
})
test("italic faces stay italic even when Windows reports their style as Regular", () => {
  assert.equal(
    resolveFont(
      "Gilroy-SemiboldItalic",
      { family: "Gilroy", style: "Semibold Italic", weight: 600 },
      families,
      faces,
    ).font,
    "Gilroy-SemiBoldItalic",
  )
  assert.equal(
    resolveFont(
      "Circular Std-BoldItalic",
      { family: "Circular Std", style: "Bold Italic", weight: 700 },
      families,
      faces,
    ).font,
    "CircularStd-BoldItalic",
  )
})
test("missing weights and unsupported variable axes produce explicit substitution notes", () => {
  const onlyRegular = faces.filter((f) => f.postscriptName === "Gilroy-Regular")
  const result = resolveFont(
    "Gilroy-Semibold",
    { family: "Gilroy", style: "Semibold", weight: 600 },
    ["Gilroy"],
    onlyRegular,
  )
  assert.equal(result.font, "Gilroy-Regular")
  assert.match(result.note, /weight 600.*weight 400/)
  assert.match(
    resolveFont(
      "Gilroy-Regular",
      { family: "Gilroy", style: "Regular", variationSettings: { wdth: 90 } },
      families,
      faces,
    ).note,
    /wdth=90.*not supported/,
  )
})
test("stale cached faces absent from the connected Studio family list are not trusted", () => {
  const result = resolveFont(
    "Gilroy-Bold",
    { family: "Gilroy", style: "Bold", weight: 700 },
    ["Inter"],
    faces,
  )
  assert.equal(result.font, "SYSTEM_DEFAULT-Bold")
  assert.match(result.note, /not installed/)
})
test("family-only catalogs preserve the style and clearly report unverified weights", () => {
  const result = resolveFont(
    "Example-SemiBold",
    { family: "Example", style: "Semi Bold", weight: 600 },
    ["Example"],
  )
  assert.equal(result.font, "Example-Semi Bold")
  assert.match(result.note, /could not be verified/)
  assert.equal(
    resolveFont("Example-Regular", { family: "Example", style: "Regular", weight: 400 }, [
      "Example",
    ]).font,
    "Example-Regular",
  )
})
test("weight inference distinguishes Book, Medium, Semibold, and ExtraBold", () => {
  for (const [style, weight] of [
    ["Book", 450],
    ["Medium", 500],
    ["Semi Bold", 600],
    ["Extra Bold", 800],
  ])
    assert.equal(fontWeight({ family: "Example", style }), weight)
})
