import {
  callTool,
  checkSchemaCompatibility,
  connectStudio,
  initializeSession,
  listContexts,
  type PieContext,
} from "./protopie-client"

export const DEFAULT_ENDPOINT = "http://127.0.0.1:9982/mcp"

export interface ApprovedConnection {
  endpoint: string
  connectionId: string
  contextId: string
  target?: string
}

export interface ConnectionSettings {
  endpoint: string
  connection: ApprovedConnection | null
  disconnected?: true
}

export function normalizeEndpoint(value: string): string {
  const match = /^http:\/\/(127\.0\.0\.1|localhost)(?::(\d{1,5}))?\/mcp$/i.exec(value.trim())
  if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
    throw new Error(
      "Use ProtoPie Studio's local HTTP address, for example http://127.0.0.1:9982/mcp.",
    )
  }
  return `http://${match[1].toLowerCase()}${match[2] ? `:${Number(match[2])}` : ""}/mcp`
}

export function readConnectionSettings(value: unknown): ConnectionSettings {
  const fallback = { endpoint: DEFAULT_ENDPOINT, connection: null }
  if (!value || typeof value !== "object") return fallback
  const settings = value as Partial<ConnectionSettings>
  try {
    const endpoint = normalizeEndpoint(settings.endpoint ?? DEFAULT_ENDPOINT)
    const c = settings.connection
    const connection =
      c &&
      c.endpoint === endpoint &&
      typeof c.connectionId === "string" &&
      c.connectionId.length > 0 &&
      typeof c.contextId === "string" &&
      c.contextId.length > 0
        ? {
            endpoint,
            connectionId: c.connectionId,
            contextId: c.contextId,
            ...(typeof c.target === "string" && c.target.length <= 4096
              ? { target: c.target }
              : {}),
          }
        : null
    return settings.disconnected === true
      ? { endpoint, connection: null, disconnected: true }
      : { endpoint, connection }
  } catch {
    return fallback
  }
}

export function isExpiredConnection(error: unknown): boolean {
  return error instanceof Error && /invalid or expired connectionId/i.test(error.message)
}

function meaningfulTitle(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.trim()
  return name && !/^(untitled(?: \d+)?|loading\.{0,3})$/i.test(name) ? name : null
}

export function contextDisplayName(context: PieContext): string | null {
  // Cloud Pies use a temporary cache path. Only a real .pie filename is a useful fallback.
  const file = context.filePath?.split(/[\\/]/).pop()
  if (file && /\.pie$/i.test(file)) return file.replace(/\.pie$/i, "") || null
  return meaningfulTitle(context.tabName)
}

async function verifyContext(
  endpoint: string,
  connectionId: string,
  context: PieContext,
  signal?: AbortSignal,
): Promise<PieContext> {
  // A grant is pinned to its approved Pie. Tab focus alone must never change the import target.
  const session = await callTool(
    endpoint,
    "studio_session_init",
    {
      connectionId,
      contextId: context.contextId,
      include_op_kinds: false,
    },
    signal,
  )
  const metadata = session?._context
  if (metadata?.contextId && metadata.contextId !== context.contextId)
    throw new Error("MCP_CONTEXT_MISMATCH: Studio returned a different Pie context.")
  return {
    ...context,
    ...(metadata?.contextId === context.contextId
      ? {
          ...(typeof metadata.tabName === "string" || metadata.tabName === null
            ? {
                tabName:
                  meaningfulTitle(metadata.tabName) ??
                  meaningfulTitle(context.tabName) ??
                  metadata.tabName,
              }
            : {}),
          ...(typeof metadata.filePath === "string" || metadata.filePath === null
            ? { filePath: metadata.filePath ?? context.filePath }
            : {}),
        }
      : {}),
  }
}

export async function acquireConnection(
  endpointValue: string,
  cached: ApprovedConnection | null,
  onApprovalNeeded: () => void,
  signal?: AbortSignal,
): Promise<{ connection: ApprovedConnection; context: PieContext; reused: boolean }> {
  const endpoint = normalizeEndpoint(endpointValue)
  await initializeSession(endpoint, signal)
  const compat = await checkSchemaCompatibility(endpoint, signal)
  if (!compat.ok)
    throw new Error(
      `ProtoPie Studio's MCP server is missing: ${compat.missing.join(", ")}. Update ProtoPie Studio or this plugin.`,
    )

  if (cached?.endpoint === endpoint) {
    try {
      const contexts = await listContexts(endpoint, cached.connectionId, signal)
      const context = contexts.find((c) => c.contextId === cached.contextId)
      if (context) {
        const verified = await verifyContext(endpoint, cached.connectionId, context, signal)
        return { connection: cached, context: verified, reused: true }
      }
    } catch (error) {
      // Network errors and target mismatches must not cause another approval prompt.
      if (!isExpiredConnection(error)) throw error
    }
  }

  signal?.throwIfAborted()
  onApprovalNeeded()
  const connectionId = await connectStudio(endpoint, signal)
  const contexts = await listContexts(endpoint, connectionId, signal)
  const context =
    contexts.find((c) => (c as PieContext & { isActiveTab?: boolean }).isActiveTab) ?? contexts[0]
  if (!context)
    throw new Error("No .pie file is open in ProtoPie Studio. Open one, then connect again.")
  const verified = await verifyContext(endpoint, connectionId, context, signal)
  return {
    connection: { endpoint, connectionId, contextId: context.contextId },
    context: verified,
    reused: false,
  }
}
