import { describe, expect, test } from "bun:test"
import {
  adjacentSessionID,
  runStateLabelKey,
  sessionEntryView,
  sessionIDAtIndex,
  shouldRenderSwitcher,
  SESSION_SWITCHER_MIN_SESSIONS,
} from "./session-multiplexer-nav"
import type { SessionSummary } from "./session-manager"

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, spawnedAt: 0, ...extra }
}

describe("shouldRenderSwitcher", () => {
  test("hides for zero or one session, shows from two", () => {
    expect(SESSION_SWITCHER_MIN_SESSIONS).toBe(2)
    expect(shouldRenderSwitcher(0)).toBe(false)
    expect(shouldRenderSwitcher(1)).toBe(false)
    expect(shouldRenderSwitcher(2)).toBe(true)
    expect(shouldRenderSwitcher(5)).toBe(true)
  })
})

describe("adjacentSessionID", () => {
  const order = ["a", "b", "c"]

  test("returns undefined when there are no sessions", () => {
    expect(adjacentSessionID([], "a", 1)).toBeUndefined()
    expect(adjacentSessionID([], undefined, -1)).toBeUndefined()
  })

  test("moves to the next session and wraps at the end", () => {
    expect(adjacentSessionID(order, "a", 1)).toBe("b")
    expect(adjacentSessionID(order, "b", 1)).toBe("c")
    expect(adjacentSessionID(order, "c", 1)).toBe("a")
  })

  test("moves to the previous session and wraps at the start", () => {
    expect(adjacentSessionID(order, "c", -1)).toBe("b")
    expect(adjacentSessionID(order, "b", -1)).toBe("a")
    expect(adjacentSessionID(order, "a", -1)).toBe("c")
  })

  test("seeds from an end when nothing is focused", () => {
    expect(adjacentSessionID(order, undefined, 1)).toBe("a")
    expect(adjacentSessionID(order, undefined, -1)).toBe("c")
  })

  test("treats an unknown focus id like no focus", () => {
    expect(adjacentSessionID(order, "zzz", 1)).toBe("a")
    expect(adjacentSessionID(order, "zzz", -1)).toBe("c")
  })

  test("single session cycles to itself", () => {
    expect(adjacentSessionID(["only"], "only", 1)).toBe("only")
    expect(adjacentSessionID(["only"], "only", -1)).toBe("only")
  })
})

describe("sessionIDAtIndex", () => {
  const order = ["a", "b", "c"]

  test("resolves 1-based positions", () => {
    expect(sessionIDAtIndex(order, 1)).toBe("a")
    expect(sessionIDAtIndex(order, 3)).toBe("c")
  })

  test("returns undefined for out-of-range or non-integer positions", () => {
    expect(sessionIDAtIndex(order, 0)).toBeUndefined()
    expect(sessionIDAtIndex(order, 4)).toBeUndefined()
    expect(sessionIDAtIndex(order, -1)).toBeUndefined()
    expect(sessionIDAtIndex(order, 1.5)).toBeUndefined()
    expect(sessionIDAtIndex([], 1)).toBeUndefined()
  })
})

describe("runStateLabelKey", () => {
  test("maps run state to i18n key", () => {
    expect(runStateLabelKey("running")).toBe("session.multiplexer.status.running")
    expect(runStateLabelKey("idle")).toBe("session.multiplexer.status.idle")
  })
})

describe("sessionEntryView", () => {
  test("marks the focused session and passes through identifying info", () => {
    const view = sessionEntryView({
      session: summary("a", { title: "Fix bug", agent: "build", directory: "/repo" }),
      focusedID: "a",
      untitled: "Untitled session",
      status: "running",
    })
    expect(view).toEqual({
      id: "a",
      title: "Fix bug",
      agent: "build",
      directory: "/repo",
      focused: true,
      status: "running",
    })
  })

  test("falls back to the untitled label for blank titles", () => {
    expect(
      sessionEntryView({
        session: summary("a", { title: "   " }),
        focusedID: "b",
        untitled: "Untitled",
        status: "idle",
      }).title,
    ).toBe("Untitled")
    expect(
      sessionEntryView({ session: summary("a"), focusedID: "b", untitled: "Untitled", status: "idle" }).title,
    ).toBe("Untitled")
    expect(
      sessionEntryView({ session: summary("a"), focusedID: "b", untitled: "Untitled", status: "idle" }).focused,
    ).toBe(false)
  })
})
