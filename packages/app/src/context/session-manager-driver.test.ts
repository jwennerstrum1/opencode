import { describe, expect, test } from "bun:test"
import { createClientSessionDriver, type SessionClient } from "./session-manager-driver"

// An in-memory stand-in for the SDK v2 session client that records the calls
// the adapter makes, so we can assert the mapping onto real primitives.
function fakeClient(overrides: Partial<SessionClient> = {}) {
  const createCalls: unknown[] = []
  const interruptCalls: string[] = []
  const client: SessionClient = {
    async create(parameters) {
      createCalls.push(parameters)
      return { data: { id: "sess_1", title: "hello", agent: parameters?.agent, directory: "/repo" } }
    },
    async interrupt(parameters) {
      interruptCalls.push(parameters.sessionID)
      return {}
    },
    ...overrides,
  }
  return { client, createCalls, interruptCalls }
}

describe("createClientSessionDriver", () => {
  test("create maps spawn input onto session.create and returns identity", async () => {
    const { client, createCalls } = fakeClient()
    const driver = createClientSessionDriver(client)

    const created = await driver.create({
      agent: "build",
      model: { id: "sonnet", providerID: "anthropic" },
      directory: "/repo",
    })

    expect(createCalls).toEqual([
      { agent: "build", model: { id: "sonnet", providerID: "anthropic" }, location: { directory: "/repo" } },
    ])
    expect(created).toEqual({ id: "sess_1", title: "hello", agent: "build", directory: "/repo" })
  })

  test("create omits location when no directory is given", async () => {
    const { client, createCalls } = fakeClient()
    const driver = createClientSessionDriver(client)

    await driver.create({ agent: "plan" })

    expect(createCalls).toEqual([{ agent: "plan", model: undefined, location: undefined }])
  })

  test("create throws when the client returns no session id", async () => {
    const { client } = fakeClient({ async create() {
      return { data: undefined }
    } })
    const driver = createClientSessionDriver(client)

    await expect(driver.create({})).rejects.toThrow(/no session id/)
  })

  test("close interrupts the session", async () => {
    const { client, interruptCalls } = fakeClient()
    const driver = createClientSessionDriver(client)

    await driver.close("sess_1")

    expect(interruptCalls).toEqual(["sess_1"])
  })

  test("close throws when the client reports an error", async () => {
    const { client } = fakeClient({ async interrupt() {
      return { error: { message: "boom" } }
    } })
    const driver = createClientSessionDriver(client)

    await expect(driver.close("sess_1")).rejects.toThrow(/failed to close session sess_1/)
  })
})
