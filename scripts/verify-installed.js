import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import OpenCodeMenuBar from "../plugin/opencode-menubar.js"

const appStatus = join(homedir(), "Library", "Application Support", "OpenCode Menu Bar", "app-status.json")
async function waitFor(predicate, message, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function appSessionIs(id, state) {
  const value = JSON.parse(await readFile(appStatus, "utf8"))
  return value.connected && value.sessions.some(session => session.id === id && session.state === state)
}

async function appHasSession(id) {
  const value = JSON.parse(await readFile(appStatus, "utf8"))
  return value.sessions.some(session => session.id === id)
}

// Start a real OpenCode instance using the installed global plugin. Shell work
// exercises actual session.status events without making any model requests.
const server = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdout: "pipe",
  stderr: "pipe",
})
let output = ""
let errors = ""
async function consume(stream, receive) {
  for await (const chunk of stream) receive(new TextDecoder().decode(chunk))
}
const stdout = consume(server.stdout, text => { output += text })
const stderr = consume(server.stderr, text => { errors += text })
let base
let sessionID
let fixture

async function request(path, method = "GET", body) {
  const headers = { "Content-Type": "application/json" }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    headers.Authorization = "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")
  }
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  assert(response.ok, `OpenCode ${method} ${path}: HTTP ${response.status}`)
  return response.json()
}

try {
  await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), "OpenCode server did not start", 30000)
  base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  await request("/session/status")
  const session = await request("/session", "POST", { title: "OpenCode Menu Bar installation check" })
  sessionID = session.id
  await waitFor(() => appSessionIs(sessionID, "idle"), "The installed plugin did not connect to the native app", 30000)
  const work = request(`/session/${sessionID}/shell`, "POST", { agent: "build", command: "sleep 3" })
  await waitFor(() => appSessionIs(sessionID, "working"), "Real session activity was not reflected in the menu bar")
  await Bun.sleep(1100)
  const workingStatus = JSON.parse(await readFile(appStatus, "utf8"))
  const workingSession = workingStatus.sessions.find(value => value.id === sessionID)
  assert(workingSession, "The real session is missing from the expanded menu")
  assert.equal(workingSession.title, "OpenCode Menu Bar installation check")
  assert.equal(workingSession.state, "working")
  assert(workingSession.elapsedSeconds >= 1, "The elapsed timer did not advance")
  await work
  await waitFor(() => appSessionIs(sessionID, "idle"), "The session did not return to idle")
  const idleStatus = JSON.parse(await readFile(appStatus, "utf8"))
  assert.equal(idleStatus.sessions.find(value => value.id === sessionID)?.state, "idle")
  console.log("OK: installed global plugin + real session name and elapsed time → working → idle")

  // Questions/permissions are exercised with a controlled event fixture, then
  // verified against the already-running native app's diagnostic state.
  fixture = await OpenCodeMenuBar({})
  await fixture.event({ event: { type: "session.created", properties: { info: { id: "installation-fixture", title: "Menu attention check" } } } })
  await fixture.event({ event: { type: "session.status", properties: { sessionID: "installation-fixture", status: { type: "busy" } } } })
  await waitFor(() => appSessionIs("installation-fixture", "working"), "Native working session did not update")
  await fixture.event({ event: { type: "question.asked", properties: { sessionID: "installation-fixture", id: "installation-question" } } })
  await waitFor(() => appSessionIs("installation-fixture", "attention"), "Native attention session did not update")
  const attentionStatus = JSON.parse(await readFile(appStatus, "utf8"))
  assert.equal(attentionStatus.sessions.find(value => value.id === "installation-fixture")?.state, "attention")
  assert.equal(attentionStatus.state, "attention")
  await fixture.event({ event: { type: "question.replied", properties: { sessionID: "installation-fixture", requestID: "installation-question" } } })
  await waitFor(() => appSessionIs("installation-fixture", "working"), "Native session did not resume its working state")
  await fixture.dispose()
  await waitFor(async () => !(await appHasSession("installation-fixture")), "Fixture cleanup did not remove its session")
  console.log("OK: running native app session → working → attention → working → disconnect")
} finally {
  if (fixture) await fixture.dispose()
  if (sessionID) await request(`/session/${sessionID}`, "DELETE").catch(() => {})
  if (base) await request("/instance/dispose", "POST").catch(() => {})
  server.kill()
  await server.exited
  await Promise.all([stdout, stderr])
}
