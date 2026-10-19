import { decode } from "fast-png"

const cache = new Map<string, ReturnType<typeof decode>>()
function pixels(base64: string) {
  const hit = cache.get(base64)
  if (hit) return hit
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const image = decode(bytes, { checkCrc: true })
  if (image.depth !== 8 || image.palette || ![1, 2, 3, 4].includes(image.channels))
    throw new Error("Unsupported Studio preview pixel format")
  if (cache.size >= 4) cache.delete(cache.keys().next().value!)
  cache.set(base64, image)
  return image
}

export function visualSignature(images: string[]): string[] {
  images.forEach(pixels)
  return images
}

export function sameFingerprint(a: string, b: string): boolean {
  if (a === b) return true
  const left = a.split(":"),
    right = b.split(":")
  if (left[0] !== "pixels2" || right[0] !== "pixels2" || left[1] !== right[1]) return false
  const x = left[2].split("."),
    y = right[2].split(".")
  if (x.length !== y.length) return false
  for (let image = 0; image < x.length; image++) {
    if (x[image] === y[image]) continue
    const one = pixels(x[image]),
      two = pixels(y[image])
    if (one.width !== two.width || one.height !== two.height) return false
    for (let p = 0; p < one.width * one.height; p++) {
      const i = p * one.channels,
        j = p * two.channels
      const alphaA = one.channels % 2 === 0 ? one.data[i + one.channels - 1] / 255 : 1
      const alphaB = two.channels % 2 === 0 ? two.data[j + two.channels - 1] / 255 : 1
      for (let c = 0; c < 3; c++) {
        const first = one.data[i + (one.channels < 3 ? 0 : c)] * alphaA + 255 * (1 - alphaA)
        const second = two.data[j + (two.channels < 3 ? 0 : c)] * alphaB + 255 * (1 - alphaB)
        // Ignore only two levels of renderer noise; retain full pixel and color resolution.
        if (Math.abs(first - second) > 2) return false
      }
    }
  }
  return true
}

export function fingerprintDifference(a: string, b: string) {
  if (sameFingerprint(a, b)) return { kind: "same" }
  const left = a.split(":"),
    right = b.split(":")
  if (left[0] !== "pixels2" || right[0] !== "pixels2" || left[1] !== right[1])
    return { kind: "structure-or-interactions" }
  const x = left[2].split("."),
    y = right[2].split(".")
  if (x.length !== y.length) return { kind: "image-count" }
  let changedPixels = 0,
    totalPixels = 0,
    maxChannelDifference = 0
  for (let image = 0; image < x.length; image++) {
    const one = pixels(x[image]),
      two = pixels(y[image])
    if (one.width !== two.width || one.height !== two.height) return { kind: "image-dimensions" }
    totalPixels += one.width * one.height
    for (let p = 0; p < one.width * one.height; p++) {
      let changed = false
      const i = p * one.channels,
        j = p * two.channels
      const alphaA = one.channels % 2 === 0 ? one.data[i + one.channels - 1] / 255 : 1
      const alphaB = two.channels % 2 === 0 ? two.data[j + two.channels - 1] / 255 : 1
      for (let c = 0; c < 3; c++) {
        const first = one.data[i + (one.channels < 3 ? 0 : c)] * alphaA + 255 * (1 - alphaA)
        const second = two.data[j + (two.channels < 3 ? 0 : c)] * alphaB + 255 * (1 - alphaB)
        const difference = Math.abs(first - second)
        maxChannelDifference = Math.max(maxChannelDifference, difference)
        changed ||= difference > 2
      }
      if (changed) changedPixels++
    }
  }
  return { kind: "preview-pixels", changedPixels, totalPixels, maxChannelDifference }
}
