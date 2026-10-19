import { test } from "node:test"
import assert from "node:assert/strict"
import { createPanelServer, readFontCatalog } from "../scripts/local-ui.mjs"
import { request } from "node:http"
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises"
import { runInNewContext } from "node:vm"

test("the local helper serves panel assets and font metadata; it has no proxy or write endpoints", async (t) => {
  const server = createPanelServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const health = await fetch(`${base}/health`)
  assert.deepEqual(await health.json(), { service: "figma-to-protopie-panel" })
  const panel = await fetch(base)
  assert.equal(panel.status, 200)
  assert.match(panel.headers.get("content-security-policy"), /connect-src http:\/\/127\.0\.0\.1:\*/)
  assert.match(await panel.text(), /id="run-btn"/)
  assert.equal((await fetch(`${base}/ui.js`)).status, 200)
  assert.match(panel.headers.get("content-security-policy"), /font-src 'self'/)
  const font = await fetch(`${base}/fonts/plus-jakarta-sans.ttf`)
  assert.equal(font.headers.get("content-type"), "font/ttf")
  assert.equal(Buffer.from(await font.arrayBuffer()).readUInt32BE(0), 0x00010000)
  assert.equal((await fetch(`${base}/fonts/other.ttf`)).status, 404)
  assert.equal((await fetch(`${base}/package.json`)).status, 404)
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status, 405)
  const status = await new Promise((resolve, reject) => {
    request(base, { headers: { Host: "example.com" } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
      .on("error", reject)
      .end()
  })
  assert.equal(status, 403)
})

test("the font catalog exposes only face metadata, without font files or filesystem paths", async (t) => {
  const dir = new URL("../.scratch-qa/", import.meta.url),
    file = new URL("font-catalog-input.json", dir)
  await mkdir(dir, { recursive: true })
  await writeFile(
    file,
    JSON.stringify([
      {
        family: "Gilroy SemiBold",
        style: "Regular",
        postscriptName: "Gilroy-SemiBold",
        weight: 600,
        italic: false,
        path: "C:/private/font.ttf",
        installedType: "system",
      },
      { family: "Bad", weight: null },
    ]),
  )
  t.after(() => unlink(file))
  const server = createPanelServer({ fontCatalogFile: file })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/font-catalog`
  const response = await fetch(url),
    result = await response.json()
  assert.deepEqual(result, {
    available: true,
    fonts: [
      {
        family: "Gilroy SemiBold",
        style: "Regular",
        postscriptName: "Gilroy-SemiBold",
        weight: 600,
        italic: false,
      },
    ],
  })
  assert.equal(JSON.stringify(result).includes("private"), false)
  assert.equal((await fetch(url, { method: "POST" })).status, 405)
  assert.equal((await fetch(url, { method: "HEAD" })).status, 200)
})
test("missing or invalid Studio font metadata returns an honest unavailable catalog", async () => {
  assert.deepEqual(
    await readFontCatalog(new URL("./fixtures/not-a-font-catalog.json", import.meta.url)),
    { fonts: [], available: false },
  )
  assert.deepEqual(
    await readFontCatalog(new URL("./fixtures/step-label-source.json", import.meta.url)),
    { fonts: [], available: false },
  )
})

test("the bootstrap forwards only its own local panel and Figma parent messages", async () => {
  const html = await readFile(new URL("../figma-plugin/bootstrap.html", import.meta.url), "utf8")
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
  let handler
  const toFigma = []
  const toPanel = []
  const host = { parent: null }
  const parent = { parent: host, postMessage: (...args) => toFigma.push(args) }
  const contentWindow = { postMessage: (...args) => toPanel.push(args) }
  const panel = { contentWindow, style: {}, addEventListener: () => {} }
  const root = { classList: { contains: () => false } }
  runInNewContext(script, {
    document: { getElementById: () => panel, documentElement: root, head: {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    MutationObserver: class {
      observe() {}
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    window: {
      addEventListener: (name, fn) => {
        handler = fn
      },
    },
    parent,
  })
  const data = { pluginMessage: { type: "load-connection-settings" } }
  handler({ source: {}, origin: "http://localhost:9983", data })
  handler({ source: contentWindow, origin: "https://example.com", data })
  assert.equal(toFigma.length, 0)
  handler({ source: contentWindow, origin: "http://localhost:9983", data })
  assert.equal(toFigma.length, 1)
  assert.equal(toFigma[0][0].pluginMessage, data.pluginMessage)
  assert.equal(toPanel.shift()[0].figmaTheme.colorScheme, "light")
  handler({ source: parent, origin: "https://www.figma.com", data })
  assert.equal(toPanel.length, 1)
  handler({ source: host, origin: "https://www.figma.com", data })
  assert.equal(toPanel.length, 2, "Figma may reply from above its immediate sandbox parent")
  handler({ source: host, origin: "https://example.com", data })
  handler({ source: {}, origin: "https://www.figma.com", data })
  assert.equal(toPanel.length, 2, "untrusted origins and unrelated windows must stay blocked")
  assert.equal(toPanel[0][1], "http://localhost:9983")
  assert.equal(panel.style.visibility, "visible")
})
