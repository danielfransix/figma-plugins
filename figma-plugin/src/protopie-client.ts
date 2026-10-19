// A plain, deterministic JSON-RPC client for ProtoPie Studio's local MCP server. No AI model
// anywhere in this file - every call here is a fixed JSON body built by code the caller controls.
// Uses the global `fetch`, so this module runs unchanged in the plugin's UI iframe (which has
// network access) and in a plain Node script (Node 20+ has native fetch) - the same client is what
// drives the automated QA tests against the live endpoint, without Figma involved at all.

export interface ComposeOp {
  tool: string
  input: Record<string, unknown>
  name?: string
}

function deadline(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
export async function rpcCall(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMilliseconds?: number,
): Promise<any> {
  signal?.throwIfAborted()
  const name = (body.params as any)?.name
  const milliseconds =
    timeoutMilliseconds ??
    (name === "connect_studio" ? 180000 : name === "compose_pie" ? 90000 : 20000)
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: deadline(signal, milliseconds),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Studio HTTP ${res.status}: ${text.slice(0, 200)}`)
    if (text.trim().startsWith("{")) return JSON.parse(text)
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"))
    const lastData = dataLines[dataLines.length - 1]
    if (!lastData)
      throw new Error(`No MCP response body (HTTP ${res.status}): ${text.slice(0, 300)}`)
    return JSON.parse(lastData.slice(5))
  } catch (error) {
    if (!signal?.aborted && error instanceof Error && error.name === "TimeoutError")
      throw new Error(
        `Studio request timeout: ${name ?? body.method} did not respond within ${Math.round(milliseconds / 1000)} seconds. ${name === "compose_pie" ? "Its write outcome is uncertain; inspect the partial import before retrying." : "Studio may still be processing an earlier request."}`,
      )
    throw error
  }
}

function extractToolResult(rpcResponse: any): { text: string; isError: boolean } {
  if (rpcResponse.error) throw new Error(rpcResponse.error.message || "MCP transport error")
  const result = rpcResponse.result
  const block = result?.content?.[0]
  return { text: block?.text ?? "", isError: !!result?.isError }
}

export async function initializeSession(endpoint: string, signal?: AbortSignal): Promise<void> {
  await rpcCall(
    endpoint,
    {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "figma-to-protopie", version: "0.3.4" },
      },
    },
    signal,
  )
  signal?.throwIfAborted()
  await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: deadline(signal, 20000),
  })
}

export async function listToolNames(endpoint: string, signal?: AbortSignal): Promise<string[]> {
  const res = await rpcCall(
    endpoint,
    {
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
      params: {},
    },
    signal,
  )
  if (res.error) throw new Error(res.error.message || "tools/list failed")
  return (res.result?.tools ?? []).map((t: { name: string }) => t.name)
}

const REQUIRED_TOOLS = [
  "connect_studio",
  "describe_ops",
  "compose_pie",
  "start_editing",
  "end_editing",
  "list_contexts",
  "studio_session_init",
]

export async function checkSchemaCompatibility(
  endpoint: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; missing: string[] }> {
  const names = await listToolNames(endpoint, signal)
  const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t))
  return { ok: missing.length === 0, missing }
}

let callCounter = 0
export async function callTool(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  callCounter += 1
  const res = await rpcCall(
    endpoint,
    {
      jsonrpc: "2.0",
      id: `call-${callCounter}`,
      method: "tools/call",
      params: { name, arguments: args },
    },
    signal,
  )
  const { text, isError } = extractToolResult(res)
  if (isError) throw new Error(text)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function callToolContent(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any[]> {
  callCounter += 1
  const res = await rpcCall(endpoint, {
    jsonrpc: "2.0",
    id: `content-${callCounter}`,
    method: "tools/call",
    params: { name, arguments: args },
  })
  if (res.error) throw new Error(res.error.message)
  if (res.result?.isError)
    throw new Error(
      res.result.content?.find((b: any) => b.type === "text")?.text ?? "Studio tool failed",
    )
  return res.result?.content ?? []
}

export async function connectStudio(endpoint: string, signal?: AbortSignal): Promise<string> {
  const result = await callTool(endpoint, "connect_studio", {}, signal)
  if (!result.success) throw new Error("ProtoPie Studio did not approve the connection.")
  return result.connectionId as string
}

export interface PieContext {
  contextId: string
  filePath?: string | null
  tabName?: string | null
}

export async function listContexts(
  endpoint: string,
  connectionId: string,
  signal?: AbortSignal,
): Promise<PieContext[]> {
  const result = await callTool(endpoint, "list_contexts", { connectionId }, signal)
  return (result.contexts ?? result) as PieContext[]
}

export async function startEditing(
  endpoint: string,
  connectionId: string,
  contextId: string,
): Promise<void> {
  await callTool(endpoint, "start_editing", { connectionId, contextId })
}

export async function endEditing(
  endpoint: string,
  connectionId: string,
  contextId: string,
): Promise<void> {
  await callTool(endpoint, "end_editing", { connectionId, contextId })
}

export async function composePie(
  endpoint: string,
  connectionId: string,
  contextId: string,
  operations: ComposeOp[],
): Promise<any> {
  return callTool(endpoint, "compose_pie", { connectionId, contextId, operations })
}

export async function describeOp(
  endpoint: string,
  connectionId: string,
  op?: string,
): Promise<any> {
  return callTool(endpoint, "describe_ops", op ? { connectionId, op } : { connectionId })
}
