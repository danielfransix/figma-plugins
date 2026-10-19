import { checkpointTracker } from "./checkpoint"
import {
  acquireConnection,
  contextDisplayName,
  readConnectionSettings,
  type ApprovedConnection,
  type ConnectionSettings,
} from "./connection"
import {
  importDesign,
  type ImportReport,
  type VariableCollision,
  type VariableChoice,
} from "./importer"
import { Studio } from "./studio"
import { emptyState, type Design, type ImportState, type ReadFailure } from "./design"
import type { PieContext } from "./protopie-client"
function element<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T
}
const endpoint = element<HTMLInputElement>("endpoint"),
  status = element("status-text"),
  run = element<HTMLButtonElement>("run-btn"),
  connectButton = element<HTMLButtonElement>("connect-btn"),
  disconnectButton = element<HTMLButtonElement>("disconnect-btn")
const progress = element("progress"),
  note = element("first-run-note"),
  stop = element<HTMLButtonElement>("stop-btn")
let cached: ApprovedConnection | null = null,
  studio: Studio | null = null,
  target = "",
  busy = false,
  connecting = false,
  selectionCount = 0,
  ready = false
let manuallyDisconnected = false,
  disconnecting = false,
  forgetFailed = false,
  connectionAttempt: AbortController | null = null
let cancellation = new AbortController(),
  requestId = 0,
  runStarted = 0,
  runFresh = false,
  runVerification = false,
  connectionMilliseconds = 0,
  previousTarget = ""
let linkSaveMilliseconds = 0,
  linkSaveBytes = 0,
  linkSaveCount = 0
let figmaReadMilliseconds: number | null = null
let linkSaveProtocol: "incremental-journal" | "legacy-snapshot" = "legacy-snapshot"
let choosingVariables = false
let currentContext: PieContext | null = null
let lastDesign: Design | null = null,
  lastReport: ImportReport | null = null
