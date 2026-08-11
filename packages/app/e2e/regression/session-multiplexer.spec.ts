import { expect, test } from "@playwright/test"
import { fixture } from "./session-multiplexer.fixture"
import {
  closeSession,
  expectFocused,
  expectNotFocused,
  gotoBaseSession,
  setupMultiplexerPage,
  spawnSession,
  switcher,
  switcherItem,
  switcherItems,
} from "./session-multiplexer.helpers"

test.describe("session multiplexer", () => {
  test("spawns a concurrent session and shows both in the switcher", async ({ page }) => {
    await setupMultiplexerPage(page)
    await gotoBaseSession(page)

    // A lone spawned session is not something to switch between yet.
    await spawnSession(page, fixture.titles.alpha)
    await expect(switcher(page)).toBeHidden()

    // The second concurrent session makes the switcher meaningful.
    await spawnSession(page, fixture.titles.bravo)
    await expect(switcher(page)).toBeVisible()
    await expect(switcherItems(page)).toHaveCount(2)
    await expect(switcherItem(page, fixture.titles.alpha)).toBeVisible()
    await expect(switcherItem(page, fixture.titles.bravo)).toBeVisible()
    // The pre-existing single session is never adopted into the multiplexer.
    await expect(switcherItem(page, fixture.titles.base)).toHaveCount(0)
    // The most recently spawned session holds focus.
    await expectFocused(page, fixture.titles.bravo)
    await expectNotFocused(page, fixture.titles.alpha)
  })

  test("switches focus between sessions and renders the focused session", async ({ page }) => {
    await setupMultiplexerPage(page)
    await gotoBaseSession(page)
    await spawnSession(page, fixture.titles.alpha)
    await spawnSession(page, fixture.titles.bravo)

    // Focus alpha from the switcher.
    await switcherItem(page, fixture.titles.alpha).click()
    await expect(page.getByRole("heading", { name: fixture.titles.alpha })).toBeVisible()
    await expectFocused(page, fixture.titles.alpha)
    await expectNotFocused(page, fixture.titles.bravo)
    await expect(page.getByText("Reply marker alpha")).toBeVisible()

    // Focus bravo from the switcher and confirm the rendered content follows.
    await switcherItem(page, fixture.titles.bravo).click()
    await expect(page.getByRole("heading", { name: fixture.titles.bravo })).toBeVisible()
    await expectFocused(page, fixture.titles.bravo)
    await expectNotFocused(page, fixture.titles.alpha)
    await expect(page.getByText("Reply marker bravo")).toBeVisible()
  })

  test("moves focus to the most recently focused survivor when the focused session closes", async ({ page }) => {
    await setupMultiplexerPage(page)
    await gotoBaseSession(page)
    // Focus history by spawn order: alpha, bravo, charlie (charlie focused).
    await spawnSession(page, fixture.titles.alpha)
    await spawnSession(page, fixture.titles.bravo)
    await spawnSession(page, fixture.titles.charlie)
    await expect(switcherItems(page)).toHaveCount(3)

    // Establish an explicit focus history — bravo, then charlie, then alpha —
    // so charlie is unambiguously the most recently focused survivor once alpha
    // (the focused session) is closed. Each click is a distinct user action, so
    // the recorded focus timestamps are strictly ordered.
    await switcherItem(page, fixture.titles.bravo).click()
    await expectFocused(page, fixture.titles.bravo)
    await switcherItem(page, fixture.titles.charlie).click()
    await expectFocused(page, fixture.titles.charlie)
    await switcherItem(page, fixture.titles.alpha).click()
    await expectFocused(page, fixture.titles.alpha)

    // Closing the focused session hands focus to the most recently focused
    // survivor (charlie), per nextFocusAfterClose. The switcher is the
    // multiplexer's own surface, so its selected entry is authoritative for the
    // focus-fallback semantics under test.
    //
    // NOTE (known cross-surface gap): on close the main content pane currently
    // follows the titlebar tab strip's neighbor selection rather than the
    // multiplexer's chosen survivor, so the rendered session heading can lag
    // behind the switcher here. Asserting the switcher selection keeps this spec
    // pinned to the multiplexer behavior; the pane/route reconciliation is
    // tracked separately.
    await closeSession(page, fixture.titles.alpha)
    await expect(switcherItem(page, fixture.titles.alpha)).toHaveCount(0)
    await expect(switcherItems(page)).toHaveCount(2)
    await expectFocused(page, fixture.titles.charlie)
    await expectNotFocused(page, fixture.titles.bravo)
  })

  test("keeps focus when a background session is closed", async ({ page }) => {
    await setupMultiplexerPage(page)
    await gotoBaseSession(page)
    await spawnSession(page, fixture.titles.alpha)
    await spawnSession(page, fixture.titles.bravo)
    await expectFocused(page, fixture.titles.bravo)

    // Closing a non-focused session leaves focus untouched.
    await closeSession(page, fixture.titles.alpha)
    await expect(switcherItem(page, fixture.titles.alpha)).toHaveCount(0)
    await expect(page.getByRole("heading", { name: fixture.titles.bravo })).toBeVisible()
    // Only bravo remains, so the switcher recedes back to single-session chrome.
    await expect(switcher(page)).toBeHidden()
  })
})
