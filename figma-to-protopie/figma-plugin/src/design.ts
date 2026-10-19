export type Properties = Record<string, string | number | boolean>
export type LayerType = "RECT" | "OVAL" | "TEXT" | "IMAGE" | "CONTAINER" | "COMPONENT_INSTANCE"
export interface Asset {
  key: string
  mimeType: "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp"
  data: string
}
export interface FontRequest {
  family: string
  style: string
  weight?: number
  variationSettings?: Record<string, number>
}
export interface DesignNode {
  id: string
  type: LayerType
  props: Properties
  font?: FontRequest
  children: DesignNode[]
  asset?: string
  component?: string
  overrides?: { sourceId: string; instancePath?: string[]; props: Properties }[]
  reactions?: DesignReaction[]
}
export interface DesignReaction {
  key: string
  trigger: string
  triggerProps: Properties
  action: "navigate" | "url" | "scroll" | "variable"
  destination?: string
  props: Properties
}
export interface DesignUnit {
  id: string
  scene: boolean
  parent?: string
  root: DesignNode
}
export interface DesignComponent {
  id: string
  name: string
  root: DesignNode
}
export interface DesignVariable {
  id: string
  name: string
  dataType: "NUMBER" | "STRING" | "COLOR"
  value: string | number
}
export interface Design {
  version: 2
  units: DesignUnit[]
  components: DesignComponent[]
  assets: Asset[]
  variables: DesignVariable[]
  notes: string[]
}
export interface ReadFailure {
  stage: "figma-read" | "figma-export"
  message: string
  reason?: string
  node: {
    id: string
    name: string
    type: string
    path: string[]
    width: number
    height: number
    visible: boolean
    opacity: number
    renderBounds?: { x: number; y: number; width: number; height: number } | null
  }
}
export interface NodeRecord {
  id: string
  type: string
  props: Properties
  parent?: string
  asset?: string
  component?: string
  order?: string[]
  overrides?: DesignNode["overrides"]
}
export interface ScopeRecord {
  id: string
  kind: "scene" | "component"
  rootId?: string
  hash: string
  fingerprint: string
  nodes: Record<string, NodeRecord>
  reactions: Record<string, { id: string; hash: string }>
  children?: string[]
  recoveryRequired?: string
  verificationCandidates?: string[]
}
export interface ImportState {
  version: 2
  scopes: Record<string, ScopeRecord>
  assets: Record<string, string>
  variables: Record<
    string,
    {
      id: string
      value: string | number
      name: string
      sourceName?: string
      external?: true
      dataType?: DesignVariable["dataType"]
    }
  >
}
export function emptyState(): ImportState {
  return { version: 2, scopes: {}, assets: {}, variables: {} }
}
export function walk(
  root: DesignNode,
  visit: (node: DesignNode, parent?: DesignNode) => void,
  parent?: DesignNode,
): void {
  visit(root, parent)
  for (const child of root.children) walk(child, visit, root)
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as any)[k])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
export function digest(value: unknown): string {
  const input = typeof value === "string" ? value : stable(value)
  let a = 0x811c9dc5,
    b = 0x9e3779b9
  for (let i = 0; i < input.length; i++) {
    a = Math.imul(a ^ input.charCodeAt(i), 0x01000193)
    b = Math.imul(b ^ input.charCodeAt(i), 0x85ebca6b)
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0")
}
