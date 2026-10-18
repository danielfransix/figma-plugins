import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const assets = new Map([
  [
    "/fonts/plus-jakarta-sans.ttf",
    [new URL("../figma-plugin/fonts/plus-jakarta-sans.ttf", import.meta.url), "font/ttf"],
  ],
  ["/", [new URL("../figma-plugin/ui.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/ui.js", [new URL("../figma-plugin/ui.js", import.meta.url), "text/javascript; charset=utf-8"]],
])

export function createPanelServer() {
  return createServer(async (req, res) => {
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "")) {
      res.writeHead(403).end("Local helper only")
      return
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end()
      return
    }
    if (req.url === "/health") {
      res
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end('{"service":"figma-to-protopie-panel"}')
      return
    }
    const asset = assets.get(req.url)
    if (!asset) {
      res.writeHead(404).end("Not found")
      return
    }
    try {
      const content = await readFile(asset[0])
      res.writeHead(200, {
        "Content-Type": asset[1],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; connect-src http://127.0.0.1:* http://localhost:*",
      })
      res.end(req.method === "HEAD" ? undefined : content)
    } catch {
      res.writeHead(503).end("Build the plugin first: npm run build")
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPanelServer()
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? "Port 9983 is already in use. If this helper is already running, keep its existing window open."
        : error.message,
    )
    process.exitCode = 1
  })
  server.listen(9983, "127.0.0.1", () =>
    console.log(
      "Figma to ProtoPie helper ready. Keep this window open while importing.\nClose this window or press Ctrl+C to stop.",
    ),
  )
}
