import { test } from "node:test"
import assert from "node:assert/strict"
import { encode } from "fast-png"
import { fingerprintDifference, visualSignature, sameFingerprint } from "./.compiled/visual.mjs"

const signature = (data, text) =>
  `pixels2:tree:${visualSignature([Buffer.from(encode({ width: 2, height: 1, channels: 4, data: new Uint8Array(data), text })).toString("base64")]).join(".")}`
test("pixel baselines ignore PNG metadata and minute rasterization noise but detect visible and structural changes", () => {
  const pixels = [62, 62, 62, 255, 100, 150, 200, 255]
  const a = signature(pixels, { label: "one" }),
    b = signature(pixels, { label: "two" })
  assert.equal(sameFingerprint(a, b), true)
  const noisy = [...pixels]
  noisy[0]++
  assert.equal(sameFingerprint(a, signature(noisy)), true)
  const changed = [...pixels]
  changed[0] += 10
  assert.equal(sameFingerprint(a, signature(changed)), false)
  assert.equal(sameFingerprint(a, a.replace(":tree:", ":edited:")), false)
})

test("distributed one-level noise does not invalidate a large pixel baseline", () => {
  const data = Uint8Array.from({ length: 256 * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : Math.floor(i / 4),
  )
  const noisy = data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + 1)))
  const make = (bytes) =>
    "pixels2:tree:" +
    visualSignature([
      Buffer.from(encode({ width: 256, height: 1, channels: 4, data: bytes })).toString("base64"),
    ]).join(".")
  assert.equal(sameFingerprint(make(data), make(noisy)), true)
})

test("verification evidence separates structural changes from preview-pixel differences", () => {
  const signature = (red) =>
    "pixels2:tree:" +
    Buffer.from(
      encode({ width: 1, height: 1, channels: 4, data: new Uint8Array([red, 0, 0, 255]) }),
    ).toString("base64")
  const result = fingerprintDifference(signature(0), signature(255))
  assert.equal(result.kind, "preview-pixels")
  assert.equal(result.changedPixels, 1)
  assert.equal(result.maxChannelDifference, 255)
  assert.equal(
    fingerprintDifference(signature(0), signature(0).replace(":tree:", ":changed:")).kind,
    "structure-or-interactions",
  )
})
