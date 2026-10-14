import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import OpenCodeMenuBar from "../plugin/opencode-menubar.js"

const executable = fileURLToPath(new URL("../build/OpenCode Menu Bar.app/Contents/MacOS/OpenCodeMenuBar", import.meta.url))
const fixtures = []
const plugins = []

afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.dispose()
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function directory() {
  const path = await mkdtemp(join(process.env.OPENCODE_TEST_TMPDIR ?? tmpdir(), "menubar-test-"))
  fixtures.push(path)
  return path
}

async function plugin(path, options = {}) {
  const hooks = await OpenCodeMenuBar({}, { stateDirectory: path, ...options })
  plugins.push(hooks)
  return hooks
}

function emit(hooks, type, sessionID, properties = {}) {
  return hooks.event({ event: { type, properties: { sessionID, ...properties } } })
}

function status(path) {
  return JSON.parse(execFileSync(executable, ["--status", path], { encoding: "utf8" }))
}

test("two instances remain working until every session finishes", async () => {
  const path = await directory()
  const first = await plugin(path)
  const second = await plugin(path)
  expect(status(path)).toEqual({ state: "idle", connected: true })
  await emit(first, "session.status", "one", { status: { type: "busy" } })
  await emit(second, "session.status", "two", { status: { type: "retry" } })
  expect(status(path).state).toBe("working")
  await emit(first, "session.idle", "one")
  expect(status(path).state).toBe("working")
  await emit(second, "session.status", "two", { status: { type: "idle" } })
  expect(status(path).state).toBe("idle")
})

test("attention overrides work; all pending requests must be resolved", async () => {
  const path = await directory()
  const hooks = await plugin(path)
  await emit(hooks, "session.status", "one", { status: { type: "busy" } })
  await emit(hooks, "session.status", "two", { status: { type: "busy" } })
  await emit(hooks, "permission.asked", "one", { id: "permission-1" })
  await emit(hooks, "question.asked", "one", { id: "question-1" })
  expect(status(path).state).toBe("attention")
  await emit(hooks, "permission.replied", "one", { requestID: "permission-1" })
  expect(status(path).state).toBe("attention")
  await emit(hooks, "question.rejected", "one", { requestID: "question-1" })
  expect(status(path).state).toBe("working")
  await emit(hooks, "permission.v2.asked", "two", { id: "v2" })
  expect(status(path).state).toBe("attention")
  await emit(hooks, "permission.v2.replied", "two", { requestID: "v2" })
  expect(status(path).state).toBe("working")
})

test("legacy permissions and v2 questions return to work after a reply", async () => {
  const path = await directory()
  const hooks = await plugin(path)
  await emit(hooks, "session.status", "one", { status: { type: "busy" } })
  await emit(hooks, "permission.updated", "one", { id: "legacy" })
  await emit(hooks, "permission.updated", "one", { id: "legacy" })
  expect(status(path).state).toBe("attention")
  await emit(hooks, "permission.replied", "one", { permissionID: "legacy" })
  expect(status(path).state).toBe("working")
  await emit(hooks, "question.v2.asked", "one", { id: "v2" })
  expect(status(path).state).toBe("attention")
  await emit(hooks, "question.v2.replied", "one", { requestID: "v2" })
  expect(status(path).state).toBe("working")
})

test("interruption and deletion clear unresolved requests", async () => {
  const path = await directory()
  const hooks = await plugin(path)
  await emit(hooks, "question.asked", "one", { id: "q" })
  await emit(hooks, "session.idle", "one")
  expect(status(path).state).toBe("idle")
  await emit(hooks, "permission.asked", "two", { id: "p" })
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "two" } } } })
  expect(status(path).state).toBe("idle")
})

test("heartbeat keeps a long-running task alive; dispose cleans only its instance", async () => {
  const path = await directory()
  const first = await plugin(path, { heartbeatMs: 30 })
  const second = await plugin(path)
  await emit(first, "session.status", "one", { status: { type: "busy" } })
  const files = (await readdir(path)).filter(name => name.endsWith(".json"))
  let file
  for (const candidate of files) {
    if (JSON.parse(await readFile(join(path, candidate), "utf8")).sessions.length) file = candidate
  }
  const before = JSON.parse(await readFile(join(path, file), "utf8"))
  await Bun.sleep(100)
  const after = JSON.parse(await readFile(join(path, file), "utf8"))
  expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  await first.event({ event: { type: "server.instance.disposed", properties: {} } })
  expect(status(path)).toEqual({ state: "idle", connected: true })
  await second.dispose()
  expect(status(path)).toEqual({ state: "idle", connected: false })
  expect(await readdir(path)).toEqual([])
})

test("the native reader ignores crashed, stale, invalid and partial snapshots", async () => {
  const path = await directory()
  const snapshot = { version: 1, pid: process.pid, updatedAt: Date.now() / 1000, sessions: [{ state: "attention" }] }
  await writeFile(join(path, "stale.json"), JSON.stringify({ ...snapshot, updatedAt: snapshot.updatedAt - 60 }))
  await writeFile(join(path, "dead.json"), JSON.stringify({ ...snapshot, pid: 2147483647 }))
  await writeFile(join(path, "partial.json.tmp"), "{")
  await writeFile(join(path, "bad.json"), "broken")
  await writeFile(join(path, "future.json"), JSON.stringify({ ...snapshot, updatedAt: snapshot.updatedAt + 60 }))
  expect(status(path)).toEqual({ state: "idle", connected: false })
  await writeFile(join(path, "live.json"), JSON.stringify(snapshot))
  expect(status(path)).toEqual({ state: "attention", connected: true })
})

test("an inaccessible state directory does not interrupt the session hook", async () => {
  const path = await directory()
  const blocked = join(path, "file")
  await writeFile(blocked, "occupied")
  const hooks = await plugin(blocked)
  await emit(hooks, "session.status", "one", { status: { type: "busy" } })
  await emit(hooks, "question.asked", "one", { id: "question" })
  await hooks.dispose()
})
