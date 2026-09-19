import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  openUserSettings,
  signup,
} from "./helpers";

async function setupGroupComposer(page: Page) {
  const stamp = Date.now();
  await signup(page, `quiet-composer-${stamp}@rakazo.test`, "password12", "Quiet Composer");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const helperId = await createNamedBot(page, "Helper");
  expect(helperId).toBeTruthy();

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Quiet composer team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Helper" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: "Message Quiet composer team" });
  await expect(composer).toBeVisible();
  return composer;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  const settings = await openUserSettings(page);
  await settings.getByTestId(`ui-appearance-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

/** Adds a mention chip for Helper and returns it. */
async function addMentionChip(page: Page, composer: Locator) {
  await composer.fill("@Help");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: "@Helper" }).click();
  const chip = page.getByTestId("mention-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Helper");
  return chip;
}

async function removeMentionChip(page: Page) {
  await page.getByRole("button", { name: "Remove mention Helper" }).click();
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
}

test("composer capsule: empty, typing, and mention chip in light and dark", async ({
  page,
}, testInfo) => {
  const composer = await setupGroupComposer(page);
  const bar = page.getByTestId("composer-bar");

  // Empty — the round-icon buttons show, but Send only mounts once there's a draft.
  await expect(bar.getByRole("button", { name: "Attach file" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  const emptyBox = await composer.boundingBox();
  expect(emptyBox).toBeTruthy();
  await captureScreenshot(page, testInfo, "quiet-composer-empty-light");

  // Typing — Send appears, but the field doesn't reflow: an aria-hidden placeholder
  // holds Send's footprint while it's unmounted, so the row width stays constant.
  await composer.fill("Ping the team about the launch");
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  const typingBox = await composer.boundingBox();
  expect(typingBox).toBeTruthy();
  expect(Math.abs(typingBox!.width - emptyBox!.width)).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "quiet-composer-typing-light");
  await composer.fill("");
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);

  // Mention chip — a 30 px capsule carrying an 18 px bot avatar.
  const lightChip = await addMentionChip(page, composer);
  const lightChipBox = await lightChip.boundingBox();
  expect(lightChipBox).toBeTruthy();
  expect(lightChipBox!.height).toBeGreaterThanOrEqual(29);
  expect(lightChipBox!.height).toBeLessThanOrEqual(31);
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-mention-chip-light");
  await removeMentionChip(page);

  await setTheme(page, "dark");

  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-composer-empty-dark");

  await composer.fill("Ping the team about the launch");
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-typing-dark");
  await composer.fill("");

  const darkChip = await addMentionChip(page, composer);
  const darkChipBox = await darkChip.boundingBox();
  expect(darkChipBox).toBeTruthy();
  expect(darkChipBox!.height).toBeGreaterThanOrEqual(29);
  expect(darkChipBox!.height).toBeLessThanOrEqual(31);
  await captureScreenshot(page, testInfo, "quiet-composer-mention-chip-dark");
});
