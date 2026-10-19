import {
  digest,
  emptyState,
  stable,
  walk,
  type Design,
  type DesignComponent,
  type DesignNode,
  type ImportState,
  type NodeRecord,
  type Properties,
  type ScopeRecord,
} from "./design"
import { DEFAULT_LIMITS, executeBatches, type BatchLimits, type OpResult } from "./batch"
import { Studio, type ScopeView, type ToolMetric } from "./studio"
import { sameFingerprint, fingerprintDifference } from "./visual"
import type { ComposeOp } from "./protopie-client"
import { resolveFont, type InstalledFont } from "./fonts"

export type VariableChoice = "existing" | "create" | "skip"
export interface VariableCollision {
  sourceId: string
  sourceName: string
  sourceType: string
  sourceValue: string | number
  existing: { id: string; name: string; dataType: string; value: string | number }
  canReuse: boolean
}
export interface ImportOptions {
  fontFaces?: InstalledFont[]
  verifyOnly?: boolean
  newImport?: boolean
  resolveVariableCollisions?: (
    collisions: VariableCollision[],
  ) => Promise<Record<string, VariableChoice> | null>
  allowSharedComponents?: boolean
  fitCanvas?: boolean
  checkConflicts?: boolean
  limits?: BatchLimits
  signal?: AbortSignal
}
export interface ImportReport {
  mode?: "new" | "update"
  created: string[]
  updated: string[]
  skipped: string[]
  conflicts: string[]
  canImportAsNew?: boolean
  variableCollisions?: VariableCollision[]
  errors: string[]
  verificationPending?: string[]
  verification?: {
    scope: string
    status: string
    captureErrors?: string[]
    captures: {
      hash: string
      structure: string
      difference?: ReturnType<typeof fingerprintDifference>
    }[]
  }[]
  notes: string[]
  milliseconds: number
  endToEndMilliseconds?: number
  figmaReadMilliseconds?: number
  connectionMilliseconds?: number
  linkSaveMilliseconds?: number
  studioCalls?: Record<string, ToolMetric>
  calls: number
  bytes: number
}
export function componentOrder(components: DesignComponent[]): DesignComponent[] {
  const byId = new Map(components.map((c) => [c.id, c])),
    visiting = new Set<string>(),
    done = new Set<string>(),
    sorted: DesignComponent[] = []
  function visit(c: DesignComponent) {
    if (done.has(c.id)) return
    if (visiting.has(c.id)) throw new Error(`Circular component dependency: ${c.name}`)
    visiting.add(c.id)
    walk(c.root, (n) => {
      if (n.component && byId.has(n.component)) visit(byId.get(n.component)!)
    })
    visiting.delete(c.id)
    done.add(c.id)
    sorted.push(c)
  }
  components.forEach(visit)
  return sorted
}

function changedProps(before: Properties, after: Properties): Properties {
  return Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v))
}
function hasId(value: unknown, id: string): boolean {
  if (typeof value === "string") return value === id
  if (Array.isArray(value)) return value.some((v) => hasId(v, id))
  return !!value && typeof value === "object" && Object.values(value).some((v) => hasId(v, id))
}

