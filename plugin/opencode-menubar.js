import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

// One snapshot per plugin instance avoids collisions across terminals/projects.
// Only activity is recorded: no prompts, project paths or session titles.
export default async function OpenCodeMenuBar(_context, options = {}) {
  const directory = options.stateDirectory ?? join(homedir(), "Library", "Application Support", "OpenCode Menu Bar", "states")
  const filename = join(directory, `${process.pid}-${randomUUID()}.json`)
  const sessions = new Map()
  let disposed = false
  let queue = Promise.resolve()

  function session(id) {
    if (!sessions.has(id)) sessions.set(id, { busy: false, pending: new Set() })
    return sessions.get(id)
  }

  function publish() {
    if (disposed) return queue
    const snapshot = JSON.stringify({
      version: 1,
      pid: process.pid,
      updatedAt: Date.now() / 1000,
      sessions: [...sessions].map(([id, value]) => ({
        id,
        state: value.pending.size ? "attention" : value.busy ? "working" : "idle",
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
        case "session.status": {
          if (properties.status?.type === "idle") sessions.delete(id)
          else if (["busy", "retry"].includes(properties.status?.type)) session(id).busy = true
          else return
          break
        }
        case "session.idle":
        case "session.deleted":
          sessions.delete(id)
          break
        case "permission.asked":
        case "permission.updated":
        case "permission.v2.asked":
        case "question.asked":
        case "question.v2.asked": {
          const kind = event.type.startsWith("permission") ? "permission" : "question"
          session(id).pending.add(`${kind}:${properties.id}`)
          break
        }
        case "permission.replied":
        case "permission.v2.replied":
        case "question.replied":
        case "question.rejected":
        case "question.v2.replied":
        case "question.v2.rejected": {
          const kind = event.type.startsWith("permission") ? "permission" : "question"
          session(id).pending.delete(`${kind}:${properties.requestID ?? properties.permissionID}`)
          break
        }
        default:
          return
      }
      await publish()
    },
  }
}
