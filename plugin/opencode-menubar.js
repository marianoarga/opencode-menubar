import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

// One snapshot per plugin instance avoids collisions across terminals/projects.
// Titles and project names are local-only metadata for the expanded menu.
export default async function OpenCodeMenuBar(context, options = {}) {
  const directory = options.stateDirectory ?? join(homedir(), "Library", "Application Support", "OpenCode Menu Bar", "states")
  const filename = join(directory, `${process.pid}-${randomUUID()}.json`)
  const sessions = new Map()
  const fetchingTitles = new Set()
  let disposed = false
  let queue = Promise.resolve()

  function session(id) {
    if (!sessions.has(id)) {
      sessions.set(id, { busy: false, pending: new Set(), title: null, startedAt: null, stateSince: Date.now() / 1000 })
    }
    return sessions.get(id)
  }

  function state(value) {
    return value.pending.size ? "attention" : value.busy ? "working" : "idle"
  }

  function transition(id, change) {
    const value = session(id)
    const before = state(value)
    change(value)
    if (state(value) !== before) value.stateSince = Date.now() / 1000
    return value
  }

  function start(value) {
    if (!value.busy) value.startedAt = Date.now() / 1000
    value.busy = true
  }

  function idle(value) {
    value.busy = false
    value.pending.clear()
    value.startedAt = null
  }

  function loadTitle(id) {
    if (disposed || sessions.get(id)?.title || fetchingTitles.has(id) || !context.client?.session?.get) return
    fetchingTitles.add(id)
    // Never delay an event hook on an HTTP request. Fetch metadata only after
    // the instance is running, not during plugin initialization.
    Promise.resolve().then(() => {
      const requestOptions = { signal: AbortSignal.timeout(3000) }
      // SDK v2 uses flat parameters and a second options argument. Older SDK
      // clients use path/query fields in the first argument. Support both.
      return context.client.session.get({
        sessionID: id, directory: context.directory,
        path: { id }, query: { directory: context.directory }, ...requestOptions,
      }, requestOptions)
    }).then(result => {
      if (!disposed && sessions.has(id) && !sessions.get(id).title && result.data?.title) {
        sessions.get(id).title = result.data.title
        return publish()
      }
    }).catch(() => {}).finally(() => fetchingTitles.delete(id))
  }

  function publish() {
    if (disposed) return queue
    const snapshot = JSON.stringify({
      version: 1,
      pid: process.pid,
      project: context.directory ? basename(context.directory) : null,
      updatedAt: Date.now() / 1000,
      sessions: [...sessions].map(([id, value]) => ({
        id,
        title: value.title,
        state: state(value),
        startedAt: value.startedAt,
        stateSince: value.stateSince,
      })),
    })
    queue = queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(`${filename}.tmp`, snapshot, { mode: 0o600 })
      await rename(`${filename}.tmp`, filename)
    }).catch(() => {
      // An unavailable status app or disk must never interrupt an AI session.
    })
    return queue
  }

  const heartbeat = setInterval(publish, options.heartbeatMs ?? 5000)
  heartbeat.unref?.()

  async function dispose() {
    if (disposed) return
    disposed = true
    clearInterval(heartbeat)
    process.removeListener("exit", onExit)
    await queue
    await unlink(filename).catch(() => {})
  }

  // Cleanup is handled by dispose when possible; the reader also rejects stale
  // snapshots and dead processes, including SIGKILL and terminal crashes.
  function onExit() { clearInterval(heartbeat) }
  process.once("exit", onExit)
  await publish()

  return {
    dispose,
    "chat.message": async ({ sessionID }) => {
      session(sessionID)
      loadTitle(sessionID)
      await publish()
    },
    event: async ({ event }) => {
      if (disposed) return
      const properties = event.properties ?? {}
      if (event.type === "server.instance.disposed") {
        await dispose()
        return
      }
      const id = properties.sessionID ?? properties.info?.id
      if (!id) return
      switch (event.type) {
        case "session.created":
        case "session.updated":
          if (properties.info?.title) session(id).title = properties.info.title
          else session(id)
          break
        case "tui.session.select":
          session(id)
          break
        case "session.status": {
          if (properties.status?.type === "idle") transition(id, idle)
          else if (["busy", "retry"].includes(properties.status?.type)) transition(id, start)
          else return
          break
        }
        case "session.idle":
          transition(id, idle)
          break
        case "session.deleted":
          sessions.delete(id)
          break
        case "permission.asked":
        case "permission.updated":
        case "permission.v2.asked":
        case "question.asked":
        case "question.v2.asked": {
          const kind = event.type.startsWith("permission") ? "permission" : "question"
          transition(id, value => value.pending.add(`${kind}:${properties.id}`))
          break
        }
        case "permission.replied":
        case "permission.v2.replied":
        case "question.replied":
        case "question.rejected":
        case "question.v2.replied":
        case "question.v2.rejected": {
          const kind = event.type.startsWith("permission") ? "permission" : "question"
          transition(id, value => value.pending.delete(`${kind}:${properties.requestID ?? properties.permissionID}`))
          break
        }
        default:
          return
      }
      if (sessions.has(id)) loadTitle(id)
      await publish()
    },
  }
}