export async function importDesign(
  studio: Studio,
  design: Design,
  state: ImportState = emptyState(),
  options: ImportOptions = {},
  progress: (text: string) => void = () => {},
  checkpoint: (state: ImportState) => Promise<void> = async () => {},
): Promise<{ state: ImportState; report: ImportReport }> {
  const started = performance.now()
  const beforeMetrics = Object.fromEntries(
    Object.entries(studio.metrics ?? {}).map(([name, metric]) => [name, { ...metric }]),
  )
  const report: ImportReport = {
    created: [],
    updated: [],
    skipped: [],
    conflicts: [],
    canImportAsNew: false,
    errors: [],
    notes: [...design.notes],
    milliseconds: 0,
    linkSaveMilliseconds: 0,
    calls: 0,
    bytes: 0,
  }
  function finishReport() {
    report.milliseconds = Math.round(performance.now() - started)
    report.linkSaveMilliseconds = Math.round(report.linkSaveMilliseconds!)
    report.studioCalls = Object.fromEntries(
      Object.entries(studio.metrics ?? {})
        .map(([name, metric]) => [
          name,
          {
            calls: metric.calls - (beforeMetrics[name]?.calls ?? 0),
            milliseconds: Math.round(
              metric.milliseconds - (beforeMetrics[name]?.milliseconds ?? 0),
            ),
          },
        ])
        .filter(([, metric]) => (metric as ToolMetric).calls > 0),
    )
  }
  function scopeConflict(message: string) {
    report.conflicts.push(message)
    report.canImportAsNew = true
  }
  const saveLinks = checkpoint
  checkpoint = async (next) => {
    const start = performance.now()
    try {
      await saveLinks(next)
    } finally {
      report.linkSaveMilliseconds! += performance.now() - start
    }
  }
  const assets = new Map(design.assets.map((a) => [a.key, a]))
  const views = new Map<string, ScopeView>()
  const unsafe = new Set<string>()
  const refreshed = new Set<string>()
  let serial = 0
  let activeScope: ScopeRecord | undefined
  function name() {
    return `f2p${++serial}`
  }
  function cancelled() {
    if (options.signal?.aborted)
      throw new Error(
        "Import cancelled. Previously acknowledged changes remain linked; no further writes were sent.",
      )
  }
  async function send(ops: ComposeOp[], commit: (index: number, r: OpResult) => void = () => {}) {
    const tracked = activeScope
    const previousMarker = tracked?.recoveryRequired
    let armed = false,
      uncertain = false,
      closed = false
    let r
    try {
      r = await executeBatches(
        ops,
        async (chunk) => {
          cancelled()
          // One durable marker covers the entire sequence, including the gaps between batches.
          // Acknowledged IDs are still committed after every batch before another is sent.
          if (tracked && !armed) {
            tracked.recoveryRequired =
              previousMarker ??
              "A write was in progress when the plugin closed. Inspect this import before retrying or use Import as new."
            await checkpoint(state)
            armed = true
          }
          const layers = chunk.reduce(
            (count, op) =>
              count +
              (op.tool === "layer_manage" && Array.isArray(op.input.layers)
                ? op.input.layers.length
                : 0),
            0,
          )
          progress(
            `Writing ${layers ? `${layers} layers` : `${chunk.length} operations`} to Studio in ${chunk.length} native batches...`,
          )
          uncertain = true
          return studio.write(chunk, !!options.allowSharedComponents)
        },
        commit,
        options.limits,
        async (hasMore) => {
          if (tracked) {
            const marker = tracked.recoveryRequired
            if (!hasMore) {
              if (previousMarker) tracked.recoveryRequired = previousMarker
              else delete tracked.recoveryRequired
            }
            try {
              await checkpoint(state)
            } catch (error) {
              tracked.recoveryRequired = marker
              throw error
            }
          }
          closed = !hasMore
          uncertain = false
        },
      )
    } finally {
      if (tracked && armed && !uncertain && !closed) {
        if (previousMarker) tracked.recoveryRequired = previousMarker
        else delete tracked.recoveryRequired
        await checkpoint(state)
      }
    }
    report.calls += r.calls
    report.bytes += r.bytes
    for (const error of r.results.filter((x) => !x.ok))
      report.errors.push(error.error ?? "Studio operation failed")
    return r.results
  }
  async function preflight(key: string, record: ScopeRecord): Promise<boolean> {
    if (unsafe.has(key)) return false
    if (record.recoveryRequired) {
      scopeConflict(`${key}: ${record.recoveryRequired}`)
      unsafe.add(key)
      return false
    }
    if (
      !record.fingerprint &&
      !record.verificationCandidates?.length &&
      options.checkConflicts !== false
    ) {
      const message = `${key}: no verified baseline or original verification captures were saved for this import. Its content was preserved. Import a separate new copy to establish verification evidence.`
      scopeConflict(message)
      ;(report.verificationPending ??= []).push(message)
      unsafe.add(key)
      return false
    }
    if (views.has(key)) return true
    progress(`Checking ${key} for edits made in ProtoPie…`)
    try {
      let view = await studio.view(
        record.id,
        record.kind === "component",
        options.checkConflicts !== false,
      )
      // Thumbnail workers may differ in text rasterization. Only reads are retried, and an
      // existing exact baseline must match before any update can proceed.
      if (record.fingerprint && options.checkConflicts !== false) {
        for (
          let attempt = 0;
          attempt < 3 && !sameFingerprint(record.fingerprint, view.fingerprint);
          attempt++
        ) {
          view = await studio.view(record.id, record.kind === "component", true)
        }
      }
      if (options.checkConflicts !== false && !record.fingerprint) {
        const match = record.verificationCandidates?.some((candidate) =>
          sameFingerprint(candidate, view.fingerprint),
        )
        ;(report.verification ??= []).push({
          scope: key,
          status: match ? "verified" : "pending",
          captures: [
            {
              hash: digest(view.fingerprint),
              structure: view.fingerprint.startsWith("pixels2:")
                ? view.fingerprint.split(":")[1]
                : digest(view.fingerprint),
              ...(record.verificationCandidates?.length
                ? {
                    difference: fingerprintDifference(
                      record.verificationCandidates[0],
                      view.fingerprint,
                    ),
                  }
                : {}),
            },
          ],
        })
        if (!match) {
          const message = `${key}: no verified baseline exists for this import. Its content was preserved; this does not establish that you edited it. Retry verification or import a separate new copy.`
          scopeConflict(message)
          ;(report.verificationPending ??= []).push(message)
          unsafe.add(key)
          return false
        }
        record.fingerprint = view.fingerprint
        delete record.verificationCandidates
        await checkpoint(state)
      }
      if (
        options.checkConflicts !== false &&
        !sameFingerprint(record.fingerprint, view.fingerprint)
      ) {
        scopeConflict(`${key}: ProtoPie changed since the last import. Its content was preserved.`)
        unsafe.add(key)
        return false
      }
      views.set(key, view)
      return true
    } catch (error) {
      scopeConflict(`${key}: ${String(error)}`)
      unsafe.add(key)
      return false
    }
  }
  async function fingerprint(key: string, record: ScopeRecord) {
    const evidence = {
      scope: key,
      status: "pending",
      captureErrors: [] as string[],
      captures: [] as NonNullable<ImportReport["verification"]>[number]["captures"],
    }
    ;(report.verification ??= []).push(evidence)
    const candidates: string[] = []
    const capture = (value: string) => {
      evidence.captures.push({
        hash: digest(value),
        structure: value.startsWith("pixels2:") ? value.split(":")[1] : digest(value),
        ...(candidates.length
          ? { difference: fingerprintDifference(candidates[candidates.length - 1], value) }
          : {}),
      })
      candidates.push(value)
    }
    try {
      let view: ScopeView | undefined
      // Persist a baseline reproduced by at least two native captures after our writes.
      // Alternating thumbnail workers need not return matching captures consecutively.
      const seen = new Set<string>()
      let settled = false
      let missingPreview: unknown
      for (let attempt = 0; attempt < 6; attempt++) {
        let next: ScopeView
        try {
          next = await studio.view(
            record.id,
            record.kind === "component",
            options.checkConflicts !== false,
          )
        } catch (error) {
          if (!String(error).includes("Studio could not produce a visual baseline")) throw error
          // A missing thumbnail consumes the same bounded read budget; never repeat a write.
          missingPreview = error
          evidence.captureErrors.push(String(error))
          continue
        }
        capture(next.fingerprint)
        settled = [...seen].some((previous) => sameFingerprint(previous, next.fingerprint))
        seen.add(next.fingerprint)
        view = next
        if (settled) break
      }
      if (!view && missingPreview) throw missingPreview
      if (!settled || !view)
        throw new Error(
          "Studio's visual baseline is still changing. Inspect this scope before updating it again.",
        )
      record.fingerprint = view.fingerprint
      delete record.verificationCandidates
      evidence.status = "verified"
      views.set(key, view)
      refreshed.add(key)
    } catch (error) {
      record.fingerprint = ""
      let bytes = 0
      record.verificationCandidates = candidates
        .reverse()
        .filter((candidate, index) => index < 4 && (bytes += candidate.length) <= 4 * 1024 * 1024)
      const message = `${key}: ${String(error)}`
      ;(report.verificationPending ??= []).push(message)
      if (!String(error).includes("visual baseline is still changing")) report.errors.push(message)
    }
  }
  async function syncScope(
    key: string,
    root: DesignNode,
    component: boolean,
    partial = false,
    parentSource?: string,
  ) {
    cancelled()
    activeScope = undefined
    let record = state.scopes[key]
    const hash = digest(root)
    const label = String(root.props.name ?? key)
    if (unsafe.has(key)) return
    if (record?.recoveryRequired) {
      await preflight(key, record)
      return
    }
    if (!partial && record?.hash === hash) {
      if (record.fingerprint || options.checkConflicts === false || (await preflight(key, record)))
        report.skipped.push(label)
      return
    }
    const existed = !!record
    if (record && !(await preflight(key, record))) return
    if (component && record && !options.allowSharedComponents) {
      const result = await studio.tool("resolve_ids", { ids: [record.id] })
      if ((result.results?.[0]?.referenceCount ?? 0) > 1) {
        scopeConflict(
          `${label}: updating this master affects multiple instances. Enable shared component updates to continue.`,
        )
        return
      }
    }
    if (!record) {
      record = {
        id: "",
        rootId: root.id,
        kind: component ? "component" : "scene",
        hash: "",
        fingerprint: "",
        nodes: {},
        reactions: {},
      }
      state.scopes[key] = record
      activeScope = record
      if (component) {
        const result = await send(
          [{ tool: "component_manage", input: { action: "add", properties: { name: label } } }],
          (_, r) => {
            if (r.ok) record!.id = r.value.componentId
          },
        )
        const id = result[0]?.value.componentId
        if (!result[0]?.ok || !id) return
        const nativeRoot = studio.componentRoot
          ? await studio.componentRoot(id)
          : (await studio.view(id, true, false)).tree[0]
        if (!nativeRoot) {
          report.errors.push(`${label}: Studio did not return the component root.`)
          return
        }
        record.nodes[root.id] = { id: nativeRoot.id, type: "CONTAINER", props: {} }
      } else {
        const result = await send(
          [
            {
              tool: "scene_manage",
              input: {
                action: "batch_add",
                scenes: [{ properties: { name: label, fillColor: "#FFFFFF", fillOpacity: 0 } }],
              },
            },
          ],
          (_, r) => {
            if (r.ok) record!.id = r.value.sceneId
          },
        )
        const id = result[0]?.value.sceneId
        if (!result[0]?.ok || !id) return
      }
      state.scopes[key] = record
      await checkpoint(state)
    }
    const target = record
    activeScope = target
    const priorOverrides = new Map(
      Object.entries(target.nodes).map(([id, n]) => [
        id,
        { nativeId: n.id, overrides: n.overrides ?? [] },
      ]),
    )
    const scope = component ? { artboardId: target.id } : { sceneId: target.id }
    const operations: ComposeOp[] = []
    const commits = new Map<number, (r: OpResult) => void>()
    const refs = new Map<string, string>(Object.entries(target.nodes).map(([id, r]) => [id, r.id]))
    const assetRefs = new Map(Object.entries(state.assets))
    let failed = false
    function emit(op: ComposeOp, commit?: (r: OpResult) => void) {
      const index = operations.length
      operations.push(op)
      if (commit) commits.set(index, commit)
      return index
    }
    function resource(key: string): string {
      if (assetRefs.has(key)) return assetRefs.get(key)!
      const asset = assets.get(key)
      if (!asset) throw new Error(`Missing image asset ${key}`)
      const op = name(),
        ref = `\${${op}.resourceId}`
      emit(
        {
          tool: "resource_manage",
          name: op,
          input: {
            action: "add_inline",
            mimeType: asset.mimeType,
            data: asset.data,
            filename: `F2P_${key}`,
          },
        },
        (r) => {
          if (r.ok && r.value.resourceId) {
            state.assets[key] = r.value.resourceId
            assetRefs.set(key, r.value.resourceId)
          } else if (r.ok) {
            failed = true
            report.errors.push(`Image asset ${key} was not assigned a resource ID.`)
          }
        },
      )
      assetRefs.set(key, ref)
      return ref
    }
    const desired = new Map<string, DesignNode>()
    const subtreeSizes = new Map<string, number>()
    function measure(node: DesignNode): number {
      desired.set(node.id, node)
      const size = 1 + node.children.reduce((sum, child) => sum + measure(child), 0)
      subtreeSizes.set(node.id, size)
      return size
    }
    measure(root)
    const oldSubtree = new Set<string>()
    function descendants(sourceId: string) {
      oldSubtree.add(sourceId)
      for (const [id, n] of Object.entries(target.nodes))
        if (n.parent === sourceId && !oldSubtree.has(id)) descendants(id)
    }
    if (partial) descendants(root.id)
    else Object.keys(target.nodes).forEach((id) => oldSubtree.add(id))
    const removed = [...oldSubtree].filter(
      (id) => !desired.has(id) || target.nodes[id]?.type !== desired.get(id)?.type,
    )
    // Replacing a container invalidates all of its old descendant ids, including retained children.
    for (let i = 0; i < removed.length; i++)
      for (const [id, n] of Object.entries(target.nodes))
        if (n.parent === removed[i] && !removed.includes(id)) removed.push(id)
    const removedTargets = new Set(removed.map((id) => target.nodes[id]?.id).filter(Boolean))
    if (removed.length) {
      const view = views.get(key)
      const knownTriggers = new Set(Object.values(target.reactions).map((r) => r.id))
      if (
        view?.interactions.some(
          (interaction) =>
            !knownTriggers.has(interaction.triggerId) &&
            [...removedTargets].some((id) => hasId(interaction, id)),
        )
      ) {
        scopeConflict(
          `${label}: removing a layer would delete a manually authored interaction. No changes were applied.`,
        )
        return
      }
      // Delete only the highest removed nodes; removing a container also removes its descendants.
      const top = removed.filter((id) => !removed.includes(target.nodes[id]?.parent ?? ""))
      for (const id of top)
        emit(
          {
            tool: "layer_manage",
            input: { ...scope, action: "delete", layerIdList: [target.nodes[id].id] },
          },
          (r) => {
            if (r.ok) {
              const deleted = new Set([id])
              for (let i = 0; i < removed.length; i++)
                for (const child of removed)
                  if (deleted.has(target.nodes[child]?.parent ?? "")) deleted.add(child)
              for (const sourceId of deleted) {
                delete target.nodes[sourceId]
                for (const reactionKey of Object.keys(target.reactions))
                  if (reactionKey.startsWith(`${sourceId}:`)) delete target.reactions[reactionKey]
              }
            }
          },
        )
      for (const id of removed) refs.delete(id)
    }
    const layerQueue: { node: DesignNode; parent?: string }[] = []
    const orderJobs: (() => void)[] = []
    const deferred = new Map<string, { properties: Properties; source: Properties }>()
    const layoutMarker =
      "Live layout was not fully restored after building this scope. Inspect it before retrying or use Import as new."
    // Defer only new containers. Existing scopes keep their validated layout during updates.
    const deferLayout = desired.size >= 250
    function layer(node: DesignNode, parent?: string) {
      const prior = removed.includes(node.id) ? undefined : target.nodes[node.id]
      const props = { ...node.props }
      if (node.asset) props.resourceId = resource(node.asset)
      if (node.component) {
        const master = state.scopes[`component:${node.component}`]
        if (!master || unsafe.has(`component:${node.component}`))
          throw new Error(`${node.props.name}: component master was not resolved safely`)
        props.componentId = master.id
      }
      const parentId = parent ? refs.get(parent) : undefined
      const sourceProps = { ...node.props }
      const type = node.type
      if (prior) {
        let acknowledgedParent = prior.parent
        if (parent !== prior.parent && parentId)
          emit(
            {
              tool: "layer_manage",
              input: {
                ...scope,
                action: "reorder",
                layerIdList: [prior.id],
                newParentId: parentId,
              },
            },
            (r) => {
              if (r.ok) {
                acknowledgedParent = parent
                target.nodes[node.id] = { ...target.nodes[node.id], parent }
              }
            },
          )
        // Studio can change local geometry and layout while reparenting. Restore the source
        // properties even when their values were unchanged in the source document.
        const changed =
          parent !== prior.parent ? { ...sourceProps } : changedProps(prior.props, sourceProps)
        if (prior.asset !== node.asset && node.asset) changed.resourceId = props.resourceId
        if (prior.component !== node.component && node.component)
          changed.componentId = props.componentId
        if (Object.keys(changed).length)
          emit(
            {
              tool: "layer_manage",
              input: {
                ...scope,
                action: "batch_edit",
                layers: [{ id: prior.id, properties: changed }],
              },
            },
            (r) => {
              if (r.ok)
                target.nodes[node.id] = {
                  ...prior,
                  props: sourceProps,
                  parent: acknowledgedParent,
                  asset: node.asset,
                  component: node.component,
                  order: node.children.map((c) => c.id),
                }
            },
          )
        refs.set(node.id, prior.id)
      } else {
        if (
          deferLayout &&
          subtreeSizes.get(node.id)! >= 16 &&
          type === "CONTAINER" &&
          props.layoutMode &&
          props.layoutMode !== "NONE"
        ) {
          const properties: Properties = {}
          for (const field of [
            "layoutMode",
            "primaryAxisSizingMode",
            "counterAxisSizingMode",
            "layoutSizingHorizontal",
            "layoutSizingVertical",
          ]) {
            if (props[field] !== undefined) properties[field] = props[field]
          }
          props.layoutMode = "NONE"
          for (const field of Object.keys(properties))
            if (field !== "layoutMode") props[field] = "FIXED"
          deferred.set(node.id, { properties, source: sourceProps })
        }
        const op = name(),
          ref = `\${${op}.layerId}`
        emit(
          {
            tool: "layer_manage",
            name: op,
            input: {
              ...scope,
              action: "batch_add",
              layers: [
                {
                  layerType: type,
                  ...(parentId
                    ? { parentId }
                    : component
                      ? { parentId: target.nodes[root.id]?.id }
                      : { sceneId: target.id }),
                  properties: props,
                },
              ],
            },
          },
          (r) => {
            if (r.ok && r.value.layerId)
              target.nodes[node.id] = {
                id: r.value.layerId,
                type,
                // The scope stays recovery-marked until all deferred properties are acknowledged.
                props: sourceProps,
                parent,
                asset: node.asset,
                component: node.component,
                order: node.children.map((c) => c.id),
              }
          },
        )
        refs.set(node.id, ref)
      }
      // ProtoPie inserts auto-layout children in reverse visual order.
      const children =
        node.props.layoutMode && node.props.layoutMode !== "NONE"
          ? [...node.children].reverse()
          : node.children
      for (const child of children) layerQueue.push({ node: child, parent: node.id })
      if (
        prior &&
        (stable(prior.order ?? []) !== stable(node.children.map((c) => c.id)) ||
          prior.props.layoutMode !== node.props.layoutMode)
      )
        orderJobs.push(() => {
          children.forEach((child, index) =>
            emit({
              tool: "layer_manage",
              input: {
                ...scope,
                action: "reorder",
                layerIdList: [refs.get(child.id)],
                newParentId: refs.get(node.id),
                nextSiblingIdx: index,
              },
            }),
          )
          emit(
            {
              tool: "layer_manage",
              input: {
                ...scope,
                action: "batch_edit",
                layers: [{ id: prior.id, properties: { name: sourceProps.name } }],
              },
            },
            (r) => {
              if (r.ok && target.nodes[node.id])
                target.nodes[node.id].order = node.children.map((c) => c.id)
            },
          )
        })
    }
    try {
      // Resolve all images first. Interleaving a resource with its first IMAGE layer otherwise
      // forces an extra dependency round trip and fragments the breadth-first layer arrays.
      const removals = operations.splice(0)
      const removalCommits = new Map(commits)
      commits.clear()
      walk(root, (node) => {
        if (node.asset) resource(node.asset)
      })
      if (operations.length) {
        progress(`Uploading images for ${label}...`)
        await send(operations, (index, result) => {
          if (!result.ok) failed = true
          commits.get(index)?.(result)
        })
        operations.length = 0
        commits.clear()
        if (failed) throw new Error("Image upload failed; no layers in this scope were replaced.")
      }
      operations.push(...removals)
      for (const [index, commit] of removalCommits) commits.set(index, commit)
      // A failed removal must never be followed by replacement creates in the same scope.
      if (operations.length) {
        await send(operations, (index, r) => {
          if (!r.ok) failed = true
          commits.get(index)?.(r)
        })
        operations.length = 0
        commits.clear()
        if (failed) {
          target.hash = ""
          await fingerprint(key, target)
          await checkpoint(state)
          return
        }
      }
      layerQueue.push({ node: root, parent: partial ? parentSource : undefined })
      for (let index = 0; index < layerQueue.length; index++) {
        const next = layerQueue[index]
        layer(next.node, next.parent)
      }
      for (const reorder of orderJobs) reorder()
      if (deferred.size) target.recoveryRequired = layoutMarker
      progress(`Importing ${label} (${desired.size} layers)…`)
      await send(operations, (index, r) => {
        if (!r.ok) failed = true
        commits.get(index)?.(r)
      })
      if (deferred.size) {
        // Children settle before their ancestors. Preserve the same insertion order used for
        // live layouts; only their activation is delayed until the hierarchy is complete.
        progress(`Applying live layout for ${label}...`)
        const pending = [...layerQueue].reverse().flatMap(({ node }) => {
          const job = deferred.get(node.id),
            linked = target.nodes[node.id]
          return job && linked ? [{ id: linked.id, sourceId: node.id, ...job }] : []
        })
        const limit = options.limits?.operations ?? DEFAULT_LIMITS.operations
        const edits: ComposeOp[] = []
        const jobs: (typeof pending)[] = []
        for (let index = 0; index < pending.length; index += limit) {
          const group = pending.slice(index, index + limit)
          jobs.push(group)
          edits.push({
            tool: "layer_manage",
            input: {
              ...scope,
              action: "batch_edit",
              layers: group.map(({ id, properties }) => ({ id, properties })),
            },
          })
        }
        await send(edits, (index, result) => {
          if (!result.ok) failed = true
          else
            for (const job of jobs[index]) {
              target.nodes[job.sourceId].props = job.source
              deferred.delete(job.sourceId)
            }
        })
        // Failed creates have no layout to restore. An unacknowledged restoration stays protected.
        for (const id of deferred.keys()) if (!target.nodes[id]) deferred.delete(id)
        if (!deferred.size && target.recoveryRequired === layoutMarker) {
          delete target.recoveryRequired
          await checkpoint(state)
        }
      }
      // Every instance child uses a verified Master source-layer id, never a tree-position guess.
      const overrides: ComposeOp[] = []
      const overrideCommits: { id: string; indices: number[]; next: DesignNode["overrides"] }[] = []
      walk(root, (node) => {
        if (!node.component) return
        const instance = target.nodes[node.id],
          master = state.scopes[`component:${node.component}`]
        if (!instance || !master) return
        const previous = priorOverrides.get(node.id),
          next = node.overrides ?? []
        if (previous?.nativeId === instance.id && stable(previous.overrides) === stable(next))
          return
        const requested = next.map((o) => ({ ...o, props: { ...o.props } }))
        for (const old of previous?.overrides ?? []) {
          const current = requested.find(
            (o) =>
              o.sourceId === old.sourceId &&
              stable(o.instancePath ?? []) === stable(old.instancePath ?? []),
          )
          const missing = Object.keys(old.props).filter((k) => current?.props[k] === undefined)
          if (!missing.length) continue
          let sourceOwner = master
          for (const part of old.instancePath ?? []) {
            const placed = sourceOwner?.nodes[part]
            sourceOwner = placed?.component
              ? state.scopes[`component:${placed.component}`]
              : (undefined as any)
          }
          const defaults = sourceOwner?.nodes[old.sourceId]?.props ?? {}
          const reset = Object.fromEntries(
            missing.filter((k) => defaults[k] !== undefined).map((k) => [k, defaults[k]]),
          )
          if (Object.keys(reset).length) requested.push({ ...old, props: reset })
        }
        const indices: number[] = []
        for (const override of requested) {
          let owner = master,
            cloneId = instance.id
          for (const part of override.instancePath ?? []) {
            const placed = owner?.nodes[part]
            if (!placed?.component) {
              owner = undefined as any
              break
            }
            cloneId += `_${placed.id}`
            owner = state.scopes[`component:${placed.component}`]
          }
          const source = owner?.nodes[override.sourceId]
          if (!source) {
            report.notes.push(
              `${node.props.name}: override source ${override.sourceId} was not imported`,
            )
            failed = true
            continue
          }
          indices.push(overrides.length)
          overrides.push({
            tool: "layer_manage",
            input: {
              ...scope,
              action: "instance_override",
              layers: [{ id: `${cloneId}_${source.id}`, properties: override.props }],
            },
          })
        }
        overrideCommits.push({ id: node.id, indices, next })
      })
      if (overrides.length) {
        const result = await send(overrides)
        if (result.some((r) => !r.ok)) failed = true
        for (const c of overrideCommits)
          if (c.indices.every((i) => result[i]?.ok)) target.nodes[c.id].overrides = c.next
      }
      target.hash = !partial && !failed ? hash : ""
      await fingerprint(key, target)
      await checkpoint(state)
      if (!failed) (existed ? report.updated : report.created).push(label)
    } catch (error) {
      if (/fetch|network|connection lost|ambiguous|timeout|socket/i.test(String(error)))
        target.recoveryRequired =
          "An interrupted write may have created unlinked content. Inspect this import before retrying, or use Import as new to preserve it and create a separate copy."
      target.hash = ""
      report.errors.push(`${label}: ${String(error)}`)
      await fingerprint(key, target)
      await checkpoint(state)
    }
  }

  progress("Checking Studio compatibility…")
  await studio.compatibility()
  if (options.verifyOnly) {
    if (!Object.keys(state.scopes).length)
      report.notes.push("There are no saved imports for this connected Pie to verify.")
    for (const [key, scope] of Object.entries(state.scopes)) {
      cancelled()
      if (await preflight(key, scope))
        report.skipped.push(`${key}: verified; no Studio writes were sent`)
    }
    finishReport()
    return { state, report }
  }
  const catalog = await studio.tool("query_design_system", {
    include: ["fonts", "variables", "resources"],
  })
  const session = await studio.tool("studio_session_init", { include_op_kinds: false })
  let currentVariables: any[] = catalog.variables?.global ?? []
  const collisions: VariableCollision[] = options.newImport
    ? []
    : design.variables.flatMap((variable) => {
        const prior = state.variables[variable.id]
        if (prior && currentVariables.some((v) => v.id === prior.id)) return []
        const name =
          prior && (prior.sourceName ?? prior.name) === variable.name ? prior.name : variable.name
        const existing = currentVariables.find((v) => v.name === name)
        if (!existing) return []
        return [
          {
            sourceId: variable.id,
            sourceName: variable.name,
            sourceType: variable.dataType,
            sourceValue: variable.value,
            existing: {
              id: existing.id,
              name: existing.name,
              dataType: existing.dataType,
              value: existing.value,
            },
            canReuse: existing.dataType === variable.dataType && typeof existing.id === "string",
          },
        ]
      })
  let variableChoices: Record<string, VariableChoice> = {}
  if (collisions.length) {
    if (!options.resolveVariableCollisions) {
      report.variableCollisions = collisions
      report.conflicts.push(
        ...collisions.map(
          (c) =>
            `Variable ${c.sourceName}: an unlinked variable already uses this name. Choose Use existing, Create separate, or Skip before importing.`,
        ),
      )
      finishReport()
      return { state, report }
    }
    progress("Choose how to handle existing variables.")
    const choices = await options.resolveVariableCollisions(collisions)
    if (!choices || options.signal?.aborted) {
      report.notes.push("Import stopped before any changes were sent to Studio.")
      finishReport()
      return { state, report }
    }
    for (const collision of collisions) {
      const choice = choices[collision.sourceId]
      if (
        !["existing", "create", "skip"].includes(choice) ||
        (choice === "existing" && !collision.canReuse)
      )
        throw new Error(
          `Choose a valid action for variable ${collision.sourceName}. No changes were sent.`,
        )
    }
    variableChoices = choices
    const refreshed = await studio.tool("query_design_system", { include: ["variables"] })
    if (!Array.isArray(refreshed.variables?.global))
      throw new Error("Studio could not refresh the variable choices. No changes were sent.")
    currentVariables = refreshed.variables.global
    for (const collision of collisions)
      if (
        choices[collision.sourceId] === "existing" &&
        !currentVariables.some(
          (v) =>
            v.id === collision.existing.id &&
            v.name === collision.existing.name &&
            v.dataType === collision.sourceType,
        )
      )
        throw new Error(
          `Variable ${collision.sourceName} changed while you were choosing. Import again to review it. No changes were sent.`,
        )
  }
  cancelled()
  const fonts: string[] = catalog.availableFonts ?? []
  const fontDecisions = new Map<string, ReturnType<typeof resolveFont>>()
  for (const root of [...design.components.map((c) => c.root), ...design.units.map((u) => u.root)])
    walk(root, (node) => {
      if (node.type !== "TEXT" || typeof node.props.font !== "string") return
      const font = node.props.font
      const key = stable([font, node.font])
      const decision =
        fontDecisions.get(key) ?? resolveFont(font, node.font, fonts, options.fontFaces)
      fontDecisions.set(key, decision)
      node.props.font = decision.font
      if (decision.note) report.notes.push(`${node.props.name}: ${decision.note}`)
    })
  const validResources = new Set<string>((catalog.resources ?? []).map((r: any) => r.id))
  if (catalog.resources)
    for (const [key, id] of Object.entries(state.assets))
      if (!validResources.has(id)) delete state.assets[key]
  await studio.tool("start_editing")
  try {
    const frames = design.units.filter((u) => u.scene)
    if (frames.length && session.device) {
      const width = Math.max(...frames.map((u) => Number(u.root.props.width))),
        height = Math.max(...frames.map((u) => Number(u.root.props.height)))
      if (width !== session.device.width || height !== session.device.height) {
        if (
          options.fitCanvas &&
          Number.isFinite(width) &&
          Number.isFinite(height) &&
          width > 0 &&
          height > 0 &&
          width <= 20000 &&
          height <= 20000
        ) {
          for (const [key, scope] of Object.entries(state.scopes)) await preflight(key, scope)
          if (!unsafe.size)
            await send([
              {
                tool: "device_manage",
                input: {
                  action: "select",
                  device: { name: "Figma import", width, height, platform: "Web" },
                },
              },
            ])
        } else
          report.notes.push(
            `Selection size ${width}×${height}; Pie canvas ${session.device.width}×${session.device.height}. Enable 'Match canvas size' to resize all scenes.`,
          )
      }
      if (frames.some((f) => f.root.props.width !== width || f.root.props.height !== height))
        report.notes.push(
          "ProtoPie uses one canvas size for all scenes. Smaller imported frames retain their own bounds within that canvas.",
        )
    }
    // Studio still resolves an artboard for GLOBAL writes. Pin a live scene rather than
    // inheriting a component editor that may have been closed or deleted.
    const variableScene =
      session.scenes?.find((s: any) => s.id === session.currentSceneId)?.id ??
      session.scenes?.[0]?.id
    const unsafeVariables = new Set<string>()
    const occupiedNames = new Map<string, string>(currentVariables.map((v) => [v.name, v.id]))
    function variableName(base: string, ownId?: string) {
      let candidate = base,
        suffix = 2
      while (occupiedNames.has(candidate) && occupiedNames.get(candidate) !== ownId)
        candidate = `${base}_${suffix++}`
      return candidate
    }
    for (const variable of design.variables) {
      const prior = state.variables[variable.id]
      const current = prior ? currentVariables.find((v) => v.id === prior.id) : undefined
      const choice = variableChoices[variable.id]
      if (choice === "skip") {
        report.notes.push(
          `Variable ${variable.name}: skipped for this import. Its variable actions were not imported.`,
        )
        unsafeVariables.add(variable.id)
        continue
      }
      if (choice === "existing") {
        const collision = collisions.find((c) => c.sourceId === variable.id)!
        const existing = currentVariables.find((v) => v.id === collision.existing.id)!
        state.variables[variable.id] = {
          id: existing.id,
          name: existing.name,
          value: existing.value,
          sourceName: variable.name,
          dataType: variable.dataType,
          external: true,
        }
        report.notes.push(
          `Variable ${variable.name}: using the existing ProtoPie variable. Its value was preserved.`,
        )
        continue
      }
      if (prior?.external && choice !== "create") {
        if (!current || current.dataType !== variable.dataType) {
          report.conflicts.push(
            `Variable ${prior.name}: the chosen existing variable is missing or has an incompatible type. It was not changed.`,
          )
          unsafeVariables.add(variable.id)
          continue
        }
        state.variables[variable.id] = {
          ...prior,
          name: current.name,
          value: current.value,
          sourceName: variable.name,
          dataType: variable.dataType,
        }
        continue
      }
      if (
        current &&
        prior &&
        (current.value !== prior.value ||
          current.name !== prior.name ||
          current.dataType !== (prior.dataType ?? variable.dataType))
      ) {
        report.conflicts.push(
          `Variable ${prior.name}: ProtoPie changed since the last import. Its value, name, and type were preserved. Restore it in ProtoPie to resume syncing, or keep it unchanged.`,
        )
        unsafeVariables.add(variable.id)
        continue
      }
      const sourceName = prior?.sourceName ?? prior?.name
      const base = prior && sourceName === variable.name ? prior.name : variable.name
      const name = variableName(base, current?.id)
      if (
        current &&
        prior &&
        prior.value === variable.value &&
        name === prior.name &&
        current.dataType === variable.dataType
      ) {
        state.variables[variable.id] = {
          ...prior!,
          sourceName: variable.name,
          dataType: variable.dataType,
        }
        continue
      }
      const r = await send([
        {
          tool: "variable_manage",
          input: {
            ...(variableScene ? { sceneId: variableScene } : {}),
            action: current ? "batch_edit" : "batch_add",
            variables: [
              {
                ...(current ? { id: current.id } : {}),
                name,
                type: "GLOBAL",
                dataType: variable.dataType,
                value: variable.value,
              },
            ],
          },
        },
      ])
      const id = current?.id ?? r[0]?.value.variableId
      if (r[0]?.ok && id) {
        state.variables[variable.id] = {
          id,
          name,
          sourceName: variable.name,
          dataType: variable.dataType,
          value: variable.value,
        }
        if (current && current.name !== name) occupiedNames.delete(current.name)
        occupiedNames.set(name, id)
        if (name !== variable.name && (!prior || name !== prior.name))
          report.notes.push(
            `Variable ${variable.name}: ${current ? "renamed to" : "created as"} ${name} to keep the existing variable unchanged.`,
          )
      } else unsafeVariables.add(variable.id)
    }
    // Read affected scopes before changing shared masters, whose updates propagate to instances.
    const changedComponents = new Set(
      design.components
        .filter((c) => state.scopes[`component:${c.id}`]?.hash !== digest(c.root))
        .map((c) => c.id),
    )
    const dependents = new Map<string, Set<string>>()
    for (const [key, scope] of Object.entries(state.scopes))
      for (const node of Object.values(scope.nodes)) {
        if (!node.component) continue
        if (!dependents.has(node.component)) dependents.set(node.component, new Set())
        dependents.get(node.component)!.add(key)
      }
    const affected = new Map<string, Set<string>>()
    for (const id of changedComponents) {
      const scopes = new Set<string>(),
        queue = [id]
      if (state.scopes[`component:${id}`]) scopes.add(`component:${id}`)
      for (let index = 0; index < queue.length; index++)
        for (const key of dependents.get(queue[index]) ?? []) {
          if (scopes.has(key)) continue
          scopes.add(key)
          if (state.scopes[key].kind === "component") queue.push(key.slice("component:".length))
        }
      affected.set(id, scopes)
    }
    for (const key of new Set([...affected.values()].flatMap((scopes) => [...scopes])))
      await preflight(key, state.scopes[key])
    for (const [id, scopes] of affected) {
      const blocked = [...scopes].filter((key) => unsafe.has(key))
      if (!blocked.length) continue
      unsafe.add(`component:${id}`)
      scopeConflict(
        `Component ${id}: its update would affect protected content in ${blocked.join(", ")}. The master was preserved.`,
      )
    }
    for (const component of componentOrder(design.components))
      await syncScope(`component:${component.id}`, component.root, true)
    for (const unit of design.units) {
      let existingScope = Object.entries(state.scopes).find(
        ([, r]) => r.kind === "scene" && r.nodes[unit.id],
      )
      if (!existingScope && unit.parent)
        existingScope = Object.entries(state.scopes).find(
          ([, r]) => r.kind === "scene" && r.nodes[unit.parent!],
        )
      if (existingScope) {
        const [key, scope] = existingScope
        await syncScope(
          key,
          unit.root,
          false,
          scope.rootId !== unit.id,
          scope.nodes[unit.id]?.parent ?? unit.parent,
        )
      } else {
        const root = { ...unit.root, props: { ...unit.root.props, x: 0, y: 0 } }
        await syncScope(`scene:${unit.id}`, root, false)
      }
    }
    // Resolve links only after every scene, Master, and layer has a concrete id.
    const reactionSources = [
      ...design.components.map((c) => ({ root: c.root, key: `component:${c.id}` })),
      ...design.units.map((u) => ({
        root: u.root,
        key: Object.entries(state.scopes).find(([, r]) => r.kind === "scene" && r.nodes[u.id])?.[0],
      })),
    ]
    for (const source of reactionSources) {
      const key = source.key
      if (!key || unsafe.has(key) || !state.scopes[key]) continue
      const scope = state.scopes[key],
        route = scope.kind === "component" ? { artboardId: scope.id } : { sceneId: scope.id }
      const jobs: {
        key: string
        hash: string
        layerId: string
        trigger: string
        triggerProps: Properties
        props: Record<string, unknown>
      }[] = []
      const wanted = new Set<string>(),
        selected = new Set<string>()
      walk(source.root, (node) => {
        selected.add(node.id)
        for (const reaction of node.reactions ?? []) {
          wanted.add(reaction.key)
          const layer = scope.nodes[node.id]
          if (!layer) continue
          const destinationScope = reaction.destination
            ? Object.values(state.scopes).find(
                (s) => s.kind === "scene" && s.rootId === reaction.destination,
              )
            : undefined
          if (reaction.action === "navigate" && !destinationScope) {
            report.notes.push(
              `${node.props.name}: import its destination frame to enable this link`,
            )
            continue
          }
          if (reaction.action === "scroll") {
            report.notes.push(
              `${node.props.name}: scroll-to prototype actions are not translated; native scrolling containers are preserved`,
            )
            continue
          }
          const variable =
            reaction.destination && !unsafeVariables.has(reaction.destination)
              ? state.variables[reaction.destination]
              : undefined
          if (reaction.action === "variable" && (!variable || scope.kind === "component")) {
            report.notes.push(
              `${node.props.name}: this prototype variable is unavailable in its native scope`,
            )
            continue
          }
          const hash = digest({
            reaction,
            layer: layer.id,
            destination: destinationScope?.id,
            ...(reaction.action === "variable"
              ? { variable: { id: variable!.id, name: variable!.name } }
              : {}),
          })
          if (scope.reactions[reaction.key]?.hash === hash) continue
          const props: Record<string, unknown> = {
            ...reaction.props,
            responseType:
              reaction.action === "navigate"
                ? "jump_response"
                : reaction.action === "url"
                  ? "link_response"
                  : "assign_response",
          }
          if (destinationScope) props.sceneId = destinationScope.id
          if (reaction.action === "variable") {
            props.varName = variable!.name
            props.formula = JSON.stringify(reaction.props.value)
            delete props.value
          }
          jobs.push({
            key: reaction.key,
            hash,
            layerId: layer.id,
            trigger: reaction.trigger,
            triggerProps: { viewName: `F2P ${node.props.name}`, ...reaction.triggerProps },
            props,
          })
        }
      })
      const obsolete = Object.keys(scope.reactions).filter(
        (r) =>
          (!wanted.has(r) && [...selected].some((id) => r.startsWith(`${id}:`))) ||
          jobs.some((j) => j.key === r),
      )
      if (!jobs.length && !obsolete.length) continue
      if (!(await preflight(key, scope))) continue
      activeScope = scope
      try {
        if (obsolete.length)
          await send(
            obsolete.map((r) => ({
              tool: "trigger_manage",
              input: { ...route, action: "delete", triggerIdList: [scope.reactions[r].id] },
            })),
            (i, r) => {
              if (r.ok) delete scope.reactions[obsolete[i]]
            },
          )
        const ops: ComposeOp[] = [],
          commits = new Map<number, (r: OpResult) => void>()
        for (const job of jobs) {
          if (scope.reactions[job.key]) continue // A failed deletion must not create duplicate triggers.
          const op = name()
          ops.push({
            tool: "trigger_manage",
            name: op,
            input: {
              ...route,
              action: "batch_add",
              triggers: [
                {
                  triggerType: job.trigger,
                  ...(["start", "press"].includes(job.trigger)
                    ? {}
                    : { layerIdList: [job.layerId] }),
                  properties: job.triggerProps,
                },
              ],
            },
          })
          commits.set(ops.length - 1, (r) => {
            if (r.ok && r.value.triggerId)
              scope.reactions[job.key] = { id: r.value.triggerId, hash: "" }
          })
          ops.push({
            tool: "response_manage",
            input: {
              ...route,
              action: "batch_add",
              responses: [{ ownerId: `\${${op}.triggerId}`, properties: job.props }],
            },
          })
          commits.set(ops.length - 1, (r) => {
            if (r.ok && scope.reactions[job.key]) scope.reactions[job.key].hash = job.hash
          })
        }
        if (ops.length) await send(ops, (i, r) => commits.get(i)?.(r))
      } catch (error) {
        report.errors.push(`${key}: ${String(error)}`)
      }
      await fingerprint(key, scope)
      await checkpoint(state)
    }
    // Refresh only scopes whose previously verified appearance changed through a shared master.
    for (const [key, view] of views)
      if (!refreshed.has(key) && !unsafe.has(key) && view) await fingerprint(key, state.scopes[key])
    await checkpoint(state)
  } finally {
    await studio.tool("end_editing")
    finishReport()
  }
  return { state, report }
}
