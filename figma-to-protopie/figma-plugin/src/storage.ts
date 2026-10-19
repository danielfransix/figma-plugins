import { applyPatch, type StatePatch } from "./checkpoint"
import { digest, emptyState, type ImportState } from "./design"
export interface PluginDataStore {
  getPluginData(key: string): string
  setPluginData(key: string, value: string): void
}
interface Manifest {
  target: string
  generation: string
  chunks: number
  baseChunks?: number
  visuals?: string[]
  parts?: string[]
  journal?: string[][]
}
const CHUNK_SIZE = 14000
function split(content: string): string[] {
  const chunks: string[] = []
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + CHUNK_SIZE, content.length)
    if (
      end < content.length &&
      content.charCodeAt(end - 1) >= 0xd800 &&
      content.charCodeAt(end - 1) <= 0xdbff
    )
      end--
    chunks.push(content.slice(start, end))
    start = end
  }
  if (chunks.length > 2000)
    throw new Error(
      "Import data exceeds this file's storage limit. Split the source into smaller files.",
    )
  return chunks
}
function readVisual(store: PluginDataStore, id: string): string {
  const count = Number(store.getPluginData(id))
  if (!Number.isInteger(count) || count < 1 || count > 2000)
    throw new Error("A visual import baseline is missing. No linked content was overwritten.")
  let content = ""
  for (let i = 0; i < count; i++) {
    const value = store.getPluginData(`${id}_${i}`)
    if (!value) throw new Error("A visual import baseline chunk is missing.")
    content += value
  }
  return content
}
export function readState(store: PluginDataStore, target: string): ImportState {
  const key = `f2p_v2_${digest(target)}`,
    raw = store.getPluginData(key)
  if (!raw) return emptyState()
  const manifest = JSON.parse(raw) as Manifest
  const chunks = manifest.baseChunks ?? manifest.chunks
  if (manifest.target !== target || !Number.isInteger(chunks) || chunks < 1 || chunks > 2000)
    throw new Error(
      "Invalid import index. Its links were preserved; use a fresh import to start over.",
    )
  if (
    manifest.parts &&
    (manifest.parts.length !== chunks ||
      manifest.parts.some((id) => typeof id !== "string" || !id.startsWith(`${key}_data_`)))
  )
    throw new Error("Invalid import chunk references. Saved links were preserved.")
  let content = ""
  for (let i = 0; i < chunks; i++) {
    const chunk = store.getPluginData(manifest.parts?.[i] ?? `${key}_${manifest.generation}_${i}`)
    if (!chunk)
      throw new Error("A saved import chunk is missing. No linked content was overwritten.")
    content += chunk
  }
  const state = JSON.parse(content)
  for (const parts of manifest.journal ?? []) {
    if (
      !Array.isArray(parts) ||
      parts.length > 2000 ||
      parts.some((id) => typeof id !== "string" || !id.startsWith(`${key}_data_`))
    )
      throw new Error("Invalid checkpoint journal")
    const content = parts
      .map((id) => {
        const value = store.getPluginData(id)
        if (!value) throw new Error("A checkpoint journal chunk is missing")
        return value
      })
      .join("")
    applyPatch(state, JSON.parse(content))
  }
  if (state?.version !== 2 || !state.scopes || !state.assets || !state.variables)
    throw new Error("Unsupported import data version")
  for (const scope of Object.values(state.scopes) as ImportState["scopes"][string][]) {
    if (typeof scope.fingerprint !== "string" || !scope.fingerprint.startsWith("pixels2:")) continue
    const parts = scope.fingerprint.split(":")
    if (parts[2] !== "refs") continue
    const images = parts[3].split(".").map((id) => {
      if (!id.startsWith(`${key}_visual_`)) throw new Error("Invalid visual baseline target")
      return readVisual(store, id)
    })
    scope.fingerprint = `pixels2:${parts[1]}:${images.join(".")}`
  }
  return state
}
export function writeState(store: PluginDataStore, target: string, state: ImportState): void {
  const key = `f2p_v2_${digest(target)}`,
    old = store.getPluginData(key)
  const visuals = new Set<string>()
  const scopes = Object.fromEntries(
    Object.entries(state.scopes).map(([name, scope]) => {
      const parts = typeof scope.fingerprint === "string" ? scope.fingerprint.split(":") : []
      if (parts[0] !== "pixels2" || !parts[2]) return [name, scope]
      const ids = parts[2].split(".").map((image) => {
        const id = `${key}_visual_${digest(image)}`
        visuals.add(id)
        if (!store.getPluginData(id)) {
          const chunks = split(image)
          chunks.forEach((chunk, i) => store.setPluginData(`${id}_${i}`, chunk))
          store.setPluginData(id, String(chunks.length))
        }
        return id
      })
      return [name, { ...scope, fingerprint: `pixels2:${parts[1]}:refs:${ids.join(".")}` }]
    }),
  )
  const content = JSON.stringify({ ...state, scopes }),
    chunks = split(content)
  const generation = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
  const parts = chunks.map((chunk) => `${key}_data_${digest(chunk)}`)
  const manifest = JSON.stringify({
    target,
    generation,
    chunks: chunks.length,
    parts,
    visuals: [...visuals],
  })
  if (manifest.length > 90000)
    throw new Error(
      "Too many visual baselines in this target. Split the source into smaller files.",
    )
  for (let i = 0; i < chunks.length; i++) {
    const existing = store.getPluginData(parts[i])
    if (existing && existing !== chunks[i])
      throw new Error("Import chunk identity collision. The previous links were preserved.")
    if (!existing) store.setPluginData(parts[i], chunks[i])
  }
  // Commit last so an interrupted write leaves the previous generation readable.
  store.setPluginData(key, manifest)
  if (old) {
    try {
      const previous = JSON.parse(old) as Manifest
      if (previous.parts) {
        const retained = new Set(parts)
        for (const id of [...previous.parts, ...(previous.journal ?? []).flat()])
          if (!retained.has(id) && id.startsWith(`${key}_data_`)) store.setPluginData(id, "")
      } else {
        for (let i = 0; i < Math.min(previous.baseChunks ?? previous.chunks, 2000); i++)
          store.setPluginData(`${key}_${previous.generation}_${i}`, "")
      }
      for (const id of previous.visuals ?? [])
        if (!visuals.has(id) && id.startsWith(`${key}_visual_`)) {
          const count = Math.min(Number(store.getPluginData(id)) || 0, 2000)
          for (let i = 0; i < count; i++) store.setPluginData(`${id}_${i}`, "")
          store.setPluginData(id, "")
        }
    } catch {
      /* The new generation is already committed. */
    }
  }
}

