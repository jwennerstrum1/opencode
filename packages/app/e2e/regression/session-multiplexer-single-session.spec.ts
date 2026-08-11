import { expect, test } from "@playwright/test"
import { fixture } from "./session-multiplexer.fixture"
import { gotoBaseSession, setupMultiplexerPage, spawnSession, switcher } from "./session-multiplexer.helpers"

// Regression guard: the multiplexer is additive. With fewer than two tracked
// sessions the app must look and behave exactly like the single-session flow —
// no switcher chrome, prompt input working as before.
test.describe("session multiplexer: single-session guard", () => {
  test("shows no switcher chrome for a lone session", async ({ page }) => {
    await setupMultiplexerPage(page)
    await gotoBaseSession(page)

    await expect(switcher(page)).toBeHidden()
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible()

    // Even a single spawned session stays below the switch-worthy threshold.
    await spawnSession(page, fixture.titles.alpha)
    await expect(switcher(page)).toBeHidden()
    await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible()
  })
})
