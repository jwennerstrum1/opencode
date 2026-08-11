import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionMultiplexer, type SessionMultiplexerHooks } from "./session-multiplexer"
import type { SessionDriver, SpawnInput } from "./session-manager"
import { nextTabAfterClose } from "./closed-tabs"
import type { SessionTab } from "./tabs"
import type { ServerConnection } from "./server"

// In-memory driver mirroring the core's test seam: create() mints sequential
// ids and echoes identifying info; close() is a no-op that records calls.
function fakeDriver() {
  let counter = 0
  const created: SpawnInput[] = []
  const closed: string[] = []
  const driver: SessionDriver = {
    async create(input) {
      created.push(input)
      return { id: `s${++counter}`, title: input.title, agent: input.agent, directory: input.directory }
    },
    async close(id) {
      closed.push(id)
    },
  }
  return { driver, created, closed }
}

function recordingHooks() {
  const spawned: string[] = []
  const focused: string[] = []
  const closed: string[] = []
  const hooks: SessionMultiplexerHooks = {
    onSpawn: (s) => spawned.push(s.id),
    onFocus: (s) => focused.push(s.id),
    onClose: (id) => closed.push(id),
  }
  return { hooks, spawned, focused, closed }
}

// Runs `fn` inside a reactive root so the multiplexer's store/subscribe work,
// disposing afterward.
function withRoot<T>(fn: (dispose: () => void) => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      Promise.resolve(fn(dispose))
        .then((value) => {
          dispose()
          resolve(value)
        })
        .catch((err) => {
          dispose()
          reject(err)
        })
    })
  })
}

