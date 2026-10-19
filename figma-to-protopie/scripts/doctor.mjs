import { readFile, access } from "node:fs/promises"
const root = new URL("../", import.meta.url)
let failures = 0
const say = (ok, label, detail) => {
  console.log(`${ok ? "OK" : "CHECK"} ${label}: ${detail}`)
  if (!ok) failures++
}
say(Number(process.versions.node.split(".")[0]) >= 20, "Node.js", process.version)
for (const name of ["figma-plugin/code.js", "figma-plugin/ui.js", "figma-plugin/bootstrap.html"]) {
  try {
    await access(new URL(name, root))
    say(true, name, "present")
  } catch {
    say(false, name, "run npm run build")
  }
}
const manifest = JSON.parse(await readFile(new URL("figma-plugin/manifest.json", root), "utf8"))
console.log(
  /^\d+$/.test(manifest.id)
    ? "OK Registered Figma plugin ID"
    : "NOTE Figma plugin ID is a development placeholder. Use the ID assigned by Figma before publishing.",
)
const endpoint = process.argv[2] ?? "http://127.0.0.1:9982/mcp"
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/mcp$/.test(endpoint))
  throw new Error("Use a local Studio endpoint")
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "doctor", method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(5000),
  })
  const text = await response.text()
  say(
    response.ok && text.includes("connect_studio"),
    "Studio MCP",
    response.ok ? "reachable; no approval requested" : `HTTP ${response.status}`,
  )
} catch (error) {
  say(false, "Studio MCP", `enable it in Studio > Preferences > Labs; ${error.message}`)
}
try {
  const response = await fetch("http://127.0.0.1:9983/health", {
      signal: AbortSignal.timeout(2000),
    }),
    health = await response.json()
  say(health.service === "figma-to-protopie-panel", "Local panel", "running")
} catch {
  console.log(
    "NOTE Local panel is stopped. Run Start-Plugin.cmd (Windows) or Start-Plugin.command (macOS).",
  )
}
process.exitCode = failures ? 1 : 0
