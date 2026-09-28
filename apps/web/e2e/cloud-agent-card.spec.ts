import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// Harness pins CLOUD_AGENT_PROVIDER=emulator (see packages/testkit); do not point at a live Cursor key.
// cloud_agent_launch is consequential but runs without a confirmation by default (optional in settings).
test("renders a compact cloud agent card from an emulator launch", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `cloud-agent-${stamp}@rakazo.test`, "password12", "Cloud Agent");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("launch a cloud agent to add a README");
  await page.keyboard.press("Enter");

  const card = page.getByTestId("cloud-agent-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(/running|Add a README|launching|Cloud agent/i);
  // Once finished, the card shows no status word at all (spec A8b) — "Pull
  // request" appearing (replacing "running"/no meta yet) is the finished signal.
  await expect(card).toContainText("Pull request", { timeout: 60_000 });
  await expect(card).not.toContainText(/running|failed|cancelled/i);
  await expect(card.locator("..")).toHaveAttribute(
    "href",
    "https://github.com/example/demo/pull/1",
  );
  await captureScreenshot(page, testInfo, "cloud-agent-card");

  // Same quiet surface (fill, hairline, no shadow) in dark mode.
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await captureScreenshot(page, testInfo, "cloud-agent-card-dark");

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; status?: string; title?: string }> }>;
        }>(page, "threads/messages", { botId });
        return history.messages
          .flatMap((message) => message.blocks)
          .some((block) => block.kind === "cloud_agent");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});
