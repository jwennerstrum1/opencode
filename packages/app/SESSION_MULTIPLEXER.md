# Session Multiplexer — Core Layer

Foundation for running multiple concurrent agent sessions and switching focus
between them. This document covers the **non-UI core** only; the TUI
session-switcher, CLI commands, and web wiring land as separate follow-ups.

## Goal

Let a user spawn several agent sessions, list them, switch focus between them,
and close them — reusing the existing session/provider/agent primitives rather
than rewriting session lifecycle. Single-session workflows must keep working
unchanged; everything here is additive.

## Design

The core is one small, framework-agnostic module,
`src/context/session-manager.ts`. It owns exactly the multiplexing bookkeeping
and nothing else:

- **which sessions exist** and their spawn order,
- **which session has focus**,
- **when each was last focused** (used to pick a sensible focus target when the
  focused session closes).

Every side effect — actually creating a session, tearing one down — is pushed
behind a tiny `SessionDriver` seam:

```ts
interface SessionDriver {
  create(input: SpawnInput): Promise<{ id; title?; agent?; directory? }>
  close(id: string): Promise<void>
}
```

The manager owns focus/registry logic; the driver owns I/O. This is what keeps
the core a thin layer over existing primitives instead of a rewrite, and it is
what makes the core trivially unit-testable without a running server.

### Data model

```ts
type SessionSummary = {
  id: string
  title?: string
  agent?: string
  directory?: string
  spawnedAt: number
  lastFocusedAt?: number
}
```

The manager holds a `Map<id, SessionSummary>`, an insertion-order id list, and a
single `focusedID`. That is the whole model — no new lifecycle verbs, no sync
machinery. A session's rich state (messages, permissions, cost, …) continues to
live in the existing session primitives; the multiplexer only tracks identity
and focus.

### Operations

- `spawn(input)` — create a session via the driver, register it at the end of
  the order, and focus it unless `input.focus === false`.
- `list()` — the tracked sessions, in spawn order.
- `focused()` — the focused session, or `undefined`.
- `focus(id)` — switch focus to an already-tracked session.
- `close(id)` — tear the session down via the driver and stop tracking it. When
  the closed session held focus, focus moves to the **most recently focused
  survivor**, falling back to the **last spawned** survivor, and to `undefined`
  when nothing remains. This fallback is a pure function, `nextFocusAfterClose`,
  so it is verified in isolation.
- `subscribe(listener)` — observe registry/focus changes (returns an
  unsubscribe). This is the binding point future UIs (TUI/web) use.

### Hooking into existing session code

`src/context/session-manager-driver.ts` provides `createClientSessionDriver`,
which binds the `SessionDriver` to the OpenCode SDK v2 session client
(`OpencodeClient["session"]`):

- `create` → `client.session.create({ agent, model, location })`, the same call
  the web app already uses in `components/prompt-input/submit.ts`.
- `close` → `client.session.interrupt({ sessionID })`, the lifecycle primitive
  the v2 client exposes to detach and stop active execution.

Durable archival/deletion is intentionally **not** part of the core `close`
contract — the core only guarantees a session stops being tracked and driven.
Wiring durable archive semantics (and the focus/route integration in
`context/tabs.tsx`) is deferred to the UI follow-up.

## Additivity

Nothing existing is modified. A manager that only ever spawns one session
behaves exactly like today's single-session flow: one session, always focused.
This invariant is pinned by a test.

## Testing

- `session-manager.test.ts` — pure focus-fallback logic plus the full
  spawn/list/focus/close lifecycle over an in-memory `SessionDriver`.
- `session-manager-driver.test.ts` — the adapter's mapping onto the SDK client
  primitives, including error propagation.

Browser/Playwright E2E is deferred with the UI: there is no user-visible surface
yet, so the appropriate coverage for this increment is the unit suite above.
Run from `packages/app`: `bun test ./src/context/session-manager.test.ts
./src/context/session-manager-driver.test.ts`.
