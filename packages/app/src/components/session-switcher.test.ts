import { describe, expect, test } from "bun:test"
import { SESSION_SWITCHER_KEYBINDS } from "./session-switcher"
import { buildSwitcherEntries } from "@/context/session-multiplexer-nav"
import type { SessionSummary } from "@/context/session-manager"

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, spawnedAt: 0, ...extra }
}

describe("SessionSwitcher entries", () => {
  const sessions = [
    summary("s1", { title: "Fix token refresh", agent: "build", directory: "/repo" }),
    summary("s2", { agent: "plan", directory: "/repo/pkg" }),
  ]

  test("maps every session in order with focus + status resolved", () => {
    const entries = buildSwitcherEntries({
      sessions,
      focusedID: "s2",
      untitled: "Untitled session",
      statusOf: (id) => (id === "s1" ? "running" : "idle"),
    })

    expect(entries).toEqual([
      { id: "s1", title: "Fix token refresh", agent: "build", directory: "/repo", focused: false, status: "running" },
      { id: "s2", title: "Untitled session", agent: "plan", directory: "/repo/pkg", focused: true, status: "idle" },
    ])
  })

  test("exactly one entry is focused", () => {
    const entries = buildSwitcherEntries({
      sessions,
      focusedID: "s1",
      untitled: "Untitled session",
      statusOf: () => "idle",
    })
    expect(entries.filter((entry) => entry.focused).map((entry) => entry.id)).toEqual(["s1"])
  })
})

describe("SESSION_SWITCHER_KEYBINDS", () => {
  // Guards against silently colliding with the existing tab shortcuts
  // (ctrl+tab, mod+option+arrows, mod+1..9, mod+w, mod+shift+t).
  const existingTabKeybinds = new Set([
    "mod+option+arrowleft",
    "ctrl+shift+tab",
    "mod+option+arrowright",
    "ctrl+tab",
    "mod+w",
    "mod+shift+t",
    ...Array.from({ length: 9 }, (_, i) => `mod+${i + 1}`),
  ])

  test("switcher chords are unique and do not shadow existing tab chords", () => {
    const chords = [
      SESSION_SWITCHER_KEYBINDS.new,
      SESSION_SWITCHER_KEYBINDS.next,
      SESSION_SWITCHER_KEYBINDS.prev,
      SESSION_SWITCHER_KEYBINDS.close,
      ...Array.from({ length: 9 }, (_, i) => SESSION_SWITCHER_KEYBINDS.jump(i + 1)),
    ]

    expect(new Set(chords).size).toBe(chords.length)
    for (const chord of chords) expect(existingTabKeybinds.has(chord)).toBe(false)
  })

  test("provides spawn, cycle, and jump-to-index bindings", () => {
    expect(SESSION_SWITCHER_KEYBINDS.new).toBeTruthy()
    expect(SESSION_SWITCHER_KEYBINDS.next).not.toBe(SESSION_SWITCHER_KEYBINDS.prev)
    expect(SESSION_SWITCHER_KEYBINDS.jump(1)).toBe("mod+alt+1")
    expect(SESSION_SWITCHER_KEYBINDS.jump(9)).toBe("mod+alt+9")
  })
})
