import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/** Documents the two-pane shell: sidebar, thread header, empty thread, light and dark. */
test("the shell is a sidebar and a centred thread", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `quiet-shell-${stamp}@rakazo.test`, "password12", "Quiet Shell");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "280px");
  await expect(sidebar).toHaveCSS("border-right-width", "0px");

  const header = page.getByTestId("bot-settings-trigger");
  await expect(header).toBeVisible();
  const headerRow = page.locator("main > div").first();
  await expect(headerRow).toHaveCSS("height", "56px");
  await expect(headerRow).toHaveCSS("border-bottom-width", "0px");

  // The thread is one centred column, with equal air on both sides.
  const main = page.locator("main");
  const column = main.locator("> div").nth(1);
  await expect(column).toHaveCSS("max-width", "800px");
  const [mainBox, columnBox] = await Promise.all([main.boundingBox(), column.boundingBox()]);
  expect(mainBox).not.toBeNull();
  expect(columnBox).not.toBeNull();
  const leading = (columnBox?.x ?? 0) - (mainBox?.x ?? 0);
  const trailing =
    (mainBox?.x ?? 0) + (mainBox?.width ?? 0) - ((columnBox?.x ?? 0) + (columnBox?.width ?? 0));
  expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(2);

  // One header button opens the computer and routines over the thread; Escape closes it.
  const openPanel = page.getByRole("button", { name: "Computer & routines" });
  await expect(openPanel).toHaveAttribute("data-testid", "open-computer-panel");
  const panel = page.getByTestId("side-panel");
  await openPanel.click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await expect(panel).toHaveCSS("width", "384px");
  await expect(openPanel).toHaveAttribute("aria-pressed", "true");
  // The thread re-flows beside the panel, so the header button stays reachable.
  await expect(openPanel).toBeVisible();
  await openPanel.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await openPanel.click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await expect(openPanel).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await captureScreenshot(page, testInfo, "quiet-shell-light");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await captureScreenshot(page, testInfo, "quiet-shell-dark");
});

/** Below `lg` the panel is full width over the thread, so the covered column must
 * stop being tabbable; above `lg` it reflows beside the panel and stays live. */
test("an open panel makes the conversation column inert below lg, not above", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `quiet-panel-inert-${stamp}@rakazo.test`, "password12", "Quiet Panel Inert");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const column = page.getByTestId("conversation-column");
  const panel = page.getByTestId("side-panel");

  await page.setViewportSize({ width: 900, height: 800 });
  await page.getByTestId("open-computer-panel").click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await expect(column).toHaveAttribute("aria-hidden", "true");
  await expect(column).toHaveJSProperty("inert", true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(column).not.toHaveAttribute("aria-hidden", "true");
  await expect(column).toHaveJSProperty("inert", false);
});

/** The header carries two icon toggles (computer + settings) instead of a text
 * label, and the bot settings actions ride a pinned footer so Save never hides
 * below a long form. */
test("header icons toggle computer and settings; settings actions stay pinned", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `panel-header-${stamp}@rakazo.test`, "password12", "Panel Header");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const panel = page.getByTestId("side-panel");
  const computer = page.getByTestId("open-computer-panel");
  const settings = page.getByTestId("open-settings-panel");

  // No verbose label: both controls are icon-only, named for screen readers.
  await expect(computer).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(computer).toHaveAccessibleName("Computer & routines");
  await expect(settings).toHaveAccessibleName("Bot settings");

  // The gear opens settings and reads as pressed; the computer icon does not.
  await settings.click();
  await expect(panel).toHaveAttribute("data-panel", "settings");
  await expect(settings).toHaveAttribute("aria-pressed", "true");
  await expect(computer).toHaveAttribute("aria-pressed", "false");

  // Save is reachable straight away: it rides a footer pinned to the bottom of
  // the panel, not the end of the scrolling form.
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeInViewport();
  await captureScreenshot(page, testInfo, "bot-panel-settings-light");

  // The two icons switch panels between themselves; no in-panel gear is needed.
  await computer.click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await expect(computer).toHaveAttribute("aria-pressed", "true");
  await expect(settings).toHaveAttribute("aria-pressed", "false");
  await settings.click();
  await expect(panel).toHaveAttribute("data-panel", "settings");
  await settings.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");

  // Mobile-first: at phone width the pinned footer keeps Save on screen.
  await page.setViewportSize({ width: 375, height: 720 });
  await settings.click();
  await expect(panel).toHaveAttribute("data-panel", "settings");
  await expect(save).toBeInViewport();
  await captureScreenshot(page, testInfo, "bot-panel-settings-mobile");
});
