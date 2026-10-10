import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";
import { expect, test } from "./test";

test("settings shell is two-pane and deep-links Models Memory Decision Model Voice Usage", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, `settings-shell-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-general");

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByLabel("Provider")).toBeVisible();
  await memory.getByLabel("Provider").selectOption("serenity");
  await expect(memory.getByLabel("MCP endpoint")).toBeVisible();
  await expect(memory.getByLabel("Bearer token")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Recall only" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory-serenity");

  await settings.getByTestId("settings-nav-decision-model").click();
  await expect(settings).toHaveAttribute("data-settings-section", "decision-model");
  await expect(
    settings.getByRole("heading", { name: "Decision Model", exact: true }),
  ).toBeVisible();
  const decisionModelSettings = settings.getByTestId("decision-model-settings");
  await expect(decisionModelSettings.getByLabel("OpenRouter API key")).toBeVisible();
  await expect(decisionModelSettings.getByRole("button", { name: "Connect" })).toBeDisabled();
  await decisionModelSettings.getByText("Advanced").click();
  await expect(decisionModelSettings.getByLabel("Base URL")).toBeVisible();
  await expect(decisionModelSettings.getByLabel("Model")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-decision-model");
  await decisionModelSettings.getByLabel("OpenRouter API key").fill("test-key-not-real");
  await decisionModelSettings.getByRole("button", { name: "Connect" }).click();
  await expect(decisionModelSettings.getByText("Connected", { exact: true })).toBeVisible();
  await expect(decisionModelSettings.getByLabel("OpenRouter API key")).toHaveCount(0);
  await decisionModelSettings.getByRole("button", { name: "Disconnect" }).click();
  await expect(decisionModelSettings.getByLabel("OpenRouter API key")).toBeVisible();
  await expect(decisionModelSettings.getByText("Connected", { exact: true })).toHaveCount(0);

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
  await expect(settings.getByTestId("voice-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-voice");

  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});