export function writePatch(
  store: PluginDataStore,
  target: string,
  patch: StatePatch,
  reset = false,
): void {
  const key = `f2p_v2_${digest(target)}`
  const raw = store.getPluginData(key)
  let previous: Manifest | undefined
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Manifest
      if (parsed.target && parsed.target !== target) throw new Error("Checkpoint target mismatch")
      const chunks = parsed.baseChunks ?? parsed.chunks
      if (!Number.isInteger(chunks) || chunks < 1 || chunks > 2000)
        throw new Error("Invalid checkpoint index")
      previous = parsed
    } catch (error) {
      if (!reset || /target mismatch/.test(String(error))) throw error
      // An explicit fresh import can replace an unreadable old index atomically.
    }
  }
  let manifest: Manifest
  const pending = new Map<string, string>()
  function prepare(content: string) {
    return split(content).map((chunk) => {
      const id = `${key}_data_${digest(chunk)}`
      const existing = store.getPluginData(id)
      if ((existing && existing !== chunk) || (pending.has(id) && pending.get(id) !== chunk))
        throw new Error("Checkpoint chunk identity collision")
      if (!existing) pending.set(id, chunk)
      return id
    })
  }
  if (!previous || reset) {
    const parts = prepare(JSON.stringify(emptyState()))
    manifest = { target, generation: "journal", chunks: parts.length, parts, journal: [] }
  } else manifest = { ...previous, journal: [...(previous.journal ?? [])] }
  // Older readers reject chunks=0 instead of silently ignoring a pending journal.
  manifest.baseChunks ??= manifest.chunks
  manifest.chunks = 0
  manifest.journal!.push(prepare(JSON.stringify(patch)))
  const content = JSON.stringify(manifest)
  if (content.length > 90000)
    throw new Error("Checkpoint journal is too large; saved links were preserved")
  for (const [id, chunk] of pending) store.setPluginData(id, chunk)
  store.setPluginData(key, content)
  // Reset is an explicit fresh import. Retire the old index only after the new one commits.
  if (reset && previous) {
    const retained = new Set([...(manifest.parts ?? []), ...manifest.journal!.flat()])
    try {
      const ids = [
        ...(previous.parts ??
          Array.from(
            { length: previous.baseChunks ?? previous.chunks },
            (_, i) => `${key}_${previous.generation}_${i}`,
          )),
        ...(previous.journal ?? []).flat(),
      ]
      for (const id of ids) if (!retained.has(id)) store.setPluginData(id, "")
      for (const id of previous.visuals ?? [])
        if (id.startsWith(`${key}_visual_`)) {
          const count = Math.min(Number(store.getPluginData(id)) || 0, 2000)
          for (let i = 0; i < count; i++) store.setPluginData(`${id}_${i}`, "")
          store.setPluginData(id, "")
        }
    } catch {
      /* The new checkpoint is committed. */
    }
  }
}

export function compactState(store: PluginDataStore, target: string, state: ImportState): boolean {
  const raw = store.getPluginData(`f2p_v2_${digest(target)}`)
  if (!raw) return false
  const manifest = JSON.parse(raw) as Manifest
  const journal = manifest.journal ?? []
  if (journal.length < 128 && journal.reduce((count, parts) => count + parts.length, 0) < 768)
    return false
  writeState(store, target, state)
  return true
}