describe("createSessionMultiplexer", () => {
  test("spawn registers a session, focuses it, and reflects it reactively", async () => {
    await withRoot(async () => {
      const { driver } = fakeDriver()
      const { hooks, spawned, focused } = recordingHooks()
      const mux = createSessionMultiplexer(driver, hooks)

      const session = await mux.spawn({ title: "First", agent: "build", directory: "/repo" })

      expect(session.id).toBe("s1")
      expect(mux.state.sessions.map((s) => s.id)).toEqual(["s1"])
      expect(mux.state.focusedID).toBe("s1")
      expect(mux.state.sessions[0]).toMatchObject({ title: "First", agent: "build", directory: "/repo" })
      expect(spawned).toEqual(["s1"])
      expect(focused).toEqual(["s1"])
    })
  })

  test("spawn with focus:false registers without routing focus", async () => {
    await withRoot(async () => {
      const { driver } = fakeDriver()
      const { hooks, spawned, focused } = recordingHooks()
      const mux = createSessionMultiplexer(driver, hooks)

      await mux.spawn()
      focused.length = 0
      await mux.spawn({ focus: false })

      expect(mux.state.sessions.map((s) => s.id)).toEqual(["s1", "s2"])
      expect(mux.state.focusedID).toBe("s1")
      expect(spawned).toEqual(["s1", "s2"])
      expect(focused).toEqual([])
    })
  })

  test("focusNext / focusPrev cycle in spawn order and route each move", async () => {
    await withRoot(async () => {
      const { driver } = fakeDriver()
      const { hooks, focused } = recordingHooks()
      const mux = createSessionMultiplexer(driver, hooks)

      await mux.spawn()
      await mux.spawn()
      await mux.spawn() // focused s3
      focused.length = 0

      mux.focusNext() // wraps to s1
      expect(mux.state.focusedID).toBe("s1")
      mux.focusNext()
      expect(mux.state.focusedID).toBe("s2")
      mux.focusPrev()
      expect(mux.state.focusedID).toBe("s1")
      mux.focusPrev() // wraps to s3
      expect(mux.state.focusedID).toBe("s3")
      expect(focused).toEqual(["s1", "s2", "s1", "s3"])
    })
  })

  test("focusIndex jumps to 1-based positions and no-ops when out of range", async () => {
    await withRoot(async () => {
      const { driver } = fakeDriver()
      const { hooks, focused } = recordingHooks()
      const mux = createSessionMultiplexer(driver, hooks)

      await mux.spawn()
      await mux.spawn()
      focused.length = 0

      mux.focusIndex(1)
      expect(mux.state.focusedID).toBe("s1")
      mux.focusIndex(9) // out of range -> no move, no route
      expect(mux.state.focusedID).toBe("s1")
      expect(focused).toEqual(["s1"])
    })
  })

  test("close drives the driver, drops the tab, and routes to the survivor", async () => {
    await withRoot(async () => {
      const { driver, closed: driverClosed } = fakeDriver()
      const { hooks, focused, closed } = recordingHooks()
      const mux = createSessionMultiplexer(driver, hooks)

      await mux.spawn() // s1
      await mux.spawn() // s2 (focused)
      focused.length = 0

      await mux.close("s2")

      expect(driverClosed).toEqual(["s2"])
      expect(closed).toEqual(["s2"])
      expect(mux.state.sessions.map((s) => s.id)).toEqual(["s1"])
      expect(mux.state.focusedID).toBe("s1")
      expect(focused).toEqual(["s1"]) // routed to survivor
    })
  })

  // Regression for finding 8ac7aaeb: the tab layer runs its own removal
  // navigation to a positionally-adjacent survivor when the removed tab is still
  // active, and that deferred navigation used to override the multiplexer's
  // post-close focus — so with 3+ sessions the focus indicator (core survivor)
  // and the actually-open session diverged. This models the tab layer faithfully
  // (real nextTabAfterClose, recent/active tracking, and startTransition-style
  // deferral) and asserts the route ends on the core's survivor.
  test("closing the focused session routes to the core survivor, not the tab-strip's", async () => {
    await withRoot(async () => {
      const { driver } = fakeDriver()

      const server = "local\nhttp://localhost:4096" as ServerConnection.Key
      const tabs: SessionTab[] = []
      let recentKey: string | undefined
      let route: string | undefined
      const deferred: Array<() => void> = []
      const flush = () => {
        while (deferred.length) deferred.shift()!()
      }
      const addTab = (id: string) => {
        if (!tabs.some((tab) => tab.sessionId === id)) tabs.push({ type: "session", server, sessionId: id })
      }
      // Models tabs.select: mark active + navigate synchronously.
      const select = (id: string) => {
        addTab(id)
        recentKey = id
        route = id
      }
      // Models tabs.removeSessionTab -> removeTab: only the active tab triggers
      // the deferred positional navigation, via the real nextTabAfterClose.
      const removeSessionTab = (id: string) => {
        const index = tabs.findIndex((tab) => tab.sessionId === id)
        if (index === -1) return
        const active = recentKey === id && route !== "/"
        const next = nextTabAfterClose(tabs, index, active)
        tabs.splice(index, 1)
        deferred.push(() => {
          if (next === null) {
            recentKey = undefined
            route = "/"
          } else if (next && next.type === "session") {
            select(next.sessionId)
          }
        })
      }

      const mux = createSessionMultiplexer(driver, {
        onSpawn: (session) => addTab(session.id),
        onFocus: (session) => select(session.id),
        onClose: (id) => removeSessionTab(id),
      })

      await mux.spawn() // s1
      await mux.spawn() // s2
      await mux.spawn() // s3 (focused)
      mux.focus("s1") // make s1 the most-recently-focused survivor-to-be
      mux.focus("s3") // refocus s3; survivors {s1, s2}, core MRU survivor = s1
      flush()

      await mux.close("s3")
      flush() // drain any deferred tab-strip navigation

      // Positional survivor for s3 (last tab) would be s2; the core picks s1.
      expect(mux.state.focusedID).toBe("s1")
      expect(route).toBe("s1")
    })
  })

  test("closeFocused closes the focused session; no-op when none", async () => {
    await withRoot(async () => {
      const { driver, closed: driverClosed } = fakeDriver()
      const { hooks } = recordingHooks()
      const mux = createSessionMultiplexer(driver, hooks)

      await mux.closeFocused() // nothing focused yet
      expect(driverClosed).toEqual([])

      await mux.spawn() // s1 focused
      await mux.closeFocused()
      expect(driverClosed).toEqual(["s1"])
      expect(mux.state.sessions).toEqual([])
      expect(mux.state.focusedID).toBeUndefined()
    })
  })

  test("dispose stops mirroring further manager changes", async () => {
    await withRoot(async () => {
      const { driver } = fakeDriver()
      const { hooks } = recordingHooks()
      const mux = createSessionMultiplexer(driver, hooks)

      await mux.spawn()
      mux.dispose()
      await mux.manager.spawn() // manager advances, store must not follow

      expect(mux.state.sessions.map((s) => s.id)).toEqual(["s1"])
    })
  })
})
