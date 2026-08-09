// Pure navigation/presentation helpers for the TUI session switcher.
//
// The switcher is a thin UI over the session-multiplexer core. Everything that
// can be reasoned about without SolidJS reactivity or the SDK lives here so it
// can be unit-tested in isolation, mirroring how the core keeps
// `nextFocusAfterClose` a pure function.

import type { SessionSummary } from "./session-manager"

// The switcher only becomes visible once there is genuinely something to switch
// between. With zero or one session the app looks and behaves exactly like the
// single-session flow — no extra chrome.
export const SESSION_SWITCHER_MIN_SESSIONS = 2

export function shouldRenderSwitcher(count: number): boolean {
  return count >= SESSION_SWITCHER_MIN_SESSIONS
}

// Cycle focus through the sessions in spawn order, wrapping at both ends.
// `offset` is +1 (next) or -1 (previous). Returns undefined only when there are
// no sessions. When nothing is focused yet, next starts at the first session and
// previous at the last.
export function adjacentSessionID(order: string[], focusedID: string | undefined, offset: number): string | undefined {
  if (order.length === 0) return undefined
  const index = focusedID ? order.indexOf(focusedID) : -1
  if (index === -1) return offset >= 0 ? order[0] : order[order.length - 1]
  const step = ((offset % order.length) + order.length) % order.length
  return order[(index + step) % order.length]
}

// Jump-to-index using 1-based positions (mirrors the existing `mod+1..9` tab
// shortcuts). Out-of-range positions resolve to undefined so callers no-op.
export function sessionIDAtIndex(order: string[], position: number): string | undefined {
  if (!Number.isInteger(position) || position < 1 || position > order.length) return undefined
  return order[position - 1]
}

export type SessionRunState = "running" | "idle"

export function runStateLabelKey(state: SessionRunState) {
  return state === "running"
    ? ("session.multiplexer.status.running" as const)
    : ("session.multiplexer.status.idle" as const)
}

// The identifying info shown on a session entry, resolved to display-ready
// values. `title` always falls back so an unnamed session never renders blank.
export type SessionEntryView = {
  id: string
  title: string
  agent?: string
  directory?: string
  focused: boolean
  status: SessionRunState
}

export function sessionEntryView(input: {
  session: SessionSummary
  focusedID: string | undefined
  untitled: string
  status: SessionRunState
}): SessionEntryView {
  const title = input.session.title?.trim()
  return {
    id: input.session.id,
    title: title && title.length > 0 ? title : input.untitled,
    agent: input.session.agent,
    directory: input.session.directory,
    focused: input.session.id === input.focusedID,
    status: input.status,
  }
}

// Build the ordered list of switcher entries the component renders. Kept pure so
// the switcher's presentation logic is testable without mounting SolidJS.
export function buildSwitcherEntries(input: {
  sessions: SessionSummary[]
  focusedID: string | undefined
  untitled: string
  statusOf: (id: string) => SessionRunState
}): SessionEntryView[] {
  return input.sessions.map((session) =>
    sessionEntryView({
      session,
      focusedID: input.focusedID,
      untitled: input.untitled,
      status: input.statusOf(session.id),
    }),
  )
}