let lastFailure: ReadFailure | { stage: "figma-read" | "protopie-import"; message: string } | null =
  null
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
const settingsTimeout = setTimeout(() => {
  if (!ready) status.textContent = "Figma did not respond. Close and reopen this plugin."
}, 10000)
type TimerOutcome = "idle" | "running" | "completed" | "failed" | "cancelled" | "blocked"
let timerOutcome: TimerOutcome = "idle"
let timerInterval: number | undefined
let runStopped: number | null = null
function elapsedMilliseconds(): number | null {
  return timerOutcome === "idle" ? null : Math.round((runStopped ?? performance.now()) - runStarted)
}
function renderTimer() {
  const milliseconds = elapsedMilliseconds()
  const timer = element("import-timer")
  timer.hidden = milliseconds === null
  timer.dataset.outcome = timerOutcome
  if (milliseconds === null) return
  const seconds = Math.floor(milliseconds / 1000)
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60]
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600))
  element("import-duration").textContent = parts
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
  element("import-timer-status").textContent = {
    idle: "Elapsed",
    running: "Elapsed",
    completed: "Completed in",
    failed: "Failed after",
    cancelled: "Stopped after",
    blocked: "Needs attention after",
  }[timerOutcome]
}
function startTimer() {
  clearInterval(timerInterval)
  runStarted = performance.now()
  runStopped = null
  timerOutcome = "running"
  renderTimer()
  timerInterval = window.setInterval(renderTimer, 250)
}
function finishTimer(outcome: Exclude<TimerOutcome, "idle" | "running">) {
  if (timerOutcome !== "running") return
  runStopped = performance.now()
  timerOutcome = outcome
  clearInterval(timerInterval)
  timerInterval = undefined
  renderTimer()
}
function post(message: unknown) {
  parent.postMessage({ pluginMessage: message }, "*")
}
function update() {
  element<HTMLButtonElement>("verify-btn").disabled =
    busy || connecting || disconnecting || manuallyDisconnected

  document.body.dataset.connection = disconnecting
    ? "disconnecting"
    : connecting
      ? "connecting"
      : studio
        ? "connected"
        : "idle"
  run.disabled =
    !ready ||
    busy ||
    connecting ||
    disconnecting ||
    manuallyDisconnected ||
    (!selectionCount && element<HTMLSelectElement>("import-scope").value === "selection")
  run.textContent = busy
    ? "Importing\u2026"
    : element<HTMLInputElement>("force-fresh").checked
      ? "Import as new in ProtoPie"
      : "Import / update in ProtoPie"
  element<HTMLButtonElement>("retry-new-btn").disabled = run.disabled
  connectButton.disabled = !ready || busy || connecting || disconnecting
  connectButton.textContent = studio ? "Reconnect" : "Connect"
  disconnectButton.disabled =
    !ready || disconnecting || (!studio && !cached && !connecting && !busy && !forgetFailed)
  element<HTMLButtonElement>("switch-target-btn").disabled = connectButton.disabled
  endpoint.disabled = busy || connecting || disconnecting
  for (const id of [
    "import-scope",
    "fit-canvas",
    "shared-components",
    "create-components",
    "force-fresh",
    "live-auto-layout",
    "clip-truncated-text",
  ])
    element<HTMLInputElement | HTMLSelectElement>(id).disabled = !ready || busy || disconnecting
  element<HTMLInputElement>("shared-components").disabled ||=
    !element<HTMLInputElement>("create-components").checked
  stop.textContent = choosingVariables ? "Cancel import" : "Stop after current batch"
  stop.hidden = !busy
}
async function connect(fresh = false): Promise<boolean> {
  if (connecting || disconnecting) return false
  manuallyDisconnected = false
  element("disconnect-note").hidden = true
  const attempt = new AbortController()
  connectionAttempt = attempt
  connecting = true
  update()
  status.textContent = "Connecting…"
  note.hidden = true
  try {
    const result = await acquireConnection(
      endpoint.value,
      fresh ? null : cached,
      () => {
        status.textContent = "Waiting for Studio approval…"
        note.hidden = false
      },
      attempt.signal,
    )
    if (attempt.signal.aborted || connectionAttempt !== attempt) return false
    cached = result.connection
    endpoint.value = cached.endpoint
    if (
      !studio ||
      studio.session.connectionId !== cached.connectionId ||
      studio.session.endpoint !== cached.endpoint ||
      studio.session.contextId !== cached.contextId
    )
      studio = new Studio({
        endpoint: cached.endpoint,
        connectionId: cached.connectionId,
        contextId: cached.contextId,
      })
    previousTarget = result.reused ? (cached.target ?? "") : ""
    const path = result.context.filePath
    target = path
      ? `file:${/^[A-Za-z]:\\/.test(path) ? path.toLowerCase() : path}`
      : `unsaved:${cached.contextId}`
    cached = { ...cached, target }
    await saveSettings({ endpoint: cached.endpoint, connection: cached })
    if (attempt.signal.aborted || connectionAttempt !== attempt) return false
    forgetFailed = false
    currentContext = {
      contextId: result.context.contextId,
      tabName: result.context.tabName,
      filePath: result.context.filePath,
    }
    const name = contextDisplayName(result.context)
    status.textContent = name ? `Connected: ${name}` : "Connected to ProtoPie"
    const nameNote = element("connection-name-note")
    nameNote.textContent = /(?:^|[\\/])\.~pie-[^\\/]+\.tmp$/i.test(result.context.filePath ?? "")
      ? "ProtoPie hasn't provided this Cloud tab's name."
      : "ProtoPie hasn't provided this tab's name."
    nameNote.hidden = !!name
    return true
  } catch (error) {
    if (attempt.signal.aborted || connectionAttempt !== attempt) return false
    studio = null
    currentContext = null
    element("connection-name-note").hidden = true
    status.textContent = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    if (connectionAttempt === attempt) connectionAttempt = null
    connecting = false
    note.hidden = true
    update()
  }
}
function acknowledge(message: Record<string, unknown>, failure: string): Promise<void> {
  const id = ++requestId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(failure))
    }, 30000)
    pending.set(id, {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    post({ ...message, requestId: id })
  })
}
function saveSettings(settings: ConnectionSettings): Promise<void> {
  return acknowledge(
    { type: "save-connection-settings", settings },
    "Figma did not confirm saving connection settings.",
  )
}
let journal: {
  session: string
  sequence: number
  tracker: ReturnType<typeof checkpointTracker>
  changed: boolean
} | null = null
async function persist(state: ImportState): Promise<void> {
  const change = journal?.tracker.prepare(state)
  if (change && !change.changed) return
  const started = performance.now()
  try {
    const payload =
      journal && change
        ? {
            type: "persist",
            target,
            session: journal.session,
            sequence: journal.sequence + 1,
            patch: change.patch,
          }
        : { type: "persist", target, state }
    linkSaveBytes += new TextEncoder().encode(JSON.stringify(payload)).length
    await acknowledge(
      payload,
      "ProtoPie was changed, but Figma did not acknowledge saving the links. Restore the connection before repeating this import.",
    )
    if (journal && change) {
      journal.sequence++
      journal.changed = true
      change.acknowledge()
    }
    linkSaveCount++
  } finally {
    linkSaveMilliseconds += performance.now() - started
  }
}
async function finishDisconnect(): Promise<void> {
  cached = null
  studio = null
  target = ""
  previousTarget = ""
  note.hidden = true
  currentContext = null
  element("connection-name-note").hidden = true
  element("disconnect-note").hidden = false
  try {
    await saveSettings({
      endpoint: readConnectionSettings({ endpoint: endpoint.value }).endpoint,
      connection: null,
      disconnected: true,
    })
    forgetFailed = false
    status.textContent = "Disconnected"
  } catch {
    forgetFailed = true
    status.textContent =
      "Disconnected here, but Figma could not forget the saved approval. Keep this panel open and try Disconnect again."
  } finally {
    disconnecting = false
    progress.textContent = ""
    update()
  }
}
async function disconnect(): Promise<void> {
  if (!ready || disconnecting) return
  disconnecting = true
  manuallyDisconnected = true
  connectionAttempt?.abort()
  cancellation.abort()
  note.hidden = true
  update()
  if (busy) {
    progress.textContent = "Disconnecting after the current operation…"
    return
  }
  await finishDisconnect()
}
function group(id: string, entries: string[]) {
  const container = element(id),
    ul = container.querySelector("ul")!
  ul.replaceChildren()
  container.hidden = entries.length === 0
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1)
  for (const [entry, count] of counts) {
    const li = document.createElement("li")
    li.textContent = count > 1 ? `${entry} (${count} occurrences)` : entry
    ul.appendChild(li)
  }
}
function error(message: string, diagnostic?: ReadFailure) {
  finishTimer(cancellation.signal.aborted ? "cancelled" : "failed")
  lastFailure = diagnostic ?? { stage: lastDesign ? "protopie-import" : "figma-read", message }
  group("group-errors", [message])
  element("report").hidden = false
  busy = false
  progress.textContent = ""
  update()
}
async function chooseVariables(
  collisions: VariableCollision[],
): Promise<Record<string, VariableChoice> | null> {
  const panel = element("variable-decisions"),
    list = element("variable-choice-list")
  const confirm = element<HTMLButtonElement>("variable-continue"),
    cancel = element<HTMLButtonElement>("variable-cancel")
  const signal = cancellation.signal
  if (signal.aborted) return null
  list.replaceChildren()
  const inputs = new Map<string, HTMLSelectElement>()
  for (const [index, collision] of collisions.entries()) {
    const row = document.createElement("div")
    row.className = "variable-choice"
    const label = document.createElement("label")
    label.htmlFor = `variable-choice-${index}`
    label.textContent = collision.sourceName
    const details = document.createElement("small")
    const value = (v: string | number) => JSON.stringify(v).slice(0, 120)
    details.textContent = `Figma: ${collision.sourceType} ${value(collision.sourceValue)}. ProtoPie: ${collision.existing.dataType} ${value(collision.existing.value)}.${collision.canReuse ? "" : " Types differ; the existing variable cannot be reused."}`
    const control = document.createElement("div")
    control.className = "select-control"
    const input = document.createElement("select")
    input.id = label.htmlFor
    for (const [key, text] of [
      ["", "Choose an action"],
      ["existing", "Use existing"],
      ["create", "Create separate variable"],
      ["skip", "Skip this variable"],
    ]) {
      const option = document.createElement("option")
      option.value = key
      option.textContent = text
      option.disabled = !key || (key === "existing" && !collision.canReuse)
      input.append(option)
    }
    input.value = ""
    control.append(input)
    const icon = document.querySelector(".select-icon")
    if (icon) control.append(icon.cloneNode(true))
    inputs.set(collision.sourceId, input)
    row.append(label, details, control)
    list.append(row)
  }
  confirm.disabled = true
  choosingVariables = true
  panel.hidden = false
  update()
  panel.scrollIntoView({ block: "nearest" })
  return new Promise((resolve) => {
    function finish(choices: Record<string, VariableChoice> | null) {
      signal.removeEventListener("abort", abort)
      confirm.removeEventListener("click", accept)
      cancel.removeEventListener("click", reject)
      list.removeEventListener("change", changed)
      choosingVariables = false
      panel.hidden = true
      update()
      resolve(choices)
    }
    function changed() {
      confirm.disabled = [...inputs.values()].some((input) => !input.value)
    }
    function accept() {
      if (!confirm.disabled)
        finish(
          Object.fromEntries([...inputs].map(([id, input]) => [id, input.value as VariableChoice])),
        )
    }
    function reject() {
      cancellation.abort()
    }
    function abort() {
      finish(null)
    }
    confirm.addEventListener("click", accept)
    cancel.addEventListener("click", reject)
    list.addEventListener("change", changed)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
async function startImport(fresh: boolean, verifyOnly = false) {
  if (
    !ready ||
    busy ||
    connecting ||
    disconnecting ||
    manuallyDisconnected ||
    (!verifyOnly && run.disabled)
  )
    return
  startTimer()
  runFresh = fresh
  runVerification = verifyOnly
  busy = true
  lastDesign = null
  lastReport = null
  lastFailure = null
  linkSaveMilliseconds = 0
  linkSaveBytes = 0
  linkSaveProtocol = "legacy-snapshot"
  linkSaveCount = 0
  figmaReadMilliseconds = null
  for (const id of [
    "group-created",
    "group-updated",
    "group-skipped",
    "group-conflicts",
    "group-errors",
    "group-verification",
    "group-unsupported",
  ])
    group(id, [])
  element("metrics").textContent = ""
  element("retry-new").hidden = true
  cancellation = new AbortController()
  update()
  element("report").hidden = true
  if (!(await connect())) {
    finishTimer(cancellation.signal.aborted ? "cancelled" : "failed")
    if (!cancellation.signal.aborted)
      lastFailure = { stage: "protopie-import", message: status.textContent ?? "Connection failed" }
    busy = false
    if (disconnecting) await finishDisconnect()
    update()
    return
  }
  if (cancellation.signal.aborted) {
    finishTimer("cancelled")
    busy = false
    if (disconnecting) await finishDisconnect()
    else update()
    return
  }
  connectionMilliseconds = Math.round(performance.now() - runStarted)
  progress.textContent = "Reading the Figma selection…"
  post({
    type: "run",
    verifyOnly: runVerification,
    target,
    previousTarget,
    fresh: runFresh,
    createComponents: element<HTMLInputElement>("create-components").checked,
    liveAutoLayout: element<HTMLInputElement>("live-auto-layout").checked,
    clipTruncatedText: element<HTMLInputElement>("clip-truncated-text").checked,
    wholePage: element<HTMLSelectElement>("import-scope").value === "page",
    wholeFile: element<HTMLSelectElement>("import-scope").value === "file",
  })
}
run.addEventListener(
  "click",
  () => void startImport(element<HTMLInputElement>("force-fresh").checked),
)
element("verify-btn").addEventListener("click", () => void startImport(false, true))

element("retry-new-btn").addEventListener("click", () => void startImport(true))
element("force-fresh").addEventListener("change", update)
element("create-components").addEventListener("change", update)
stop.addEventListener("click", () => {
  cancellation.abort()
  progress.textContent = "Stopping after the current batch…"
})
connectButton.addEventListener("click", () => void connect())
disconnectButton.addEventListener("click", () => void disconnect())
element("switch-target-btn").addEventListener("click", () => void connect(true))
element("import-scope").addEventListener("change", update)
element("download-report").addEventListener("click", () => {
  const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              version: 1,
              pluginVersion: "0.3.4",
              design: lastDesign,
              report: lastReport,
              failure: lastFailure,
              connection: currentContext,
              live: {
                busy,
                connecting,
                importMode: runFresh ? "new" : "update",
                stage: progress.textContent || status.textContent,
                elapsedMilliseconds: elapsedMilliseconds(),
                outcome: timerOutcome,
                figmaReadMilliseconds,
                linkSaveMilliseconds: Math.round(linkSaveMilliseconds),
                linkSaveCount,
                linkSaveBytes,
                linkSaveProtocol,
                completedStudioCalls: studio?.metrics ?? {},
                pendingStudioCalls: [...(studio?.pending.values() ?? [])].map((call) => ({
                  name: call.name,
                  elapsedMilliseconds: Math.round(performance.now() - call.started),
                })),
              },
            },
            null,
            2,
          ),
        ],
        {
          type: "application/json",
        },
      ),
    ),
    link = document.createElement("a")
  link.href = url
  link.download = "figma-to-protopie-diagnostic.json"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})
