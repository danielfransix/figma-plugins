import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { createHash } from "node:crypto"
import { zipSync } from "fflate"
const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const pkg = JSON.parse(await readFile("package.json", "utf8"))
const pluginId = option("--plugin-id")
if (pluginId && !/^\d+$/.test(pluginId))
  throw new Error("Use the numeric plugin ID assigned by Figma")
const withRuntime = args.includes("--with-runtime")
const label = `figma-to-protopie-${pkg.version}-${withRuntime ? `${process.platform}-${process.arch}` : "node-required"}${pluginId ? "" : "-dev"}`
const output = resolve(option("--output") ?? `dist/${label}.zip`)
const list = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "README.md",
  "Start-Plugin.cmd",
  "Start-Plugin.command",
  "figma-plugin/manifest.json",
  "figma-plugin/bootstrap.html",
  "figma-plugin/ui.html",
  "figma-plugin/fonts/plus-jakarta-sans.ttf",
  "figma-plugin/fonts/OFL.txt",
  "figma-plugin/code.js",
  "figma-plugin/ui.js",
  "scripts/local-ui.mjs",
  "scripts/doctor.mjs",
  "scripts/Start-ProtoPieAutoApprove.ps1",
  "scripts/Start-ProtoPieAutoApprove.cmd",
  "scripts/Start-ProtoPieAutoApprove.command",
  "docs/connection-permissions.md",
  "docs/installation.md",
  "docs/release-checklist.md",
  "docs/validation.md",
  "docs/studio-preview-issue.md",
]
const entries = {},
  checksums = {}
for (const path of list) {
  let bytes = await readFile(path)
  if (path === "figma-plugin/manifest.json" && pluginId)
    bytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes), id: pluginId }, null, 2))
  checksums[path] = createHash("sha256").update(bytes).digest("hex")
  entries[`${label}/${path}`] = [
    bytes,
    { os: 3, attrs: ((path.endsWith(".command") ? 0o100755 : 0o100644) << 16) >>> 0 },
  ]
}
let runtime
if (withRuntime) {
  const binary = await readFile(process.execPath),
    name = process.platform === "win32" ? "node.exe" : "node"
  let license
  if (option("--runtime-license")) license = await readFile(option("--runtime-license"))
  else {
    const response = await fetch(
      `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
      { signal: AbortSignal.timeout(20000) },
    )
    if (!response.ok)
      throw new Error(
        "Could not retrieve the exact Node runtime license. Supply --runtime-license with the matching upstream license file.",
      )
    license = Buffer.from(await response.text())
  }
  if (license.length < 1000 || !license.toString().includes("Node.js"))
    throw new Error("Invalid Node runtime license")
  entries[`${label}/runtime/${name}`] = [binary, { os: 3, attrs: (0o100755 << 16) >>> 0 }]
  entries[`${label}/runtime/LICENSE.txt`] = license
  runtime = {
    version: process.version,
    platform: process.platform,
    arch: process.arch,
    sha256: createHash("sha256").update(binary).digest("hex"),
  }
}
entries[`${label}/release-manifest.json`] = Buffer.from(
  JSON.stringify(
    {
      version: pkg.version,
      pluginId: pluginId ?? "development-placeholder",
      runtime,
      files: checksums,
    },
    null,
    2,
  ),
)
await mkdir(dirname(output), { recursive: true })
const archive = zipSync(entries, { level: 6 })
await writeFile(output, archive)
await writeFile(
  `${output}.sha256`,
  `${createHash("sha256").update(archive).digest("hex")}  ${output.split(/[\\/]/).pop()}\n`,
)
console.log(
  `${output}\n${(archive.length / 1024 / 1024).toFixed(2)} MB; ${Object.keys(entries).length} files; SHA-256 written.`,
)
if (!pluginId)
  console.log("Development candidate: register a Figma plugin ID before Community publication.")
