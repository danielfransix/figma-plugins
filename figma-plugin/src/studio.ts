import { callTool, callToolContent, type ComposeOp } from "./protopie-client"
import { digest, stable } from "./design"
import { visualSignature } from "./visual"

export interface TreeNode {
  id: string
  name: string
  type: string
  bbox: number[]
  children?: TreeNode[]
  hints?: Record<string, any>
  sourceLayerId?: string
  parentComponentLayerId?: string
}
export interface ScopeView {
  tree: TreeNode[]
  interactions: any[]
  fingerprint: string
}
export interface StudioSession {
  endpoint: string
  connectionId: string
  contextId: string
}
export interface ToolMetric {
  calls: number
  milliseconds: number
}
export class Studio {
  readonly metrics: Record<string, ToolMetric> = {}
  readonly pending = new Map<number, { name: string; started: number }>()
  private requestSerial = 0
  private async measured<T>(name: string, task: () => Promise<T>): Promise<T> {
    const started = performance.now()
    const id = ++this.requestSerial
    this.pending.set(id, { name, started })
    try {
      return await task()
    } finally {
      this.pending.delete(id)
      const metric = (this.metrics[name] ??= { calls: 0, milliseconds: 0 })
      metric.calls++
      metric.milliseconds += performance.now() - started
    }
  }
  private checked = false
  readonly session: StudioSession
  constructor(session: StudioSession) {
    this.session = {
      endpoint: session.endpoint,
      connectionId: session.connectionId,
      contextId: session.contextId,
    }
  }
  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.measured(name, () =>
      callTool(this.session.endpoint, name, {
        connectionId: this.session.connectionId,
        contextId: this.session.contextId,
        ...args,
      }),
    )
  }
  async write(operations: ComposeOp[], confirm = false): Promise<any> {
    return this.tool("compose_pie", { operations, ...(confirm ? { confirm: true } : {}) })
  }
  async componentRoot(id: string): Promise<TreeNode | undefined> {
    const layout = await this.tool("inspect_layout", {
      artboardId: id,
      outputTree: true,
      treeDepth: 1,
      checks: [],
    })
    return layout.tree?.[0]
  }
  async view(id: string, component = false, image = true): Promise<ScopeView> {
    const scope = component ? { artboardId: id } : { sceneId: id }
    const layout = await this.tool("inspect_layout", { ...scope, outputTree: true, checks: [] })
    const interactions = await this.tool("query_interactions", {
      ...scope,
      include_properties: true,
    })
    const tree: TreeNode[] = layout.tree ?? []
    function truncated(nodes: TreeNode[]): boolean {
      return nodes.some((n) => n.hints?.hasMoreChildren || truncated(n.children ?? []))
    }
    if (truncated(tree) || layout.truncated)
      throw new Error(
        "Studio truncated the layer tree. Split this import into smaller frames before updating it safely.",
      )
    let pixels: string[] = []
    if (image) {
      const previewTool = component ? "preview_components" : "capture_preview"
      const content = await this.measured(previewTool, () =>
        callToolContent(this.session.endpoint, previewTool, {
          connectionId: this.session.connectionId,
          contextId: this.session.contextId,
          ...(component ? { targets: [{ id, source: "currentPie" }] } : { sceneId: id }),
        }),
      )
      const images = content.filter((b: any) => b.type === "image")
      if (!images.length)
        throw new Error(
          "Studio could not produce a visual baseline. No existing content was overwritten.",
        )
      pixels = visualSignature(images.map((b: any) => b.data))
    }
    return {
      tree,
      interactions: interactions.interactions ?? [],
      fingerprint: `pixels2:${digest(stable({ tree, interactions: interactions.interactions ?? [] }))}:${pixels.join(".")}`,
    }
  }
  async compatibility(): Promise<void> {
    if (this.checked) return
    const required: Record<string, string[]> = {
      layer_manage: ["batch_add", "batch_edit", "instance_override", "font", "CONTAINER"],
      component_manage: ["add", "artboardId"],
      scene_manage: ["batch_add", "batch_edit"],
      trigger_manage: ["batch_add", "triggerId"],
      response_manage: ["jump_response", "SMART"],
      resource_manage: ["add_inline", "resourceId"],
      variable_manage: ["batch_add", "GLOBAL"],
    }
    for (const [op, fields] of Object.entries(required)) {
      const description = await this.tool("describe_ops", { op, contextId: undefined })
      const text = JSON.stringify(description)
      const missing = fields.filter((field) => !text.includes(field))
      if (missing.length)
        throw new Error(
          `Unsupported Studio schema: ${op} is missing ${missing.join(", ")}. Update the plugin or Studio before importing.`,
        )
    }
    this.checked = true
  }
}
export function flattenTree(nodes: TreeNode[]): Map<string, TreeNode> {
  const result = new Map<string, TreeNode>()
  function visit(items: TreeNode[]) {
    for (const n of items) {
      result.set(n.id, n)
      visit(n.children ?? [])
    }
  }
  visit(nodes)
  return result
}
