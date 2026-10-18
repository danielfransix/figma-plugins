import { test } from "node:test"
import assert from "node:assert/strict"
import {
  acquireConnection,
  contextDisplayName,
  normalizeEndpoint,
  readConnectionSettings,
} from "./.compiled/connection.mjs"

import { rpcCall } from "./.compiled/protopie-client.mjs"

const endpoint = "http://127.0.0.1:9982/mcp"
const cached = { endpoint, connectionId: "existing-grant", contextId: "approved-pie" }
const approved = { contextId: "approved-pie", tabName: "Approved Pie", isActiveTab: false }
const focused = { contextId: "other-pie", tabName: "Other Pie", isActiveTab: true }
const tools = [
  "connect_studio",
  "describe_ops",
  "compose_pie",
  "start_editing",
  "end_editing",
  "list_contexts",
  "studio_session_init",
]

function mockStudio(t, respond) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, ...body })
    let result = {}
    if (body.method === "tools/list") result = { tools: tools.map((name) => ({ name })) }
    if (body.method === "tools/call") {
      const response = respond(body.params.name, body.params.arguments)
      result = {
        content: [{ type: "text", text: JSON.stringify(response.value) }],
        isError: response.error ?? false,
      }
      if (response.error) result.content[0].text = response.error
    }
    return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`)
  })
  return calls
}

function normalResponse(name, args) {
  if (name === "connect_studio") {
    assert.deepEqual(args, {}, "connect_studio has no input properties")
    return { value: { success: true, connectionId: "new-grant" } }
  }
  if (name === "list_contexts") return { value: { contexts: [approved, focused] } }
  if (name === "studio_session_init")
    return { value: { _context: { contextId: args.contextId }, scenes: [] } }
  throw new Error(`Unexpected tool ${name}`)
}

test("reopening reuses the grant without approval and keeps the approved Pie despite a tab switch", async (t) => {
  const calls = mockStudio(t, normalResponse)
  const result = await acquireConnection(endpoint, cached, () => assert.fail("must not prompt"))
  assert.equal(result.reused, true)
  assert.deepEqual(result.connection, cached)
  assert.equal(result.context.contextId, approved.contextId)
  assert.equal(calls.filter((c) => c.params?.name === "connect_studio").length, 0)
  assert.equal(
    calls.find((c) => c.params?.name === "studio_session_init").params.arguments.contextId,
    approved.contextId,
  )
})

test("first use requests approval once and validates the focused Pie", async (t) => {
  const calls = mockStudio(t, normalResponse)
  let prompts = 0
  const result = await acquireConnection(endpoint, null, () => prompts++)
  assert.equal(prompts, 1)
  assert.equal(result.reused, false)
  assert.equal(result.connection.contextId, focused.contextId)
  assert.equal(calls.filter((c) => c.params?.name === "connect_studio").length, 1)
})

test("an expired grant requests a replacement once", async (t) => {
  mockStudio(t, (name, args) => {
    if (args.connectionId === cached.connectionId)
      return {
        error:
          "Invalid or expired connectionId. Call connect_studio and obtain user approval again.",
      }
    return normalResponse(name, args)
  })
  let prompts = 0
  const result = await acquireConnection(endpoint, cached, () => prompts++)
  assert.equal(prompts, 1)
  assert.equal(result.connection.connectionId, "new-grant")
})

test("a network failure does not trigger another approval", async (t) => {
  mockStudio(t, () => {
    throw new Error("Network unavailable")
  })
  await assert.rejects(
    acquireConnection(endpoint, cached, () => assert.fail("must not prompt")),
    /Network unavailable/,
  )
})

test("a pinned-context mismatch is surfaced without asking for a new grant", async (t) => {
  mockStudio(t, (name, args) =>
    name === "studio_session_init" ? { error: "MCP_CONTEXT_MISMATCH" } : normalResponse(name, args),
  )
  await assert.rejects(
    acquireConnection(endpoint, cached, () => assert.fail("must not prompt")),
    /MCP_CONTEXT_MISMATCH/,
  )
})

test("changing endpoints never sends the previous endpoint's grant", async (t) => {
  const calls = mockStudio(t, normalResponse)
  await acquireConnection("http://127.0.0.1:9983/mcp", cached, () => {})
  assert.ok(calls.every((c) => c.params?.arguments?.connectionId !== cached.connectionId))
})

test("a closed approved Pie requests a fresh connection instead of silently choosing another tab", async (t) => {
  mockStudio(t, (name, args) =>
    name === "list_contexts" ? { value: { contexts: [focused] } } : normalResponse(name, args),
  )
  let prompts = 0
  const result = await acquireConnection(endpoint, cached, () => prompts++)
  assert.equal(prompts, 1)
  assert.equal(result.reused, false)
})

test("a denied approval is surfaced without retry loops", async (t) => {
  const calls = mockStudio(t, () => ({ error: "Connection not approved in ProtoPie Studio" }))
  await assert.rejects(
    acquireConnection(endpoint, null, () => {}),
    /not approved/,
  )
  assert.equal(calls.filter((c) => c.params?.name === "connect_studio").length, 1)
})

test("only local MCP addresses can receive a stored grant", () => {
  for (const address of [
    "https://example.com/mcp",
    "http://127.0.0.1.example.com/mcp",
    "http://user:pass@localhost/mcp",
    "http://localhost:70000/mcp",
    "http://localhost:0/mcp",
    "http://localhost/mcp?redirect=x",
  ]) {
    assert.throws(() => normalizeEndpoint(address), /local HTTP/)
  }
  assert.equal(normalizeEndpoint(" http://LOCALHOST:09982/mcp "), "http://localhost:9982/mcp")
})

test("corrupt or mismatched local settings discard the grant", () => {
  assert.deepEqual(readConnectionSettings(null), { endpoint, connection: null })
  assert.deepEqual(readConnectionSettings({ endpoint, connection: cached }), {
    endpoint,
    connection: cached,
  })
  assert.equal(
    readConnectionSettings({ endpoint: "http://localhost:9982/mcp", connection: cached })
      .connection,
    null,
  )
  assert.equal(
    readConnectionSettings({ endpoint: "http://example.com/mcp", connection: cached }).connection,
    null,
  )
})

test("an explicit disconnect discards any grant and survives settings normalization", () => {
  const settings = readConnectionSettings({ endpoint, connection: cached, disconnected: true })
  assert.deepEqual(settings, { endpoint, connection: null, disconnected: true })
  assert.deepEqual(readConnectionSettings(JSON.parse(JSON.stringify(settings))), settings)
})

test("cancelling an approval request never proceeds with a late grant", async (t) => {
  const controller = new AbortController()
  const calls = mockStudio(t, (name, args) => {
    if (name === "connect_studio") controller.abort()
    return normalResponse(name, args)
  })
  await assert.rejects(
    acquireConnection(endpoint, null, () => {}, controller.signal),
    { name: "AbortError" },
  )
  assert.equal(calls.filter((call) => call.params?.name === "list_contexts").length, 0)
})

test("a refreshed session name replaces a stale list_contexts title on the same approved Pie", async (t) => {
  mockStudio(t, (name, args) =>
    name === "studio_session_init"
      ? {
          value: {
            _context: { contextId: args.contextId, tabName: "Playground 1", filePath: null },
          },
        }
      : name === "list_contexts"
        ? { value: { contexts: [{ ...approved, tabName: "Untitled" }, focused] } }
        : normalResponse(name, args),
  )
  const result = await acquireConnection(endpoint, cached, () => assert.fail("must not prompt"))
  assert.equal(contextDisplayName(result.context), "Playground 1")
  assert.equal(result.connection.contextId, cached.contextId)
  assert.equal(result.reused, true)
})

test("a saved filename is used when Studio's tab title is still Untitled", () => {
  assert.equal(
    contextDisplayName({
      contextId: "pie",
      tabName: "Untitled",
      filePath: "C:\\Designs\\Playground 1.pie",
    }),
    "Playground 1",
  )
  assert.equal(
    contextDisplayName({
      contextId: "pie",
      tabName: "Old name",
      filePath: "/Designs/New name.pie",
    }),
    "New name",
  )
})

test("temporary cloud cache paths and placeholder titles are not presented as current names", () => {
  assert.equal(
    contextDisplayName({
      contextId: "pie",
      tabName: "Untitled",
      filePath: "C:\\Cache\\.~pie-123.tmp",
    }),
    null,
  )
  assert.equal(
    contextDisplayName({
      contextId: "pie",
      tabName: "Playground 1",
      filePath: "/Cache/.~pie-123.tmp",
    }),
    "Playground 1",
  )
  assert.equal(contextDisplayName({ contextId: "pie", tabName: "  " }), null)
})

test("session metadata cannot change the approved context while refreshing its title", async (t) => {
  mockStudio(t, (name, args) =>
    name === "studio_session_init"
      ? { value: { _context: { contextId: focused.contextId, tabName: "Playground 1" } } }
      : normalResponse(name, args),
  )
  await assert.rejects(
    acquireConnection(endpoint, cached, () => assert.fail("must not prompt")),
    /MCP_CONTEXT_MISMATCH/,
  )
})

test("a stalled Studio call has a bounded deadline and writes report an uncertain outcome", async (t) => {
  const keepAlive = setTimeout(() => {}, 1000)
  t.after(() => clearTimeout(keepAlive))
  t.mock.method(
    globalThis,
    "fetch",
    (_url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        })
      }),
  )
  await assert.rejects(
    rpcCall(endpoint, { method: "tools/call", params: { name: "compose_pie" } }, undefined, 10),
    /Studio request timeout.*write outcome is uncertain/,
  )
})

test("an explicit cancellation is preserved instead of being mislabeled as a timeout", async (t) => {
  const controller = new AbortController()
  t.mock.method(
    globalThis,
    "fetch",
    (_url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        })
        controller.abort()
      }),
  )
  await assert.rejects(rpcCall(endpoint, { method: "tools/list" }, controller.signal, 1000), {
    name: "AbortError",
  })
})

test("a placeholder session title never replaces a usable listed name or saved path", async (t) => {
  mockStudio(t, (name, args) =>
    name === "studio_session_init"
      ? { value: { _context: { contextId: args.contextId, tabName: "Untitled", filePath: null } } }
      : name === "list_contexts"
        ? {
            value: {
              contexts: [
                { ...approved, tabName: "Playground 1", filePath: "C:\\Designs\\Playground 1.pie" },
                focused,
              ],
            },
          }
        : normalResponse(name, args),
  )
  const result = await acquireConnection(endpoint, cached, () => assert.fail("must not prompt"))
  assert.equal(result.context.tabName, "Playground 1")
  assert.equal(contextDisplayName(result.context), "Playground 1")
  assert.equal(result.connection.contextId, cached.contextId)
})
