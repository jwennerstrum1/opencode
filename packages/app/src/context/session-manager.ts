// Session multiplexer core (non-UI).
//
// A framework-agnostic layer that manages several concurrent agent sessions
// and a single focused session. It owns only the multiplexing bookkeeping —
// which sessions exist, their insertion order, and which one has focus — and
// delegates every side effect (creating a session, tearing one down) to an
// injected SessionDriver so it can reuse the existing session/provider/agent
// primitives instead of duplicating them. The real driver
// (createClientSessionDriver) binds to the OpenCode SDK v2 session client;
// tests bind an in-memory driver.
//
// This is additive: nothing here is wired into the existing single-session
// flows. A manager that only ever spawns one session behaves exactly like a
// single-session workflow — one session, always focused.

export type SessionModelRef = {
  id: string
  providerID: string
  variant?: string
}

export type SpawnInput = {
  agent?: string
  model?: SessionModelRef
  directory?: string
  title?: string
  // Whether the newly spawned session takes focus. Defaults to true.
  focus?: boolean
}

export type SessionSummary = {
  id: string
  title?: string
  agent?: string
  directory?: string
  spawnedAt: number
  // Wall-clock of the last time this session was focused, if ever.
  lastFocusedAt?: number
}

// The seam between the multiplexer and the underlying session primitives.
// `create` provisions a real session and returns its identity; `close` tears
// one down. Keeping this interface tiny is deliberate: the manager owns focus
// and registry logic, the driver owns I/O.
export interface SessionDriver {
  create(input: SpawnInput): Promise<{ id: string; title?: string; agent?: string; directory?: string }>
  close(id: string): Promise<void>
}

export type SessionManagerOptions = {
  // Injectable clock so spawn/focus timestamps are deterministic under test.
  now?: () => number
}

export type SessionManagerListener = (sessions: SessionSummary[], focusedID?: string) => void

// Choose which session receives focus once `closingID` is gone. Prefer the
// most recently focused survivor; fall back to the last one spawned; undefined
// when nothing remains. Pure so it can be reasoned about in isolation.
export function nextFocusAfterClose(
  survivors: SessionSummary[],
  closingID: string,
  focusedID?: string,
): string | undefined {
  if (focusedID !== closingID) return focusedID
  const remaining = survivors.filter((session) => session.id !== closingID)
  if (remaining.length === 0) return undefined
  const everFocused = remaining.filter((session) => session.lastFocusedAt !== undefined)
  if (everFocused.length > 0)
    return everFocused.reduce((best, session) =>
      (session.lastFocusedAt ?? 0) > (best.lastFocusedAt ?? 0) ? session : best,
    ).id
  return remaining[remaining.length - 1].id
}

export function createSessionManager(driver: SessionDriver, options?: SessionManagerOptions) {
  const now = options?.now ?? Date.now
  const sessions = new Map<string, SessionSummary>()
  const order: string[] = []
  const listeners = new Set<SessionManagerListener>()
  let focusedID: string | undefined

  const list = () => order.map((id) => sessions.get(id)!).filter((session) => session !== undefined)

  const notify = () => {
    const snapshot = list()
    listeners.forEach((listener) => listener(snapshot, focusedID))
  }

  const requireSession = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new Error(`session-manager: unknown session ${id}`)
    return session
  }

  const applyFocus = (id: string) => {
    focusedID = id
    sessions.set(id, { ...requireSession(id), lastFocusedAt: now() })
  }

  return {
    // Provision a new session through the driver and register it. Focuses it
    // unless input.focus is explicitly false.
    async spawn(input: SpawnInput = {}) {
      const created = await driver.create(input)
      if (sessions.has(created.id)) throw new Error(`session-manager: duplicate session ${created.id}`)
      sessions.set(created.id, {
        id: created.id,
        title: created.title ?? input.title,
        agent: created.agent ?? input.agent,
        directory: created.directory ?? input.directory,
        spawnedAt: now(),
      })
      order.push(created.id)
      if (input.focus !== false) applyFocus(created.id)
      notify()
      return sessions.get(created.id)!
    },

    // All tracked sessions, in the order they were spawned.
    list,

    // The focused session, or undefined when none are tracked.
    focused: () => (focusedID ? sessions.get(focusedID) : undefined),

    // Switch focus to an already-tracked session.
    focus(id: string) {
      requireSession(id)
      applyFocus(id)
      notify()
      return sessions.get(id)!
    },

    // Tear down a session through the driver and stop tracking it, moving
    // focus to a survivor when the closed session held focus.
    async close(id: string) {
      requireSession(id)
      await driver.close(id)
      const next = nextFocusAfterClose(list(), id, focusedID)
      sessions.delete(id)
      order.splice(order.indexOf(id), 1)
      focusedID = next
      notify()
    },

    // Subscribe to registry/focus changes; returns an unsubscribe fn.
    subscribe(listener: SessionManagerListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type SessionManager = ReturnType<typeof createSessionManager>
