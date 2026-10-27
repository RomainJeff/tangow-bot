import { captureScreenshot, completeOnboarding, openBotPage, signup } from "./helpers";
import { expect, type Page, test } from "./test";

const phone = { width: 390, height: 844 };

async function turnOnDebugMode(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("debug-mode").click();
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

test("a helper stays out of the thread, and debug mode opens its session", async ({
  page,
}, testInfo) => {
  const desktop = page.viewportSize()!;
  await signup(page, `helper-session-${Date.now()}@rakazo.test`, "password12", "Helper Session");
  await completeOnboarding(page);

  await page.getByPlaceholder(/Message/).fill("delegate to a helper to summarize the notes");
  await page.keyboard.press("Enter");

  const transcript = page.getByTestId("transcript");
  const result = "it found: delegate to a helper to summarize the notes";
  await expect(transcript.getByText(`the helper is done. ${result}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(transcript.getByText(result)).toHaveCount(1);
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "helper-reply");
  await page.setViewportSize(phone);
  await captureScreenshot(page, testInfo, "helper-reply-phone");
  await page.setViewportSize(desktop);

  await turnOnDebugMode(page);
  const botPage = await openBotPage(page);
  await botPage.getByRole("tab", { name: "Activity" }).click();
  await botPage.getByTestId("activity-run").first().click();

  const session = page.getByTestId("session-view");
  await session.getByTestId("agent-steps-toggle").first().click();
  await captureScreenshot(page, testInfo, "helper-run-debug");
  await session.getByRole("button", { name: "run_subagent", exact: true }).click();
  await expect(session.getByRole("heading")).toHaveText("run_subagent");
  await expect(session.getByTestId("run-details")).toContainText("scripted/scripted");
  await expect(session.getByTestId("run-details")).toContainText("subagent");
  await expect(session.getByText(result)).toBeVisible();
  await captureScreenshot(page, testInfo, "helper-session-debug");
  await page.setViewportSize(phone);
  await expect(session.getByText(result)).toBeVisible();
  await captureScreenshot(page, testInfo, "helper-session-debug-phone");
});
