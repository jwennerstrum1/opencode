import { expect, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"
import { fixture, pageMessages } from "./session-multiplexer.fixture"

// The switcher "new" command binds mod+shift+m; the app resolves "mod" to Meta
// on Apple platforms and Control elsewhere, keyed off navigator.platform — so we
// resolve the modifier from the running browser rather than the host OS.
async function modKey(page: Page) {
  const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  return isMac ? "Meta" : "Control"
}

export async function setupMultiplexerPage(
  page: Page,
  options: { createdSessions?: MockCreatedSessions; onCreateSession?: (id: string) => void } = {},
) {
  const created: string[] = []
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    // Fresh array per test: the mock appends spawned sessions to it.
    sessions: [{ ...fixture.baseSession }],
    createdSessions: options.createdSessions ?? fixture.spawned.map((session) => ({ id: session.id, title: session.title })),
    pageMessages: (sessionID) => pageMessages(sessionID),
    onCreateSession: (input) => {
      created.push(input.id)
      options.onCreateSession?.(input.id)
    },
  })
  await page.addInitScript((directory) => {
    // Suppress the one-time "tabs" onboarding toast: it would otherwise sit over
    // the titlebar and swallow command keybinds during the run.
    localStorage.setItem("settings.v3", JSON.stringify({ general: { shouldDisplayTabsToast: false } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)
  return { created }
}

type MockCreatedSessions = ReadonlyArray<{ id: string; title?: string; agent?: string; directory?: string }>

export async function gotoBaseSession(page: Page) {
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.baseID}`)
  await expectSessionTitle(page, fixture.titles.base)
}

// Spawn a session through the switcher's keybound command and wait until the app
// has focused and rendered it (the heading is the authoritative focused-session
// signal).
export async function spawnSession(page: Page, expectedTitle: string) {
  await page.keyboard.press(`${await modKey(page)}+Shift+m`)
  await expectSessionTitle(page, expectedTitle)
}

export function switcher(page: Page): Locator {
  return page.locator('[data-slot="session-switcher"]')
}

export function switcherItems(page: Page): Locator {
  return page.locator('[data-slot="session-switcher-item"]')
}

export function switcherItem(page: Page, title: string): Locator {
  return switcherItems(page).filter({ hasText: title })
}

export async function expectFocused(page: Page, title: string) {
  await expect(switcherItem(page, title)).toHaveAttribute("data-focused", "true")
  await expect(switcherItem(page, title)).toHaveAttribute("aria-selected", "true")
}

export async function expectNotFocused(page: Page, title: string) {
  await expect(switcherItem(page, title)).toHaveAttribute("data-focused", "false")
  await expect(switcherItem(page, title)).toHaveAttribute("aria-selected", "false")
}

export async function closeSession(page: Page, title: string) {
  await switcherItem(page, title).hover()
  await page.getByRole("button", { name: `Close ${title}` }).click()
}
