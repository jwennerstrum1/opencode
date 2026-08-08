import { describe, expect, test } from "bun:test"
import { createSessionManager, nextFocusAfterClose, type SessionDriver, type SessionSummary } from "./session-manager"

// A real in-memory SessionDriver (not a mock framework): it provisions
// deterministic ids and records lifecycle calls so tests can assert the
// manager drives the underlying primitives.
function memoryDriver() {
  let seq = 0
  const created: string[] = []
  const closed: string[] = []
  const driver: SessionDriver = {
    async create(input) {
      const id = `s${++seq}`
      created.push(id)
      return { id, title: input.title, agent: input.agent, directory: input.directory }
    },
    async close(id) {
      closed.push(id)
    },
  }
  return { driver, created, closed }
}

// Monotonic clock so spawnedAt/lastFocusedAt ordering is deterministic.
function monotonicClock() {
  let t = 0
  return () => ++t
}

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, spawnedAt: 0, ...extra }
}

describe("nextFocusAfterClose", () => {
  test("keeps focus when a non-focused session closes", () => {
    expect(nextFocusAfterClose([summary("a"), summary("b")], "a", "b")).toBe("b")
  })

  test("prefers the most recently focused survivor", () => {
    const survivors = [summary("a", { lastFocusedAt: 5 }), summary("b", { lastFocusedAt: 9 }), summary("c")]
    expect(nextFocusAfterClose(survivors, "a", "a")).toBe("b")
  })

  test("falls back to the last spawned survivor when none were ever focused", () => {
    const survivors = [summary("a", { lastFocusedAt: 5 }), summary("b"), summary("c")]
    expect(nextFocusAfterClose(survivors, "a", "a")).toBe("c")
  })

  test("returns undefined when the last session closes", () => {
    expect(nextFocusAfterClose([summary("a")], "a", "a")).toBeUndefined()
  })
})

describe("createSessionManager", () => {
  test("single-session workflow is unchanged: one spawn yields one focused session", async () => {
    const { driver, created } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    const session = await manager.spawn({ agent: "build", directory: "/repo" })

    expect(created).toEqual(["s1"])
    expect(manager.list()).toHaveLength(1)
    expect(manager.focused()?.id).toBe(session.id)
    expect(session.agent).toBe("build")
    expect(session.directory).toBe("/repo")
  })

  test("spawn appends in insertion order and focuses the newest by default", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    await manager.spawn()
    await manager.spawn()
    const third = await manager.spawn()

    expect(manager.list().map((s) => s.id)).toEqual(["s1", "s2", "s3"])
    expect(manager.focused()?.id).toBe(third.id)
  })

  test("spawn with focus:false leaves focus untouched", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    const first = await manager.spawn()
    await manager.spawn({ focus: false })

    expect(manager.list()).toHaveLength(2)
    expect(manager.focused()?.id).toBe(first.id)
  })

  test("focus switches the active session and rejects unknown ids", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    const first = await manager.spawn()
    await manager.spawn()
    manager.focus(first.id)

    expect(manager.focused()?.id).toBe(first.id)
    expect(() => manager.focus("missing")).toThrow(/unknown session/)
  })

  test("closing the focused session moves focus to the most recently focused survivor", async () => {
    const { driver, closed } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    const a = await manager.spawn()
    await manager.spawn()
    const c = await manager.spawn()
    manager.focus(a.id)

    await manager.close(a.id)

    expect(closed).toEqual([a.id])
    expect(manager.list().map((s) => s.id)).toEqual(["s2", c.id])
    expect(manager.focused()?.id).toBe(c.id)
  })

  test("closing the focused session falls back to the last spawned when no survivor was focused", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    const a = await manager.spawn()
    await manager.spawn({ focus: false })
    const c = await manager.spawn({ focus: false })

    await manager.close(a.id)

    expect(manager.focused()?.id).toBe(c.id)
  })

  test("closing a non-focused session preserves the current focus", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    const a = await manager.spawn()
    const b = await manager.spawn()

    await manager.close(a.id)

    expect(manager.list().map((s) => s.id)).toEqual([b.id])
    expect(manager.focused()?.id).toBe(b.id)
  })

  test("closing the last session clears focus", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })

    const only = await manager.spawn()
    await manager.close(only.id)

    expect(manager.list()).toHaveLength(0)
    expect(manager.focused()).toBeUndefined()
  })

  test("close rejects unknown ids", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })
    await expect(manager.close("missing")).rejects.toThrow(/unknown session/)
  })

  test("subscribers observe spawn, focus, and close, and can unsubscribe", async () => {
    const { driver } = memoryDriver()
    const manager = createSessionManager(driver, { now: monotonicClock() })
    const events: Array<{ count: number; focused?: string }> = []
    const unsubscribe = manager.subscribe((sessions, focused) => events.push({ count: sessions.length, focused }))

    const a = await manager.spawn()
    const b = await manager.spawn()
    manager.focus(a.id)
    await manager.close(a.id)

    expect(events).toEqual([
      { count: 1, focused: a.id },
      { count: 2, focused: b.id },
      { count: 2, focused: a.id },
      { count: 1, focused: b.id },
    ])

    unsubscribe()
    await manager.spawn()
    expect(events).toHaveLength(4)
  })
})
