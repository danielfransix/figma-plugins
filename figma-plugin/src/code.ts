/// <reference types="@figma/plugin-typings" />
import { readConnectionSettings } from "./connection"
import { readDesign, ReadDesignError } from "./read-design"
import { readState, writeState, writePatch, compactState } from "./storage"
import { emptyState, type ImportState } from "./design"
import { applyPatch, type StatePatch } from "./checkpoint"
let checkpointSession: {
  id: string
  target: string
  sequence: number
  state: ImportState
  reset: boolean
} | null = null
let reading = false
let settingsWrite: Promise<void> = Promise.resolve()
function selection() {
  figma.ui.postMessage({ type: "selection", count: figma.currentPage.selection.length })
}
figma.ui.onmessage = async (message: any) => {
  if (!message || typeof message.type !== "string") return
  try {
    if (message.type === "load-connection-settings") {
      let settings
      try {
        settings = readConnectionSettings(await figma.clientStorage.getAsync("f2p:connection"))
      } catch {
        settings = readConnectionSettings(null)
      }
      figma.ui.postMessage({ type: "connection-settings", settings })
      selection()
    } else if (message.type === "save-connection-settings") {
      const settings = readConnectionSettings(message.settings)
      // Keep an earlier connection save from racing a later explicit disconnect.
      settingsWrite = settingsWrite
        .catch(() => {})
        .then(() => figma.clientStorage.setAsync("f2p:connection", settings))
      await settingsWrite
      figma.ui.postMessage({ type: "connection-settings-saved", requestId: message.requestId })
    } else if (message.type === "run" && !reading) {
      reading = true
      checkpointSession = null
      try {
        if (typeof message.target !== "string" || message.target.length > 4096)
          throw new Error("Missing import target")
        if (message.verifyOnly) {
          const state = readState(figma.root, message.target)
          checkpointSession = {
            id: `${Date.now()}-${Math.random()}`,
            target: message.target,
            sequence: 0,
            state,
            reset: false,
          }
          figma.ui.postMessage({
            type: "design",
            design: { version: 2, units: [], components: [], assets: [], variables: [], notes: [] },
            state,
            readMilliseconds: 0,
            checkpointSession: checkpointSession.id,
            checkpointProtocol: 2,
            checkpointReset: false,
          })
          return
        }
        let nodes: readonly SceneNode[] = message.wholePage
          ? figma.currentPage.children
          : figma.currentPage.selection
        if (message.wholeFile) {
          const all: SceneNode[] = []
          for (const page of figma.root.children) {
            figma.ui.postMessage({ type: "progress", text: `Loading page: ${page.name}` })
            await page.loadAsync()
            all.push(...page.children)
          }
          nodes = all
        }
        if (!nodes.length) throw new Error("Select a frame, section, component, or layer first.")
        let state = message.fresh ? emptyState() : readState(figma.root, message.target)
        let reset = message.fresh === true
        if (
          !message.fresh &&
          !Object.keys(state.scopes).length &&
          typeof message.previousTarget === "string" &&
          message.previousTarget !== message.target
        ) {
          state = readState(figma.root, message.previousTarget)
          reset = true
        }
        if (
          !message.fresh &&
          !Object.keys(state.scopes).length &&
          nodes.some((n) => n.getPluginData("f2p:sync"))
        )
          throw new Error(
            "This selection has links from the earlier development build. Enable 'Import as new' to keep that prototype and create a separate import.",
          )
        const readStarted = Date.now()
        const design = await readDesign(
          figma,
          nodes,
          (count) => {
            if (count % 50 === 0)
              figma.ui.postMessage({ type: "progress", text: `Reading Figma: ${count} layers…` })
          },
          {
            liveAutoLayout: message.liveAutoLayout === true,
            createComponents: message.createComponents !== false,
            clipTruncatedText: message.clipTruncatedText !== false,
          },
        )
        checkpointSession = {
          id: `${Date.now()}-${Math.random()}`,
          target: message.target,
          sequence: 0,
          state,
          reset,
        }
        figma.ui.postMessage({
          type: "design",
          checkpointSession: checkpointSession.id,
          checkpointProtocol: 2,
          checkpointReset: reset,
          design,
          state,
          readMilliseconds: Date.now() - readStarted,
        })
      } finally {
        reading = false
      }
    } else if (message.type === "persist" && typeof message.target === "string") {
      if (message.patch) {
        const session = checkpointSession
        if (
          !session ||
          message.session !== session.id ||
          message.target !== session.target ||
          message.sequence !== session.sequence + 1
        )
          throw new Error("Stale or out-of-order checkpoint; no further writes should be sent")
        const next = applyPatch(
          {
            ...session.state,
            scopes: { ...session.state.scopes },
            assets: { ...session.state.assets },
            variables: { ...session.state.variables },
          },
          message.patch as StatePatch,
        )
        writePatch(figma.root, session.target, message.patch, session.reset)
        session.state = next
        session.reset = false
        session.sequence++
      } else {
        if ((message.state as ImportState)?.version !== 2)
          throw new Error("Unsupported import data")
        writeState(figma.root, message.target, message.state)
      }
      figma.ui.postMessage({ type: "persisted", requestId: message.requestId })
    } else if (message.type === "compact-checkpoints") {
      const session = checkpointSession
      if (
        !session ||
        message.session !== session.id ||
        message.target !== session.target ||
        message.sequence !== session.sequence
      )
        throw new Error("Stale checkpoint compaction")
      compactState(figma.root, session.target, session.state)
      figma.ui.postMessage({ type: "persisted", requestId: message.requestId })
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
      diagnostic: error instanceof ReadDesignError ? error.diagnostic : undefined,
    })
  }
}
figma.on("selectionchange", selection)
figma.showUI(__html__, { width: 400, height: 640, themeColors: true })
selection()
