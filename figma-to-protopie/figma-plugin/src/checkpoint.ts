import type { ImportState, ScopeRecord } from "./design"

export interface StatePatch {
  version: 2
  scopes: Record<
    string,
    null | {
      meta: Omit<ScopeRecord, "nodes" | "reactions">
      nodes: Record<string, unknown | null>
      reactions: Record<string, unknown | null>
    }
  >
  assets: Record<string, string | null>
  variables: Record<string, ImportState["variables"][string] | null>
}
const set = (object: object, key: string, value: unknown) =>
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
function merge(target: Record<string, any>, changes: Record<string, any>) {
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete target[key]
    else set(target, key, value)
  }
}
export function applyPatch(state: ImportState, patch: StatePatch): ImportState {
  if (
    ![1, 2].includes(Number(patch?.version)) ||
    !patch.scopes ||
    !patch.assets ||
    !patch.variables
  )
    throw new Error("Invalid checkpoint patch")
  for (const [key, change] of Object.entries(patch.scopes)) {
    if (change === null) {
      delete state.scopes[key]
      continue
    }
    if (!change.nodes || !change.reactions) throw new Error("Invalid scope checkpoint")
    const prior = Object.prototype.hasOwnProperty.call(state.scopes, key)
      ? state.scopes[key]
      : undefined
    const { nodes: _nodes, reactions: _reactions, ...priorMeta } = prior ?? ({} as ScopeRecord)
    const metadata = Number(patch.version) === 1 ? { ...change.meta } : { ...priorMeta }
    if (Number(patch.version) === 2) merge(metadata, change.meta ?? {})
    if (typeof metadata.id !== "string") throw new Error("Checkpoint scope identity is missing")
    const scope = {
      ...metadata,
      nodes: { ...prior?.nodes },
      reactions: { ...prior?.reactions },
    } as ScopeRecord
    merge(scope.nodes, change.nodes)
    merge(scope.reactions, change.reactions)
    set(state.scopes, key, scope)
  }
  merge(state.assets, patch.assets)
  merge(state.variables, patch.variables)
  return state
}

// Keep encoded records from the last acknowledged checkpoint, never references to mutable state.
export function checkpointTracker(initial: ImportState) {
  let before = encode(initial)
  return {
    prepare(state: ImportState) {
      const next = encode(state)
      const patch: StatePatch = { version: 2, scopes: {}, assets: {}, variables: {} }
      let changed = false
      const changes = (old: Map<string, string>, now: Map<string, string>) => {
        const result: Record<string, any> = {}
        for (const [key, value] of now)
          if (old.get(key) !== value) set(result, key, JSON.parse(value))
        for (const key of old.keys()) if (!now.has(key)) set(result, key, null)
        return result
      }
      for (const [key, scope] of next.scopes) {
        const prior = before.scopes.get(key)
        const meta = changes(prior?.meta ?? new Map(), scope.meta)
        const nodes = changes(prior?.nodes ?? new Map(), scope.nodes)
        const reactions = changes(prior?.reactions ?? new Map(), scope.reactions)
        if (
          Object.keys(meta).length ||
          Object.keys(nodes).length ||
          Object.keys(reactions).length
        ) {
          set(patch.scopes, key, {
            ...(Object.keys(meta).length ? { meta } : {}),
            nodes,
            reactions,
          })
          changed = true
        }
      }
      for (const key of before.scopes.keys())
        if (!next.scopes.has(key)) {
          set(patch.scopes, key, null)
          changed = true
        }
      patch.assets = changes(before.assets, next.assets)
      patch.variables = changes(before.variables, next.variables)
      changed ||= !!(Object.keys(patch.assets).length || Object.keys(patch.variables).length)
      return {
        patch,
        changed,
        acknowledge() {
          before = next
        },
      }
    },
  }
}
function encode(state: ImportState) {
  const entries = (values: object) =>
    new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]))
  return {
    assets: entries(state.assets),
    variables: entries(state.variables),
    scopes: new Map(
      Object.entries(state.scopes).map(([key, { nodes, reactions, ...meta }]) => [
        key,
        { meta: entries(meta), nodes: entries(nodes), reactions: entries(reactions) },
      ]),
    ),
  }
}
