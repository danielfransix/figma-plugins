import { applyPatch } from "./.compiled/checkpoint.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdir } from "node:fs/promises"
import { chromium } from "playwright"
import { createPanelServer } from "../scripts/local-ui.mjs"
import { FakeStudio, fixture } from "./fixtures/studio.mjs"
import { encode, decode } from "fast-png"
import { readDesign } from "./.compiled/read-design.mjs"
const preview = Buffer.from(
  encode({ width: 1, height: 1, channels: 4, data: new Uint8Array([255, 255, 255, 255]) }),
).toString("base64")

test("browser panel: opaque bootstrap, localhost transport, saved links, and zero-write re-import", async (t) => {
  const server = createPanelServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 440, height: 720 } })
  await page.exposeFunction("qaApplyPatch", (state, patch) => applyPatch(state, patch))
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  const fake = new FakeStudio(),
    tools = [
      "connect_studio",
      "describe_ops",
      "compose_pie",
      "start_editing",
      "end_editing",
      "list_contexts",
      "studio_session_init",
    ]
  let approvals = 0,
    reportedTitle = "Browser QA",
    reportedPath = null,
    holdApproval,
    holdSession,
    failSession = false,
    holdWrite
  await page.route("http://127.0.0.1:9982/mcp", async (route) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "text/event-stream",
    }
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers })
      return
    }
    const body = route.request().postDataJSON()
    let result = {}
    if (body.method === "tools/list") result = { tools: tools.map((name) => ({ name })) }
    else if (body.method === "tools/call") {
      const { name, arguments: args } = body.params
      let value
      if (name === "studio_session_init" && failSession) {
        await route.fulfill({
          status: 200,
          headers,
          body: `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Studio connection failed" }] } })}\n\n`,
        })
        return
      }
      if (name === "connect_studio") {
        approvals++
        if (holdApproval) await holdApproval()
        value = { success: true, connectionId: "grant" }
      } else if (name === "list_contexts")
        value = {
          contexts: [
            { contextId: "pie", tabName: reportedTitle, filePath: reportedPath, isActiveTab: true },
          ],
        }
      else if (name === "studio_session_init") {
        if (holdSession) await holdSession()
        value = {
          scenes: [],
          _context: { contextId: args.contextId, tabName: reportedTitle, filePath: reportedPath },
        }
      } else if (name === "describe_ops")
        value = {
          details:
            "batch_add batch_edit instance_override font CONTAINER add artboardId triggerId jump_response SMART add_inline resourceId GLOBAL",
        }
      else if (name === "compose_pie") {
        if (holdWrite) await holdWrite()
        value = await fake.write(args.operations)
      } else if (name === "inspect_layout")
        value = await fake.view(args.sceneId ?? args.artboardId, !!args.artboardId)
      else if (name === "query_interactions") value = { interactions: [] }
      else if (name === "capture_preview" || name === "preview_components") {
        result = {
          content: [{ type: "image", data: preview, mimeType: "image/png" }],
        }
      } else value = await fake.tool(name, args)
      if (value !== undefined) result = { content: [{ type: "text", text: JSON.stringify(value) }] }
    }
    await route
      .fulfill({
        status: 200,
        headers,
        body: `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
      })
      .catch((error) => {
        if (!route.request().failure()) throw error
      })
  })
  const bootstrap = (
    await readFile(new URL("../figma-plugin/bootstrap.html", import.meta.url), "utf8")
  )
    .replaceAll("http://localhost:9983", origin)
    .replace(
      "<head>",
      `<head><style>:root { --figma-color-bg: #fafafa; --figma-color-text: #202020; }</style>`,
    )
  await page.setContent(
    `<iframe id="plugin" title="Figma plugin" style="border:0;width:400px;height:680px"></iframe>`,
  )
  await page.evaluate(
    ({ html, design }) => {
      // Reproduce Figma's nested wrappers: outbound messages are relayed by the
      // immediate parent, but host replies go directly to the opaque plugin frame.
      const shell = document.getElementById("plugin")
      const wrapper = shell.contentDocument.createElement("iframe")
      shell.contentDocument.body.style.cssText = "margin:0;height:100vh"
      wrapper.style.cssText = "border:0;width:100%;height:100%"
      shell.contentDocument.body.appendChild(wrapper)
      const plugin = wrapper.contentDocument.createElement("iframe")
      wrapper.contentDocument.body.style.cssText = "margin:0;height:100vh"
      plugin.style.cssText = "border:0;width:100%;height:100%"
      wrapper.contentDocument.body.appendChild(plugin)
      wrapper.contentWindow.addEventListener("message", (event) => {
        if (event.source === plugin.contentWindow) window.postMessage(event.data, "*")
      })
      let state = { version: 2, scopes: {}, assets: {}, variables: {} }
      const qa = (window.qa = {
        settings: { endpoint: "http://127.0.0.1:9982/mcp", connection: null },
        loads: 0,
        state,
        design,
        failSave: false,
        readFailure: null,
        reopen: () => {
          plugin.src = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
        },
      })
      window.addEventListener("message", async (event) => {
        const m = event.data?.pluginMessage
        if (!m) return
        const reply = (data) => plugin.contentWindow.postMessage({ pluginMessage: data }, "*")
        if (m.type === "load-connection-settings") {
          qa.loads++
          reply({
            type: "connection-settings",
            settings: qa.settings,
          })
          reply({ type: "selection", count: 1 })
        } else if (m.type === "save-connection-settings") {
          if (qa.failSave) {
            qa.failSave = false
            reply({ type: "error", requestId: m.requestId, message: "Storage unavailable" })
          } else {
            qa.settings = m.settings
            reply({ type: "connection-settings-saved", requestId: m.requestId })
          }
        } else if (m.type === "run") {
          if (m.fresh) state = { version: 2, scopes: {}, assets: {}, variables: {} }
          qa.lastRun = m
          if (qa.readFailure)
            reply({ type: "error", message: qa.readFailure.message, diagnostic: qa.readFailure })
          else
            reply({
              type: "design",
              checkpointSession: `qa-${Date.now()}`,
              checkpointProtocol: 2,
              checkpointReset: m.fresh,
              design: m.verifyOnly
                ? { version: 2, units: [], components: [], assets: [], variables: [], notes: [] }
                : qa.design,
              state: m.fresh ? { version: 2, scopes: {}, assets: {}, variables: {} } : state,
            })
        } else if (m.type === "compact-checkpoints") {
          reply({ type: "persisted", requestId: m.requestId })
        } else if (m.type === "persist") {
          state = m.patch ? await window.qaApplyPatch(state, m.patch) : m.state
          qa.state = state
          reply({ type: "persisted", requestId: m.requestId })
        }
      })
      plugin.src = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    },
    { html: bootstrap, design: fixture().design },
  )
  const bootstrapFrame = page.frameLocator("#plugin").frameLocator("iframe").frameLocator("iframe")
  const panel = bootstrapFrame.frameLocator("#panel")
  await panel.locator("#status-text").filter({ hasText: "Connected:" }).waitFor()
  await panel.locator("body").evaluate(async () => document.fonts.ready)
  assert.equal(
    await panel.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(250, 250, 250)",
  )
  assert.equal(
    await panel.locator("body").evaluate(() => document.fonts.check('11px "Plus Jakarta Sans"')),
    true,
  )
  await bootstrapFrame.locator("html").evaluate((root) => {
    root.className = "figma-dark"
    root.style.setProperty("--figma-color-bg", "#292929")
    root.style.setProperty("--figma-color-text", "#ffffff")
  })
  await panel.locator('html[style*="dark"]').waitFor()
  assert.equal(
    await panel.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(41, 41, 41)",
  )
  assert.equal(
    await panel.locator("body").evaluate((el) => getComputedStyle(el).color),
    "rgb(255, 255, 255)",
  )
  await panel.locator("summary").click()
  assert.equal(await panel.locator("#clip-truncated-text").isChecked(), true)
  await panel.locator("#clip-truncated-text").uncheck()
  assert.equal(await panel.locator("#create-components").isChecked(), true)
  await panel.locator("#shared-components").check()
  await panel.locator("#create-components").uncheck()
  assert.equal(await panel.locator("#shared-components").isDisabled(), true)
  let releaseSession, sessionStarted
  const sessionReady = new Promise((resolve) => (sessionStarted = resolve))
  holdSession = () => {
    sessionStarted()
    return new Promise((resolve) => (releaseSession = resolve))
  }
  assert.equal(await panel.locator("#import-timer").isHidden(), true)
  await panel.locator("#run-btn").click()
  await sessionReady
  assert.equal(await panel.locator("#clip-truncated-text").isDisabled(), true)
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "running")
  assert.equal(await panel.locator("#import-timer-status").textContent(), "Elapsed")
  await page.waitForTimeout(1200)
  assert.notEqual(
    await panel.locator("#import-duration").textContent(),
    "00:00",
    "time includes the connection wait",
  )
  holdSession = null
  releaseSession()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "completed")
  assert.equal(await panel.locator("#import-timer-status").textContent(), "Completed in")
  const completedClock = await panel.locator("#import-duration").textContent()
  await page.waitForTimeout(1100)
  assert.equal(
    await panel.locator("#import-duration").textContent(),
    completedClock,
    "completed duration stays frozen",
  )
  assert.equal(await page.evaluate(() => window.qa.lastRun.createComponents), false)
  assert.equal(await page.evaluate(() => window.qa.lastRun.clipTruncatedText), false)
  await panel.locator("#clip-truncated-text").check()
  await panel.locator("#create-components").check()
  assert.equal(await panel.locator("#shared-components").isEnabled(), true)
  await panel.locator("#shared-components").uncheck()
  await panel.locator("summary").click()
  assert.match(await panel.locator("#group-created").innerText(), /screen/)
  assert.equal(await panel.locator("#group-errors").getAttribute("hidden"), "")
  await panel.locator("#run-btn").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.match(await panel.locator("#metrics").textContent(), /0 write batches/)
  assert.equal(await page.evaluate(() => window.qa.lastRun.clipTruncatedText), true)
  assert.equal(approvals, 1, "imports should reuse the initial permission")
  reportedTitle = "Playground 1"
  await panel.locator("#connect-btn").click()
  await panel.locator("#status-text").filter({ hasText: "Connected: Playground 1" }).waitFor()
  await panel.locator("#run-btn").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.match(
    await panel.locator("#metrics").textContent(),
    /0 write batches/,
    "renaming a Pie must preserve its import links",
  )
  assert.equal(approvals, 1)
  // A missing baseline is reported honestly; retrying verification uses no source export or writes.
  await page.evaluate(() => {
    window.qa.trustedFingerprint = window.qa.state.scopes["scene:screen"].fingerprint
    window.qa.state.scopes["scene:screen"].fingerprint = ""
  })
  const beforeVerification = fake.operations.length
  await panel.locator("#run-btn").click()
  await panel.locator("#group-verification:not([hidden])").waitFor()
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "blocked")
  assert.equal(await panel.locator("#group-conflicts").isHidden(), true)
  assert.equal(await panel.locator("#group-errors").isHidden(), true)
  await page.evaluate(() => {
    window.qa.state.scopes["scene:screen"].verificationCandidates = [window.qa.trustedFingerprint]
  })
  await panel.locator("#verify-btn").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.equal(await page.evaluate(() => window.qa.lastRun.verifyOnly), true)
  assert.equal(fake.operations.length, beforeVerification)
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "completed")
  assert.match(await panel.locator("#metrics").textContent(), /^Verification.*0 write batches/)
  // Updates preserve an interrupted-write marker; the explicit fresh action creates
  // a separate scene and returns subsequent runs to normal updates.
  await page.evaluate(() => {
    window.qa.state.scopes["scene:screen"].recoveryRequired =
      "A write was in progress when the plugin closed."
  })
  const beforeRecovery = fake.operations.length
  const previousScene = await page.evaluate(() => window.qa.state.scopes["scene:screen"].id)
  await panel.locator("#run-btn").click()
  await panel.locator("#retry-new:not([hidden])").waitFor()
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "blocked")
  assert.equal(fake.operations.length, beforeRecovery)
  assert.match(await panel.locator("#metrics").textContent(), /^Update.*0 write batches/)
  await panel.locator("#retry-new-btn").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.match(await panel.locator("#metrics").textContent(), /^New import/)
  assert.equal(await panel.locator("#group-conflicts").isHidden(), true)
  assert.equal(await panel.locator("#retry-new").isHidden(), true)
  assert.notEqual(
    await page.evaluate(() => window.qa.state.scopes["scene:screen"].id),
    previousScene,
  )
  assert.ok(fake.scenes.has(previousScene), "a fresh import must preserve the earlier prototype")
  assert.equal(await panel.locator("#force-fresh").isChecked(), false)
  const afterRecovery = fake.operations.length
  await panel.locator("#run-btn").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.match(await panel.locator("#metrics").textContent(), /^Update.*0 write batches/)
  assert.equal(fake.operations.length, afterRecovery)
  fake.variables.set("manual-variable", {
    id: "manual-variable",
    name: "F2P_BrowserCount",
    dataType: "NUMBER",
    value: 1,
  })
  await page.evaluate(() => {
    window.qa.design.variables = [
      { id: "browser-count", name: "F2P_BrowserCount", dataType: "NUMBER", value: 1 },
    ]
  })
  const beforeVariableChoice = fake.operations.length
  await panel.locator("#run-btn").click()
  await panel.locator("#variable-decisions:not([hidden])").waitFor()
  assert.equal(fake.operations.length, beforeVariableChoice)
  assert.equal(fake.locked, false)
  assert.equal(await panel.locator("#variable-continue").isDisabled(), true)
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "running")
  await mkdir(".scratch-qa", { recursive: true })
  for (const width of [320, 400]) {
    await page
      .locator("#plugin")
      .evaluate((frame, width) => (frame.style.width = `${width}px`), width)
    for (const theme of ["light", "dark"]) {
      await bootstrapFrame
        .locator("html")
        .evaluate((root, theme) => (root.className = `figma-${theme}`), theme)
      await panel.locator("#variable-continue").scrollIntoViewIfNeeded()
      const geometry = await panel.locator("#variable-choice-0").evaluate((input) => {
        const select = input.getBoundingClientRect(),
          icon = input.nextElementSibling.getBoundingClientRect()
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          inset: select.right - icon.right,
          center: Math.abs(select.y + select.height / 2 - icon.y - icon.height / 2),
        }
      })
      assert.equal(geometry.overflow, false)
      assert.equal(geometry.inset, 10)
      assert.ok(geometry.center < 0.5)
      await page.screenshot({ path: `.scratch-qa/variable-choice-${width}-${theme}.png` })
    }
  }
  await panel.locator("#variable-cancel").click()
  await panel.locator('#import-timer[data-outcome="cancelled"]').waitFor()
  assert.equal(fake.operations.length, beforeVariableChoice)
  await panel.locator("#run-btn").click()
  await panel.locator("#variable-decisions:not([hidden])").waitFor()
  await panel.locator("#variable-choice-0").selectOption("create")
  await panel.locator("#variable-continue").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.equal(await panel.locator("#group-conflicts").isHidden(), true)
  assert.equal(await panel.locator("#retry-new").isHidden(), true)
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "completed")
  assert.match(await panel.locator("#group-unsupported").textContent(), /F2P_BrowserCount_2/)
  const ownedVariable = await page.evaluate(() => window.qa.state.variables["browser-count"])
  fake.variables.get(ownedVariable.id).value = 99
  await panel.locator("#run-btn").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.match(await panel.locator("#group-conflicts").textContent(), /Restore it in ProtoPie/)
  assert.equal(
    await panel.locator("#retry-new").isHidden(),
    true,
    "variable-only conflicts must not suggest a fresh import",
  )
  assert.equal(fake.variables.get("manual-variable").value, 1)
  assert.equal(fake.variables.get(ownedVariable.id).value, 99)
  fake.variables.get(ownedVariable.id).value = 1
  fake.variables.set("reuse-variable", {
    id: "reuse-variable",
    name: "F2P_ReuseCount",
    dataType: "NUMBER",
    value: 8,
  })
  await page.evaluate(() => {
    window.qa.design.variables.push({
      id: "reuse-count",
      name: "F2P_ReuseCount",
      dataType: "NUMBER",
      value: 1,
    })
  })
  const beforeReuse = fake.variables.size
  await panel.locator("#run-btn").click()
  await panel.locator("#variable-decisions:not([hidden])").waitFor()
  await panel.locator("#variable-choice-0").selectOption("existing")
  await panel.locator("#variable-continue").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.equal(fake.variables.size, beforeReuse)
  assert.equal(fake.variables.get("reuse-variable").value, 8)
  assert.equal(await page.evaluate(() => window.qa.state.variables["reuse-count"].external), true)
  fake.variables.get("reuse-variable").value = 22
  await panel.locator("#run-btn").click()
  await panel.locator("#report:not([hidden])").waitFor()
  assert.equal(await panel.locator("#variable-decisions").isHidden(), true)
  assert.equal(fake.variables.get("reuse-variable").value, 22)
  assert.match(await panel.locator("#metrics").textContent(), /0 write batches/)
  await page.evaluate(() => {
    window.qa.design.variables = []
  })
  reportedTitle = "Untitled"
  await panel.locator("#connect-btn").click()
  await panel
    .locator("#status-text")
    .filter({ hasText: /^Connected to ProtoPie$/ })
    .waitFor()
  assert.equal(await panel.locator("#connection-name-note").isVisible(), true)
  assert.equal(
    await panel.locator("#connection-name-note").textContent(),
    "ProtoPie hasn't provided this tab's name.",
  )
  reportedPath = "C:\\Cache\\.~pie-123.tmp"
  await panel.locator("#connect-btn").click()
  await panel.locator("#connection-name-note").filter({ hasText: "Cloud tab's name" }).waitFor()
  assert.equal(await panel.locator("#status-text").textContent(), "Connected to ProtoPie")
  assert.equal(approvals, 1, "missing Cloud titles must not request another approval")
  reportedPath = null
  reportedTitle = "Playground 1"
  await panel.locator("#connect-btn").click()
  await panel.locator("#status-text").filter({ hasText: "Connected: Playground 1" }).waitFor()
  assert.equal(await panel.locator("#connection-name-note").isHidden(), true)
  failSession = true
  await panel.locator("#run-btn").click()
  await panel.locator('#import-timer[data-outcome="failed"]').waitFor()
  assert.equal(await panel.locator("#status-text").textContent(), "Studio connection failed")
  assert.equal(await panel.locator("#import-timer-status").textContent(), "Failed after")
  failSession = false
  await panel.locator("#connect-btn").click()
  await panel.locator("#status-text").filter({ hasText: "Connected: Playground 1" }).waitFor()
  const failure = {
    stage: "figma-export",
    message: 'Cannot export "Search icon" (VECTOR, icon:42): Figma exporter failed',
    reason: "vector or unsupported primitive VECTOR",
    node: {
      id: "icon:42",
      name: "Search icon",
      type: "VECTOR",
      path: ["Employees", "Search icon"],
      width: 24,
      height: 24,
      visible: true,
      opacity: 1,
    },
  }
  await page.evaluate((value) => {
    window.qa.readFailure = value
  }, failure)
  const writesBefore = fake.operations.length
  await panel.locator("#run-btn").click()
  await panel.locator("#group-errors").filter({ hasText: "Search icon" }).waitFor()
  assert.equal(await panel.locator("#metrics").textContent(), "")
  assert.equal(await panel.locator("#group-skipped").isHidden(), true)
  const downloaded = page.waitForEvent("download")
  await panel.locator("#download-report").click()
  const diagnostic = JSON.parse(await readFile(await (await downloaded).path(), "utf8"))
  assert.equal(diagnostic.design, null, "a failed read must not export the previous selection")
  assert.equal(diagnostic.report, null, "a failed read must not export the previous result")
  assert.deepEqual(diagnostic.failure, failure)
  assert.equal(diagnostic.live.outcome, "failed")
  assert.ok(Number.isFinite(diagnostic.live.elapsedMilliseconds))
  assert.equal(await panel.locator("#import-timer-status").textContent(), "Failed after")
  assert.deepEqual(diagnostic.connection, {
    contextId: "pie",
    tabName: "Playground 1",
    filePath: null,
  })
  assert.equal(JSON.stringify(diagnostic).includes('"connectionId"'), false)
  assert.equal(fake.operations.length, writesBefore, "a failed Figma read must not write to Studio")
  await page.evaluate(() => {
    window.qa.readFailure = null
  })
  await panel.locator("#disconnect-btn").click()
  await panel
    .locator("#status-text")
    .filter({ hasText: /^Disconnected$/ })
    .waitFor()
  assert.equal(await panel.locator("#run-btn").isDisabled(), true)
  assert.equal(await page.evaluate(() => window.qa.settings.connection), null)
  const loads = await page.evaluate(() => window.qa.loads)
  await page.evaluate(() => window.qa.reopen())
  await page.waitForFunction((before) => window.qa.loads > before, loads)
  await panel
    .locator("#status-text")
    .filter({ hasText: /^Disconnected$/ })
    .waitFor()
  assert.equal(approvals, 1, "reopening after Disconnect must not request approval")
  await panel.locator("#connect-btn").click()
  await panel.locator("#status-text").filter({ hasText: "Connected:" }).waitFor()
  assert.equal(approvals, 2)
  assert.equal(await panel.locator("#status-text").textContent(), "Connected: Playground 1")

  await page.evaluate(() => {
    window.qa.failSave = true
  })
  await panel.locator("#disconnect-btn").click()
  await panel.locator("#status-text").filter({ hasText: "could not forget" }).waitFor()
  assert.equal(await panel.locator("#run-btn").isDisabled(), true)
  assert.equal(await panel.locator("#disconnect-btn").isEnabled(), true)
  await panel.locator("#disconnect-btn").click()
  await panel
    .locator("#status-text")
    .filter({ hasText: /^Disconnected$/ })
    .waitFor()

  let releaseApproval, approvalStarted
  const approvalReady = new Promise((resolve) => (approvalStarted = resolve))
  holdApproval = () => {
    approvalStarted()
    return new Promise((resolve) => (releaseApproval = resolve))
  }
  await panel.locator("#connect-btn").click()
  await approvalReady
  await panel.locator("#disconnect-btn").click()
  await panel
    .locator("#status-text")
    .filter({ hasText: /^Disconnected$/ })
    .waitFor()
  holdApproval = null
  releaseApproval()
  assert.equal(await page.evaluate(() => window.qa.settings.connection), null)

  await panel.locator("#connect-btn").click()
  await panel.locator("#status-text").filter({ hasText: "Connected:" }).waitFor()
  await page.evaluate(() => {
    window.qa.design.units[0].root.children[0].props.width = 170
  })
  let releaseWrite, writeStarted
  const writeReady = new Promise((resolve) => (writeStarted = resolve))
  holdWrite = () => {
    writeStarted()
    return new Promise((resolve) => (releaseWrite = resolve))
  }
  await panel.locator("#run-btn").click()
  await writeReady
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "running")
  const activeDownload = page.waitForEvent("download")
  await panel.locator("#download-report").click()
  const activeDiagnostic = JSON.parse(await readFile(await (await activeDownload).path(), "utf8"))
  assert.equal(activeDiagnostic.live.busy, true)
  assert.equal(activeDiagnostic.live.outcome, "running")
  assert.ok(activeDiagnostic.design)
  assert.ok(activeDiagnostic.live.pendingStudioCalls.some((call) => call.name === "compose_pie"))
  assert.equal(JSON.stringify(activeDiagnostic).includes('"connectionId"'), false)
  assert.equal(await panel.locator("#live-auto-layout").isDisabled(), true)
  assert.equal(await panel.locator("#create-components").isDisabled(), true)
  assert.equal(await panel.locator("#import-scope").isDisabled(), true)
  assert.equal(await panel.locator("#fit-canvas").isDisabled(), true)
  await panel.locator("#disconnect-btn").click()
  assert.notEqual(
    await page.evaluate(() => window.qa.settings.connection),
    null,
    "finish and persist the in-flight batch first",
  )
  assert.equal(
    await panel.locator("#import-timer").getAttribute("data-outcome"),
    "running",
    "disconnect waits for the native batch before stopping the timer",
  )
  holdWrite = null
  releaseWrite()
  await panel
    .locator("#status-text")
    .filter({ hasText: /^Disconnected$/ })
    .waitFor()
  assert.equal(fake.locked, false)
  assert.equal(await panel.locator("#import-timer").getAttribute("data-outcome"), "cancelled")
  assert.equal(await panel.locator("#import-timer-status").textContent(), "Stopped after")
  const stoppedClock = await panel.locator("#import-duration").textContent()
  await page.waitForTimeout(1100)
  assert.equal(await panel.locator("#import-duration").textContent(), stoppedClock)
  assert.equal(await panel.locator("#import-scope").isEnabled(), true)
  assert.equal(await panel.locator("#fit-canvas").isEnabled(), true)
  const saved = await page.evaluate(() => window.qa.state.scopes["scene:screen"].nodes.button)
  assert.equal(saved.props.width, 170)
  assert.equal(fake.nodes.get(saved.id).props.width, 170)
  assert.equal(await page.evaluate(() => window.qa.settings.disconnected), true)
  assert.equal(await page.evaluate(() => window.qa.settings.connection), null)
  assert.deepEqual(errors, [])
  await mkdir(".scratch-qa", { recursive: true })
  await page.screenshot({ path: ".scratch-qa/panel-qa.png" })
})