window.addEventListener("message", (event) => {
  if (event.source !== parent) return
  const theme = event.data?.figmaTheme
  if (theme && typeof theme === "object") {
    if (theme.colorScheme === "light" || theme.colorScheme === "dark")
      document.documentElement.style.colorScheme = theme.colorScheme
    if (theme.variables && typeof theme.variables === "object") {
      for (const [name, value] of Object.entries(theme.variables)) {
        if (
          /^--figma-color-[a-z-]+$/.test(name) &&
          typeof value === "string" &&
          value.length < 128 &&
          CSS.supports("color", value)
        )
          document.documentElement.style.setProperty(name, value)
      }
    }
    return
  }
  const m = event.data?.pluginMessage
  if (!m) return
  if (m.type === "connection-settings" && !ready) {
    clearTimeout(settingsTimeout)
    const settings = readConnectionSettings(m.settings)
    cached = settings.connection
    endpoint.value = settings.endpoint
    ready = true
    manuallyDisconnected = settings.disconnected === true
    if (manuallyDisconnected) {
      status.textContent = "Disconnected"
      element("disconnect-note").hidden = false
      update()
    } else void connect()
  } else if (m.type === "selection") {
    selectionCount = m.count
    update()
  } else if (m.type === "progress") progress.textContent = m.text
  else if (m.type === "persisted" || m.type === "connection-settings-saved") {
    pending.get(m.requestId)?.resolve()
    pending.delete(m.requestId)
  } else if (m.type === "error") {
    if (pending.has(m.requestId)) {
      pending.get(m.requestId)!.reject(new Error(m.message))
      pending.delete(m.requestId)
    } else {
      error(m.message, m.diagnostic)
      if (disconnecting) void finishDisconnect()
    }
  } else if (m.type === "design") {
    if (!busy) return
    if (disconnecting) {
      finishTimer("cancelled")
      busy = false
      void finishDisconnect()
      return
    }
    void (async () => {
      try {
        if (!studio) throw new Error("Connect to Studio first")
        lastDesign = m.design
        figmaReadMilliseconds = typeof m.readMilliseconds === "number" ? m.readMilliseconds : null
        // A fresh import never consumes saved links, including replies from an older sandbox.
        const state = runFresh ? emptyState() : m.state
        journal =
          typeof m.checkpointSession === "string" && m.checkpointProtocol === 2
            ? {
                session: m.checkpointSession,
                sequence: 0,
                tracker: checkpointTracker(m.checkpointReset ? emptyState() : state),
                changed: false,
              }
            : null
        linkSaveProtocol = journal ? "incremental-journal" : "legacy-snapshot"
        if (runFresh) element<HTMLInputElement>("force-fresh").checked = false
        let fontFaces = []
        if (!runVerification) {
          try {
            const response = await fetch("/font-catalog", {
              cache: "no-store",
              signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(2000)]),
            })
            if (response.ok) {
              const catalog = await response.json()
              if (Array.isArray(catalog.fonts)) fontFaces = catalog.fonts
            }
          } catch (error) {
            if (cancellation.signal.aborted) throw error
          }
        }
        const result = await importDesign(
          studio,
          m.design,
          state,
          {
            fontFaces,
            verifyOnly: runVerification,
            newImport: runFresh,
            resolveVariableCollisions: chooseVariables,
            allowSharedComponents:
              element<HTMLInputElement>("create-components").checked &&
              element<HTMLInputElement>("shared-components").checked,
            fitCanvas: element<HTMLInputElement>("fit-canvas").checked,
            signal: cancellation.signal,
          },
          (text) => {
            progress.textContent = text
          },
          persist,
        )
        if (journal?.changed) {
          const start = performance.now()
          try {
            await acknowledge(
              {
                type: "compact-checkpoints",
                target,
                session: journal.session,
                sequence: journal.sequence,
              },
              "The checkpoint journal is saved, but compaction was not confirmed.",
            )
            linkSaveCount++
          } finally {
            linkSaveMilliseconds += performance.now() - start
          }
          result.report.linkSaveMilliseconds = Math.round(linkSaveMilliseconds)
        }
        finishTimer(
          cancellation.signal.aborted
            ? "cancelled"
            : result.report.errors.some(
                  (error) => !result.report.verificationPending?.includes(error),
                )
              ? "failed"
              : result.report.conflicts.length || result.report.verificationPending?.length
                ? "blocked"
                : "completed",
        )
        result.report.mode = runFresh ? "new" : "update"
        result.report.figmaReadMilliseconds =
          typeof m.readMilliseconds === "number" ? m.readMilliseconds : undefined
        result.report.connectionMilliseconds = connectionMilliseconds
        result.report.endToEndMilliseconds = elapsedMilliseconds() ?? 0
        lastReport = result.report
        group("group-created", result.report.created)
        group("group-updated", result.report.updated)
        group("group-skipped", result.report.skipped)
        group(
          "group-conflicts",
          result.report.conflicts.filter(
            (message) => !result.report.verificationPending?.includes(message),
          ),
        )
        element("retry-new").hidden = result.report.canImportAsNew !== true
        group(
          "group-errors",
          result.report.errors.filter(
            (error) => !result.report.verificationPending?.includes(error),
          ),
        )
        group("group-verification", result.report.verificationPending ?? [])
        group("group-unsupported", result.report.notes)
        element("metrics").textContent =
          `${runVerification ? "Verification" : runFresh ? "New import" : "Update"} \u00b7 ${(result.report.endToEndMilliseconds / 1000).toFixed(2)}s total · ${result.report.calls} write batches · ${(result.report.bytes / 1024).toFixed(0)} KB sent`
        element("report").hidden = false
        progress.textContent = ""
      } catch (e) {
        error(e instanceof Error ? e.message : String(e))
      } finally {
        journal = null
        busy = false
        if (disconnecting) await finishDisconnect()
        else update()
      }
    })()
  }
})
post({ type: "load-connection-settings" })
update()
