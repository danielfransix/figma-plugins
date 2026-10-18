import { digest } from "../.compiled/design.mjs"
import { replaceReferences } from "../.compiled/batch.mjs"
export class FakeStudio {
  nodes = new Map()
  scenes = new Map()
  components = new Map()
  variables = new Map()
  assets = new Map()
  triggers = new Map()
  operations = []
  serial = 0
  failName = null
  locked = false
  id() {
    return `N${++this.serial}`
  }
  async compatibility() {}
  async tool(name, args = {}) {
    if (name === "start_editing") {
      this.locked = true
      return {}
    }
    if (name === "end_editing") {
      this.locked = false
      return {}
    }
    if (name === "studio_session_init") return { scenes: [] }
    if (name === "query_design_system")
      return {
        availableFonts: ["Inter"],
        variables: { global: [...this.variables.values()] },
        resources: [...this.assets.keys()].map((id) => ({ id })),
      }
    if (name === "resolve_ids")
      return {
        results: args.ids.map((id) => ({
          id,
          referenceCount: [...this.nodes.values()].filter((n) => n.props.componentId === id).length,
        })),
      }
    throw new Error(`Unexpected tool ${name}`)
  }
  async view(id, component) {
    if (!this.scenes.has(id) && !this.components.has(id)) throw new Error("Target is missing")
    const nodes = [...this.nodes.values()].filter((n) => n.scope === id)
    const tree = nodes.map((n) => ({
      id: n.id,
      name: n.props.name,
      type: n.type,
      bbox: [n.props.x ?? 0, n.props.y ?? 0, n.props.width ?? 0, n.props.height ?? 0],
    }))
    if (component) {
      const root = this.components.get(id).root
      tree.sort((a, b) => (a.id === root ? -1 : b.id === root ? 1 : 0))
    }
    const interactions = [...this.triggers.values()].filter((t) => t.scope === id)
    return { tree, interactions, fingerprint: digest({ nodes, interactions }) }
  }
  remove(id) {
    for (const n of [...this.nodes.values()]) if (n.parent === id) this.remove(n.id)
    this.nodes.delete(id)
  }
  async write(operations) {
    if (!this.locked) throw new Error("Expected editing lock")
    const known = new Map(),
      results = []
    for (const raw of operations) {
      const op = replaceReferences(raw, known),
        p = op.input
      this.operations.push(op)
      let r
      if (p.action !== "batch_add" && p.layers?.[0]?.properties?.name === this.failName)
        r = { success: false, errors: [{ error: "Injected layer failure" }] }
      else if (op.tool === "scene_manage") {
        const sceneId = this.id()
        this.scenes.set(sceneId, p.scenes[0].properties)
        r = { sceneId, sceneIds: [sceneId] }
      } else if (op.tool === "component_manage") {
        const componentId = this.id(),
          root = this.id()
        this.components.set(componentId, { root })
        this.nodes.set(root, {
          id: root,
          type: "CONTAINER",
          scope: componentId,
          props: { name: p.properties.name },
        })
        r = { componentId }
      } else if (op.tool === "resource_manage") {
        const resourceId = this.id()
        this.assets.set(resourceId, p)
        r = { resourceId }
      } else if (op.tool === "variable_manage") {
        const v = p.variables[0],
          id = v.id ?? this.id()
        this.variables.set(id, { ...v, id })
        r = { variableId: id }
      } else if (op.tool === "layer_manage") {
        const scope = p.artboardId ?? p.sceneId
        if (p.action === "batch_add") {
          const createdLayers = [],
            errors = []
          for (const [index, item] of p.layers.entries()) {
            if (item.properties.name === this.failName) {
              errors.push({ index, error: "Injected layer failure" })
              continue
            }
            const layerId = this.id()
            this.nodes.set(layerId, {
              id: layerId,
              type: item.layerType,
              scope,
              parent: item.parentId,
              props: { ...item.properties },
            })
            createdLayers.push({ id: layerId })
          }
          r = {
            createdLayers,
            errors,
            failedCount: errors.length,
            layerId: createdLayers[0]?.id,
            layerIds: createdLayers.map((n) => n.id),
          }
        } else if (p.action === "batch_edit") {
          for (const item of p.layers) {
            const n = this.nodes.get(item.id)
            if (!n) throw new Error(`Missing layer ${item.id}`)
            Object.assign(n.props, item.properties)
          }
          r = { success: true }
        } else if (p.action === "delete") {
          p.layerIdList.forEach((id) => this.remove(id))
          r = { success: true }
        } else if (p.action === "reorder") {
          if (p.newParentId) this.nodes.get(p.layerIdList[0]).parent = p.newParentId
          r = { success: true }
        } else if (p.action === "instance_override") {
          r = { success: true }
        }
      } else if (op.tool === "trigger_manage") {
        if (p.action === "delete") {
          p.triggerIdList.forEach((id) => this.triggers.delete(id))
          r = { success: true }
        } else {
          const triggerId = this.id()
          this.triggers.set(triggerId, {
            triggerId,
            scope: p.sceneId,
            ...p.triggers[0],
            directResponses: [],
          })
          r = { triggerId }
        }
      } else if (op.tool === "response_manage") {
        const responseId = this.id(),
          response = p.responses[0]
        this.triggers.get(response.ownerId).directResponses.push({ responseId, ...response })
        r = { responseId }
      }
      if (!r) throw new Error(`Unexpected op ${op.tool}/${p.action}`)
      results.push(r)
      if (op.name) known.set(op.name, r)
    }
    return { results, failureCount: results.filter((r) => r.success === false).length }
  }
}
export function fixture() {
  const node = (id, type, props = {}, children = []) => ({
    id,
    type,
    props: { name: id, x: 0, y: 0, width: 100, height: 40, ...props },
    children,
  })
  const button = node("button", "RECT", { fillColor: "#222222" })
  const root = node("screen", "CONTAINER", { width: 390, height: 844 }, [button])
  return {
    design: {
      version: 2,
      units: [{ id: root.id, scene: true, root }],
      components: [],
      assets: [],
      variables: [],
      notes: [],
    },
    node,
    button,
    root,
  }
}
