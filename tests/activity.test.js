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

async function plugin(path, options = {}, context = {}) {
  const hooks = await OpenCodeMenuBar(context, { stateDirectory: path, ...options })
  plugins.push(hooks)
  return hooks
}

function emit(hooks, type, sessionID, properties = {}) {
  return hooks.event({ event: { type, properties: { sessionID, ...properties } } })
}

function status(path, database) {
  return JSON.parse(execFileSync(executable, ["--status", path], {
    encoding: "utf8", env: database ? { ...process.env, OPENCODE_MENUBAR_DATABASE: database } : process.env,
  }))
}

test("two instances remain working until every session finishes", async () => {
  const path = await directory()
  const first = await plugin(path)
  const second = await plugin(path)
  expect(status(path)).toMatchObject({ state: "idle", connected: true, sessions: [] })
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
  expect(status(path)).toMatchObject({ state: "idle", connected: true, sessions: [] })
  await second.dispose()
  expect(status(path)).toMatchObject({ state: "idle", connected: false, sessions: [] })
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
  expect(status(path)).toMatchObject({ state: "idle", connected: false, sessions: [] })
  await writeFile(join(path, "live.json"), JSON.stringify(snapshot))
  expect(status(path)).toMatchObject({ state: "attention", connected: true })
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

test("connected sessions keep their title and idle row; a new run resets the timer", async () => {
  const path = await directory()
  const hooks = await plugin(path, {}, { directory: "/projects/my-app" })
  await emit(hooks, "session.created", undefined, { info: { id: "one", title: "Fix login" } })
  expect(status(path).sessions[0]).toMatchObject({ id: "one", title: "Fix login", project: "my-app", state: "idle" })
  await emit(hooks, "session.status", "one", { status: { type: "busy" } })
  const first = status(path).sessions[0]
  expect(first.startedAt).toBeNumber()
  expect(first.statusText).toContain("Trabajando · hace")
  await Bun.sleep(30)
  await emit(hooks, "session.status", "one", { status: { type: "retry" } })
  expect(status(path).sessions[0].startedAt).toBe(first.startedAt)
  await emit(hooks, "session.updated", undefined, { info: { id: "one", title: "Fix auth" } })
  expect(status(path).sessions[0].title).toBe("Fix auth")
  expect(status(path).sessions[0].startedAt).toBe(first.startedAt)
  await emit(hooks, "question.asked", "one", { id: "q" })
  const attention = status(path).sessions[0]
  expect(attention.statusText).toContain("Requiere atención · hace")
  await emit(hooks, "permission.asked", "one", { id: "p" })
  expect(status(path).sessions[0].stateSince).toBe(attention.stateSince)
  await emit(hooks, "question.replied", "one", { requestID: "q" })
  await emit(hooks, "permission.replied", "one", { requestID: "p" })
  expect(status(path).sessions[0].startedAt).toBe(first.startedAt)
  await emit(hooks, "session.idle", "one")
  expect(status(path).sessions[0]).toMatchObject({ id: "one", title: "Fix auth", state: "idle" })
  expect(status(path).sessions[0].startedAt).toBeUndefined()
  await emit(hooks, "session.status", "one", { status: { type: "busy" } })
  expect(status(path).sessions[0].startedAt).toBeGreaterThan(first.startedAt)
  await emit(hooks, "session.deleted", undefined, { info: { id: "one" } })
  expect(status(path).sessions).toEqual([])
})

test("a resumed session gets its title asynchronously without delaying hooks", async () => {
  const path = await directory()
  let resolveTitle
  const response = new Promise(resolve => { resolveTitle = resolve })
  const hooks = await plugin(path, {}, { client: { session: { get: () => response } } })
  await hooks["chat.message"]({ sessionID: "resumed" })
  expect(status(path).sessions[0].title).toBe("Cargando nombre de la sesión…")
  resolveTitle({ data: { title: "Existing session" } })
  await Bun.sleep(30)
  expect(status(path).sessions[0].title).toBe("Existing session")
})

test("late metadata responses never overwrite a newer title or resurrect a deleted session", async () => {
  const path = await directory()
  let resolveTitle
  const response = new Promise(resolve => { resolveTitle = resolve })
  const hooks = await plugin(path, {}, { client: { session: { get: () => response } } })
  await hooks["chat.message"]({ sessionID: "one" })
  await emit(hooks, "session.updated", undefined, { info: { id: "one", title: "New title" } })
  await hooks["chat.message"]({ sessionID: "two" })
  await emit(hooks, "session.deleted", undefined, { info: { id: "two" } })
  resolveTitle({ data: { title: "Old title" } })
  await Bun.sleep(30)
  expect(status(path).sessions.map(session => session.title)).toEqual(["New title"])
})

test("the native reader formats elapsed time, orders active sessions and deduplicates observers", async () => {
  const path = await directory()
  const now = Date.now() / 1000
  const snapshot = { version: 1, pid: process.pid, updatedAt: now, project: "my-app", sessions: [
    { id: "idle", title: "Idle", state: "idle", stateSince: now - 10 },
    { id: "working", title: "Work", state: "working", startedAt: now - 75, stateSince: now - 5 },
    { id: "attention", title: "Question", state: "attention", startedAt: now - 120, stateSince: now - 15 },
  ] }
  await writeFile(join(path, "first.json"), JSON.stringify(snapshot))
  await writeFile(join(path, "second.json"), JSON.stringify({ ...snapshot, sessions: [
    { id: "working", title: "Work", state: "idle", stateSince: now },
  ] }))
  const value = status(path)
  expect(value.sessions.map(session => session.id)).toEqual(["attention", "working", "idle"])
  expect(value.sessions[1].elapsedSeconds).toBeGreaterThanOrEqual(75)
  expect(value.sessions[1].statusText).toMatch(/^Trabajando · hace 1 min \d+ s$/)
  expect(value.sessions[0].elapsedSeconds).toBeGreaterThanOrEqual(15)
  expect(value.sessions[0].elapsedSeconds).toBeLessThan(20)
})

test("SDK v2 title lookup passes flat session parameters and request options", async () => {
  const path = await directory()
  const hooks = await plugin(path, {}, { directory: "/projects/my-app", client: { session: {
    get: async (parameters, options) => {
      expect(parameters.sessionID).toBe("resumed")
      expect(parameters.directory).toBe("/projects/my-app")
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return { data: { title: "Apps del tray en macOS: ¿widgets?" } }
    },
  } } })
  await hooks["chat.message"]({ sessionID: "resumed" })
  await Bun.sleep(30)
  expect(status(path).sessions[0].title).toBe("Apps del tray en macOS: ¿widgets?")
})

test("the native menu resolves legacy snapshots to the exact sidebar title and follows renames", async () => {
  const path = await directory()
  const database = join(path, "opencode.db")
  execFileSync("sqlite3", [database, "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT); INSERT INTO session VALUES ('legacy-session', 'Apps del tray en macOS: ¿widgets?');"])
  const hooks = await plugin(path)
  await emit(hooks, "session.status", "legacy-session", { status: { type: "busy" } })
  expect(status(path, database).sessions[0].title).toBe("Apps del tray en macOS: ¿widgets?")
  await emit(hooks, "session.updated", undefined, { info: { id: "legacy-session", title: "Old cached title" } })
  execFileSync("sqlite3", [database, "UPDATE session SET title = 'Renamed session' WHERE id = 'legacy-session';"])
  expect(status(path, database).sessions[0].title).toBe("Renamed session")
  expect(execFileSync("sqlite3", [database, "SELECT COUNT(*) FROM session;"], { encoding: "utf8" }).trim()).toBe("1")
})

test("a missing local database falls back to the descriptive plugin title without exposing IDs", async () => {
  const path = await directory()
  const database = join(path, "missing.db")
  const hooks = await plugin(path)
  await emit(hooks, "session.created", undefined, { info: { id: "not-a-title", title: "Readable session name" } })
  expect(status(path, database).sessions[0].title).toBe("Readable session name")
  await emit(hooks, "session.status", "another-id", { status: { type: "busy" } })
  expect(status(path, database).sessions[0].title).toBe("Cargando nombre de la sesión…")
  expect(await readdir(path)).not.toContain("missing.db")
})
