import type { ComposeOp } from "./protopie-client"

export interface OpResult {
  ok: boolean
  value: Record<string, any>
  error?: string
}
export interface BatchLimits {
  operations: number
  bytes: number
}
export const DEFAULT_LIMITS: BatchLimits = { operations: 250, bytes: 8 * 1024 * 1024 }

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
export function replaceReferences<T>(value: T, known: Map<string, Record<string, any>>): T {
  if (typeof value === "string")
    return value.replace(/\$\{(\w+)\.([\w.[\]]+)\}/g, (full, name, path) => {
      if (!known.has(name)) return full
      let result: any = known.get(name)
      for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".")) result = result?.[key]
      if (result === undefined || result === null)
        throw new Error(
          `Dependency ${name}.${path} did not produce a result; dependent operation was not sent.`,
        )
      return String(result)
    }) as T
  if (Array.isArray(value)) return value.map((v) => replaceReferences(v, known)) as T
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceReferences(v, known)]),
    ) as T
  return value
}

export async function executeBatches(
  operations: ComposeOp[],
  send: (ops: ComposeOp[]) => Promise<any>,
  onResult: (index: number, result: OpResult) => void = () => {},
  limits = DEFAULT_LIMITS,
  afterBatch: (hasMore: boolean) => Promise<void> = async () => {},
): Promise<{ results: OpResult[]; calls: number; bytes: number }> {
  if (
    !Number.isInteger(limits.operations) ||
    limits.operations < 1 ||
    !Number.isInteger(limits.bytes) ||
    limits.bytes < 2
  )
    throw new Error("Batch limits must be positive integer operation and byte bounds.")
  const names = new Set(operations.flatMap((op) => (op.name ? [op.name] : [])))
  const known = new Map<string, Record<string, any>>()
  const results: OpResult[] = []
  type Group = { wire: ComposeOp; indices: number[]; bytes: number }
  let calls = 0,
    totalBytes = 0,
    cursor = 0
  function commit(index: number, result: OpResult) {
    results[index] = result
    const name = operations[index].name
    if (name) known.set(name, result.ok ? result.value : {})
    onResult(index, result)
  }
  function singleCreate(op: ComposeOp) {
    return (
      op.tool === "layer_manage" &&
      op.input.action === "batch_add" &&
      Array.isArray(op.input.layers) &&
      op.input.layers.length === 1
    )
  }
  function envelope(op: ComposeOp) {
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(op.input)
          .filter((k) => k !== "layers")
          .sort()
          .map((k) => [k, op.input[k]]),
      ),
    )
  }
  while (cursor < operations.length) {
    const groups: Group[] = []
    const inFlight = new Set<string>()
    let batchBytes = 2,
      weight = 0
    while (cursor < operations.length && weight < limits.operations) {
      const original = operations[cursor]
      const dependencies = [...JSON.stringify(original.input).matchAll(/\$\{(\w+)\./g)]
        .map((match) => match[1])
        .filter((name) => names.has(name))
      // Materialize parent IDs before building the next level. Each alias keeps its own
      // acknowledgement, so one failed parent never invalidates successful siblings.
      if (dependencies.some((name) => inFlight.has(name))) break
      let op: ComposeOp
      try {
        if (dependencies.some((name) => !known.has(name)))
          throw new Error("A dependency was not acknowledged; dependent operation was not sent.")
        op = replaceReferences(original, known)
      } catch (error) {
        commit(cursor++, { ok: false, value: {}, error: String(error) })
        continue
      }
      const opBytes = bytes(op)
      if (opBytes + 2 > limits.bytes) {
        commit(cursor++, {
          ok: false,
          value: {},
          error: `One operation exceeds the ${limits.bytes}-byte payload limit. Reduce the image size or increase the configured limit.`,
        })
        continue
      }
      const opWeight =
        op.tool === "layer_manage" && Array.isArray(op.input.layers)
          ? Math.max(1, op.input.layers.length)
          : 1
      if (opWeight > limits.operations) {
        commit(cursor++, {
          ok: false,
          value: {},
          error: "A native layer array exceeds the configured layer limit; it was not sent.",
        })
        continue
      }
      if (groups.length && weight + opWeight > limits.operations) break
      const previous = groups[groups.length - 1]
      let combined: ComposeOp | undefined
      if (
        singleCreate(op) &&
        previous &&
        singleCreateGroup(previous) &&
        envelope(previous.wire) === envelope(op)
      ) {
        combined = {
          tool: "layer_manage",
          input: {
            ...op.input,
            layers: [...(previous.wire.input.layers as any[]), ...(op.input.layers as any[])],
          },
        }
      }
      const nextBytes = combined ? bytes(combined) : opBytes
      const delta = combined ? nextBytes - previous.bytes : nextBytes + 1
      if (groups.length && batchBytes + delta > limits.bytes) break
      if (combined) {
        previous.wire = combined
        previous.indices.push(cursor)
        previous.bytes = nextBytes
      } else groups.push({ wire: op, indices: [cursor], bytes: opBytes })
      batchBytes += delta
      weight += opWeight
      if (original.name) inFlight.add(original.name)
      cursor++
    }
    if (!groups.length) continue
    const batch = groups.map((group) => group.wire)
    const response = await send(batch)
    calls++
    totalBytes += bytes(batch)
    const explicitErrors = new Map<number, string>(
      (response.errors ?? []).map((error: any) => [error.operationIndex, error.error]),
    )
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i],
        value = response.results?.[i]
      if (group.indices.length > 1) {
        const rejected = value?.errors ?? []
        const created = value?.createdLayers ?? []
        const count = group.indices.length
        const valid =
          !explicitErrors.has(i) &&
          value?.success !== false &&
          Array.isArray(rejected) &&
          Array.isArray(created) &&
          rejected.every(
            (error: any) =>
              Number.isInteger(error.index) && error.index >= 0 && error.index < count,
          ) &&
          new Set(rejected.map((error: any) => error.index)).size === rejected.length &&
          created.every((layer: any) => typeof layer?.id === "string" && layer.id.length > 0) &&
          new Set(created.map((layer: any) => layer.id)).size === created.length &&
          created.length + rejected.length === count &&
          (value?.failedCount === undefined || value.failedCount === rejected.length)
        if (!valid)
          throw new Error(
            "Ambiguous grouped layer response. Reconcile the interrupted import before retrying it.",
          )
        const errors = new Map<number, string>(
          rejected.map((error: any) => [error.index, error.error]),
        )
        let success = 0
        for (let j = 0; j < group.indices.length; j++) {
          const layer = errors.has(j) ? undefined : created[success++]
          commit(
            group.indices[j],
            layer?.id
              ? {
                  ok: true,
                  value: { layerId: layer.id, layerIds: [layer.id], createdLayers: [layer] },
                }
              : { ok: false, value: {}, error: errors.get(j) ?? "Layer was not acknowledged" },
          )
        }
      } else {
        const error =
          explicitErrors.get(i) ??
          (value?.errors?.length
            ? value.errors.map((error: any) => error.error ?? String(error)).join("; ")
            : undefined)
        const ok = !!value && !error && value.success !== false && !(value.failedCount > 0)
        commit(group.indices[0], {
          ok,
          value: value ?? {},
          error:
            error ??
            (ok
              ? undefined
              : "Studio did not acknowledge this operation; no sync record was committed."),
        })
      }
    }
    await afterBatch(cursor < operations.length)
  }
  return { results, calls, bytes: totalBytes }
}
function singleCreateGroup(group: { wire: ComposeOp; indices: number[] }) {
  return (
    group.wire.tool === "layer_manage" &&
    group.wire.input.action === "batch_add" &&
    Array.isArray(group.wire.input.layers) &&
    group.wire.input.layers.length === group.indices.length
  )
}
