// TUI-facing session multiplexer.
//
// This is the glue between the framework-agnostic multiplexer core
// (`session-manager.ts`) and the app: it mirrors the manager's registry/focus
// into a reactive SolidJS store, drives every side effect through the core's
// `SessionDriver` (via `createClientSessionDriver` — no second session-creation
// path), and exposes focus navigation (next/prev/jump/close) for the switcher's
// commands and keybindings.
//
// The factory `createSessionMultiplexer` holds all of the behavior and is pure
// enough to unit-test with an in-memory driver; the SolidJS context below is a
// thin binding that constructs the real driver from the active server's SDK and
// wires focus changes into the existing tab/routing layer.

import { createSimpleContext } from "@opencode-ai/ui/context"
import { onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { sessionHref } from "@/utils/session-route"
import { normalizeSessionInfo } from "@/utils/session"
import { useGlobal } from "./global"
import { useServer } from "./server"
import { useTabs } from "./tabs"
import { createSessionManager, type SessionDriver, type SessionSummary, type SpawnInput } from "./session-manager"
import { createClientSessionDriver, type SessionClient } from "./session-manager-driver"
import { adjacentSessionID, sessionIDAtIndex } from "./session-multiplexer-nav"

export type SessionMultiplexerState = {
  sessions: SessionSummary[]
  focusedID?: string
}

// Side effects the multiplexer fans out to the surrounding app. Kept as
// injectable hooks so the core coordination logic stays testable without the
// router or tab store.
export type SessionMultiplexerHooks = {
  // A session was registered (spawned). Use to make it addressable in the UI.
  onSpawn?: (session: SessionSummary) => void
  // Focus moved to this session (spawn-with-focus, explicit focus, or the
  // survivor picked after a close). Use to route to it.
  onFocus?: (session: SessionSummary) => void
  // A session stopped being tracked. Use to drop its tab.
  onClose?: (id: string) => void
}

export function createSessionMultiplexer(driver: SessionDriver, hooks: SessionMultiplexerHooks = {}) {
  const manager = createSessionManager(driver)
  const [state, setState] = createStore<SessionMultiplexerState>({ sessions: [], focusedID: undefined })

  const unsubscribe = manager.subscribe((sessions, focusedID) => {
    setState("sessions", reconcile(sessions, { key: "id" }))
    setState("focusedID", focusedID)
  })

  const order = () => state.sessions.map((session) => session.id)
  const summaryOf = (id: string | undefined) => (id ? state.sessions.find((session) => session.id === id) : undefined)

  const focusID = (id: string | undefined) => {
    if (!id) return undefined
    const session = manager.focus(id)
    hooks.onFocus?.(session)
    return session
  }

  const spawn = async (input: SpawnInput = {}) => {
    const session = await manager.spawn(input)
    hooks.onSpawn?.(session)
    // spawn focuses by default; mirror that into routing.
    if (input.focus !== false && state.focusedID === session.id) hooks.onFocus?.(session)
    return session
  }

  const close = async (id: string) => {
    await manager.close(id)
    hooks.onClose?.(id)
    // Route to the survivor the core moved focus to, if any.
    const survivor = summaryOf(state.focusedID)
    if (survivor) hooks.onFocus?.(survivor)
  }

  const closeFocused = async () => {
    const id = state.focusedID
    if (id) await close(id)
  }

  return {
    state,
    manager,
    spawn,
    focus: focusID,
    focusNext: () => focusID(adjacentSessionID(order(), state.focusedID, 1)),
    focusPrev: () => focusID(adjacentSessionID(order(), state.focusedID, -1)),
    focusIndex: (position: number) => focusID(sessionIDAtIndex(order(), position)),
    close,
    closeFocused,
    dispose: unsubscribe,
  }
}

export type SessionMultiplexer = ReturnType<typeof createSessionMultiplexer>

export const { use: useSessionMultiplexer, provider: SessionMultiplexerProvider } = createSimpleContext({
  name: "SessionMultiplexer",
  gate: false,
  init: () => {
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const navigate = useNavigate()

    // The active server's session API — the same protocol-compatible client the
    // prompt uses to create sessions and interrupt runs (see
    // components/prompt-input/submit.ts). Resolved per-call so switching the
    // active server transparently retargets. Adapted to the core's SessionClient
    // shape (its `create` returns unwrapped session info; `interrupt` returns
    // void) so the core adapter — not a second lifecycle path — owns the mapping.
    const activeSessionApi = () => {
      const conn = server.current
      if (!conn) throw new Error("session-multiplexer: no active server")
      return global.ensureServerCtx(conn).sdk.api.session
    }

    const sessionClient: SessionClient = {
      async create(parameters) {
        const info = normalizeSessionInfo(
          await activeSessionApi().create({
            agent: parameters?.agent,
            model: parameters?.model,
            location: parameters?.location?.directory ? { directory: parameters.location.directory } : undefined,
          }),
        )
        return { data: { id: info.id, title: info.title, agent: info.agent, directory: info.directory } }
      },
      async interrupt(parameters) {
        await activeSessionApi().interrupt(parameters)
        return {}
      },
    }

    const driver: SessionDriver = createClientSessionDriver(sessionClient)

    const ensureTab = (session: SessionSummary) => tabs.addSessionTab({ server: server.key, sessionId: session.id })

    const mux = createSessionMultiplexer(driver, {
      onSpawn: (session) => ensureTab(session),
      onFocus: (session) => {
        ensureTab(session)
        navigate(sessionHref(server.key, session.id))
      },
      onClose: (id) => tabs.removeSessionTab({ server: server.key, sessionId: id }),
    })

    onCleanup(mux.dispose)
    return mux
  },
})
