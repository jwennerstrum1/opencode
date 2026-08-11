import { test, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import type { SessionDriver } from "@opencode-ai/app/context/session-manager"
import { createClientSessionDriver } from "@opencode-ai/app/context/session-manager-driver"
import {
  DEFAULT_SERVER_URL,
  SessionNotFoundError,
  formatSessionsJSON,
  formatSessionsTable,
  isConnectionError,
  listActiveSessions,
  noServerMessage,
  parseModelRef,
  readMuxState,
  readServerState,
  resolveServerURL,
  runClose,
  runSpawn,
  runSwitch,
  selectTracked,
  toCliMessage,
  toSessionClient,
  writeServerState,
  type ActiveSession,
} from "../../src/cli/cmd/session-mux"

let dir: string
let focusFile: string
const URL_A = "http://127.0.0.1:4096"
const URL_B = "http://127.0.0.1:5000"

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mux-"))
  focusFile = path.join(dir, "session-mux.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// A driver that records lifecycle calls instead of hitting a server.
function memDriver() {
  const state = { seq: 0, created: [] as string[], closed: [] as string[] }
  const driver: SessionDriver = {
    async create(input) {
      const id = `ses_${++state.seq}`
      state.created.push(id)
      return { id, agent: input.agent, title: input.title }
    },
    async close(id) {
      state.closed.push(id)
    },
  }
  return { driver, state }
}

// A fake SDK v2 client exposing just the session surface the CLI adapter uses.
function fakeSdk() {
  const state = { seq: 0, sessions: [] as any[], aborted: [] as string[] }
  const client = {
    session: {
      async create(params: { agent?: string; model?: unknown; directory?: string }) {
        const id = `ses_${++state.seq}`
        const now = 1000 + state.seq
        const info = {
          id,
          title: params.agent ? `${params.agent} session` : "session",
          agent: params.agent,
          directory: params.directory,
          time: { created: now, updated: now },
        }
        state.sessions.push(info)
        return { data: info, error: undefined }
      },
      async abort(params: { sessionID: string }) {
        state.aborted.push(params.sessionID)
        return { data: true, error: undefined }
      },
      async list() {
        return { data: state.sessions, error: undefined }
      },
    },
  }
  return { client: client as any, state }
}

function active(id: string, createdAt: number, over: Partial<ActiveSession> = {}): ActiveSession {
  return { id, title: `${id} title`, createdAt, ...over }
}

test("resolveServerURL prefers the flag, then env, then the default", () => {
  expect(resolveServerURL("http://host:1/")).toBe("http://host:1")
  expect(resolveServerURL(undefined, { OPENCODE_SERVER: "http://env:2//" })).toBe("http://env:2")
  expect(resolveServerURL(undefined, {})).toBe(DEFAULT_SERVER_URL)
})

test("parseModelRef splits providerID/modelID and rejects malformed input", () => {
  expect(parseModelRef(undefined)).toBeUndefined()
  expect(parseModelRef("anthropic/claude-sonnet-4")).toEqual({ providerID: "anthropic", id: "claude-sonnet-4" })
  expect(() => parseModelRef("noslash")).toThrow(/providerID\/modelID/)
  expect(() => parseModelRef("/leading")).toThrow()
  expect(() => parseModelRef("trailing/")).toThrow()
})

test("connection errors map to the no-server guidance", () => {
  const url = "http://127.0.0.1:4096"
  expect(isConnectionError(new Error("fetch failed"))).toBe(true)
  expect(isConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:4096"))).toBe(true)
  expect(isConnectionError(new Error("Bad request"))).toBe(false)
  expect(toCliMessage(new Error("fetch failed"), url)).toBe(noServerMessage(url))
  expect(toCliMessage(new SessionNotFoundError("ses_x"), url)).toBe("No active session with id ses_x")
  expect(toCliMessage(new Error("boom"), url)).toBe("boom")
})

test("the registry round-trips and is keyed per server url", async () => {
  await writeServerState(focusFile, URL_A, { sessions: ["ses_a1", "ses_a2"], focusedID: "ses_a2" })
  await writeServerState(focusFile, URL_B, { sessions: ["ses_b1"], focusedID: "ses_b1" })
  expect(await readServerState(focusFile, URL_A)).toEqual({ sessions: ["ses_a1", "ses_a2"], focusedID: "ses_a2" })
  expect(await readServerState(focusFile, URL_B)).toEqual({ sessions: ["ses_b1"], focusedID: "ses_b1" })

  // Emptying a server's registry drops its entry but leaves other servers intact.
  await writeServerState(focusFile, URL_A, { sessions: [] })
  expect(await readServerState(focusFile, URL_A)).toEqual({ sessions: [], focusedID: undefined })
  expect(await readServerState(focusFile, URL_B)).toEqual({ sessions: ["ses_b1"], focusedID: "ses_b1" })
})

test("a malformed registry file resets to empty instead of throwing", async () => {
  await fs.writeFile(focusFile, "{ not json")
  expect(await readMuxState(focusFile)).toEqual({ servers: {} })
  expect(await readServerState(focusFile, URL_A)).toEqual({ sessions: [], focusedID: undefined })
})

test("selectTracked keeps registry order and drops sessions the server no longer knows", () => {
  const server = [active("ses_1", 1), active("ses_2", 2), active("ses_3", 3)]
  expect(selectTracked(server, ["ses_3", "ses_1", "ses_gone"]).map((s) => s.id)).toEqual(["ses_3", "ses_1"])
})

test("runSpawn provisions via the driver and records + focuses the new session", async () => {
  const { driver, state } = memDriver()
  const summary = await runSpawn({ driver, spawn: { agent: "build", focus: true }, focusFile, url: URL_A })
  expect(state.created).toEqual([summary.id])
  expect(summary.agent).toBe("build")
  expect(await readServerState(focusFile, URL_A)).toEqual({ sessions: [summary.id], focusedID: summary.id })
})

test("runSpawn with focus:false records the session but leaves focus untouched", async () => {
  const { driver } = memDriver()
  await writeServerState(focusFile, URL_A, { sessions: ["ses_existing"], focusedID: "ses_existing" })
  const summary = await runSpawn({ driver, spawn: { agent: "plan", focus: false }, focusFile, url: URL_A })
  expect(summary.id).not.toBe("ses_existing")
  expect(await readServerState(focusFile, URL_A)).toEqual({
    sessions: ["ses_existing", summary.id],
    focusedID: "ses_existing",
  })
})

test("runSwitch validates the id against the registry", async () => {
  await writeServerState(focusFile, URL_A, { sessions: ["ses_1", "ses_2"], focusedID: "ses_1" })
  await runSwitch({ id: "ses_2", focusFile, url: URL_A })
  expect((await readServerState(focusFile, URL_A)).focusedID).toBe("ses_2")
  await expect(runSwitch({ id: "ses_missing", focusFile, url: URL_A })).rejects.toBeInstanceOf(SessionNotFoundError)
})

test("runClose tears down via the driver and moves focus to the last surviving session", async () => {
  const { driver, state } = memDriver()
  await writeServerState(focusFile, URL_A, { sessions: ["ses_1", "ses_2", "ses_3"], focusedID: "ses_3" })
  const next = await runClose({ driver, id: "ses_3", focusFile, url: URL_A })
  expect(state.closed).toEqual(["ses_3"])
  expect(next).toBe("ses_2")
  expect(await readServerState(focusFile, URL_A)).toEqual({ sessions: ["ses_1", "ses_2"], focusedID: "ses_2" })
})

test("runClose keeps focus when a non-focused session is closed", async () => {
  const { driver } = memDriver()
  await writeServerState(focusFile, URL_A, { sessions: ["ses_1", "ses_2", "ses_3"], focusedID: "ses_3" })
  const next = await runClose({ driver, id: "ses_1", focusFile, url: URL_A })
  expect(next).toBe("ses_3")
  expect(await readServerState(focusFile, URL_A)).toEqual({ sessions: ["ses_2", "ses_3"], focusedID: "ses_3" })
})

test("runClose rejects an unknown id before touching the driver", async () => {
  const { driver, state } = memDriver()
  await writeServerState(focusFile, URL_A, { sessions: ["ses_1"], focusedID: "ses_1" })
  await expect(runClose({ driver, id: "ses_x", focusFile, url: URL_A })).rejects.toBeInstanceOf(SessionNotFoundError)
  expect(state.closed).toEqual([])
})

test("the SDK adapter drives spawn and close through the shared driver against the client", async () => {
  const { client, state } = fakeSdk()
  const driver = createClientSessionDriver(toSessionClient(client, "/work"))

  const summary = await runSpawn({ driver, spawn: { agent: "build", focus: true }, focusFile, url: URL_A })
  expect(state.sessions).toHaveLength(1)
  expect(state.sessions[0].directory).toBe("/work")
  expect(summary.id).toBe(state.sessions[0].id)

  const listed = selectTracked(
    await listActiveSessions(client, "/work"),
    (await readServerState(focusFile, URL_A)).sessions,
  )
  expect(listed.map((s) => s.id)).toEqual([summary.id])
  expect(listed[0].agent).toBe("build")

  const next = await runClose({ driver, id: summary.id, focusFile, url: URL_A })
  expect(state.aborted).toEqual([summary.id])
  expect(next).toBeUndefined()
  expect(await readServerState(focusFile, URL_A)).toEqual({ sessions: [], focusedID: undefined })
})

test("listActiveSessions surfaces a server error result as a thrown error", async () => {
  const client = {
    session: {
      async list() {
        return { data: undefined, error: { data: { message: "boom" } } }
      },
    },
  } as any
  await expect(listActiveSessions(client)).rejects.toThrow(/Failed to list session: boom/)
})

test("formatters mark the focused session", () => {
  const sessions = [active("ses_1", 1, { agent: "build" }), active("ses_2", 2, { agent: "plan" })]
  const table = formatSessionsTable(sessions, "ses_2")
  const rows = table.split("\n")
  expect(rows[0]).toContain("ID")
  expect(rows.find((r) => r.includes("ses_2"))!.startsWith("*")).toBe(true)
  expect(rows.find((r) => r.includes("ses_1"))!.startsWith(" ")).toBe(true)

  const json = JSON.parse(formatSessionsJSON(sessions, "ses_2"))
  expect(json).toEqual([
    { id: "ses_1", title: "ses_1 title", agent: "build", directory: null, focused: false },
    { id: "ses_2", title: "ses_2 title", agent: "plan", directory: null, focused: true },
  ])
})