test("recorded grouped logo renders at its Figma position and preserves fractional glyph sizes", async (t) => {
  const source = JSON.parse(
    await readFile(new URL("./fixtures/grouped-logo-source.json", import.meta.url), "utf8"),
  )
  function hydrate(n, parent) {
    n.parent = parent
    n.fills = []
    n.strokes = []
    n.effects = []
    n.exportAsync = async () => n.svg
    for (const child of n.children ?? []) hydrate(child, n)
  }
  hydrate(source, { type: "PAGE", id: "page" })
  const design = await readDesign(
    { mixed: Symbol("mixed"), variables: { getLocalVariablesAsync: async () => [] } },
    [source],
    undefined,
    { createComponents: false, liveAutoLayout: true },
  )
  const assets = new Map(design.assets.map((a) => [a.key, a]))
  const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  function render(n) {
    const p = n.props
    return `<div style="position:absolute;left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px;transform-origin:0 0;transform:rotate(${p.rotation}deg)">${n.asset ? `<img style="display:block;width:100%;height:100%" src="${uri(assets.get(n.asset).data)}">` : n.children.map(render).join("")}</div>`
  }
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 600, height: 100 },
    deviceScaleFactor: 2,
  })
  await page.setContent(
    `<style>body{display:flex;gap:16px;margin:0}.art{position:relative;width:256px;height:64px;background:#004af5}</style><div class="art"><img width="256" height="64" src="${uri(source.referenceSvg)}"></div><div class="art">${render(design.units[0].root.children[0])}</div>`,
  )
  await page
    .locator("img")
    .evaluateAll(async (images) => await Promise.all(images.map((image) => image.decode())))
  const masks = []
  for (const element of await page.locator(".art").all()) {
    const pixels = decode(await element.screenshot())
    let left = Infinity,
      top = Infinity,
      right = 0,
      bottom = 0,
      weight = 0
    for (let y = 0; y < pixels.height; y++)
      for (let x = 0; x < pixels.width; x++) {
        const red = pixels.data[(y * pixels.width + x) * pixels.channels]
        weight += red
        if (red > 128) {
          left = Math.min(left, x)
          top = Math.min(top, y)
          right = Math.max(right, x)
          bottom = Math.max(bottom, y)
        }
      }
    masks.push({ left, top, right, bottom, weight })
  }
  for (const edge of ["left", "top", "right", "bottom"])
    assert.ok(Math.abs(masks[0][edge] - masks[1][edge]) <= 1, `logo ${edge} differs from Figma`)
  // Separate SVG images have slightly different edge compositing from a single SVG export.
  assert.ok(
    Math.abs(masks[0].weight - masks[1].weight) / masks[0].weight < 0.05,
    "glyph coverage must not shrink with rounded SVG viewports",
  )
})
