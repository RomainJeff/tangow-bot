import type { Page } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPage, signup } from "./helpers";
import { expect, test } from "./test";

/** At phone width the bot list is its own page, as in the iPhone app: open a chat, go back. */
test("the phone bot list is a page that a chat opens from and returns to", async ({
  page,
}, testInfo) => {
  await signup(page, `mobile-nav-${Date.now()}@tangow.test`, "password12", "Phone Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForURL(/\/app\/[^/]+$/);
  const chat = page.url();

  const list = page.getByTestId("bots-sidebar");
  const main = page.locator("main");
  await expect(list).toBeHidden();
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL(/\/app$/);

  // The list takes the whole screen, on the page background Safari paints its bars in.
  await expect(list).toBeVisible();
  await expect(main).toHaveJSProperty("inert", true);
  expect(await page.getByTestId("bots-sidebar-pane").boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  });
  await captureScreenshot(page, testInfo, "mobile-bot-list");

  await list.getByRole("button", { name: /Chief/ }).first().click();
  await page.waitForURL(chat);
  await expect(list).toBeHidden();
  await expect(main).toHaveJSProperty("inert", false);

  // From a chat opened on the list, Back pops to it: the chat is still ahead in history.
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL(/\/app$/);
  await expect(list).toBeVisible();
  await page.goForward();
  await page.waitForURL(chat);
  await expect(list).toBeHidden();

  // The browser's back gesture returns to the list too.
  await page.goBack();
  await page.waitForURL(/\/app$/);
  await expect(list).toBeVisible();

  // A cold load of the bare route stays on the list, past the roster's refresh poll.
  await page.goto("/app");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(3_500);
  expect(new URL(page.url()).pathname).toBe("/app");
  await expect(list).toBeVisible();
});

async function startOnBotList(page: Page, email: string) {
  await signup(page, email, "password12", "Phone Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL(/\/app$/);
}

async function openUserMenuEntry(page: Page, name: "Settings" | "Usage") {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name, exact: true }).click();
}

test("phone Settings is a list of sections: a row pushes one, Back and close leave", async ({
  page,
}, testInfo) => {
  await startOnBotList(page, `mobile-settings-${Date.now()}@tangow.test`);

  await openUserMenuEntry(page, "Settings");
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-nav")).toHaveCount(0);
  for (const id of ["profile", "providers", "updates", "space", "models", "usage"]) {
    const row = await settings.getByTestId(`settings-list-${id}`).boundingBox();
    expect(row?.height, `${id} row`).toBeGreaterThanOrEqual(44);
  }
  const close = await settings.getByRole("button", { name: "Close user settings" }).boundingBox();
  expect(close && close.x + close.width).toBeGreaterThan(340);
  expect(close?.y).toBeLessThan(60);
  await captureScreenshot(page, testInfo, "mobile-settings-list");

  await settings.getByTestId("settings-list-models").click();
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-list-profile")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Close model settings" })).toBeVisible();
  await captureScreenshot(page, testInfo, "mobile-settings-models");

  await settings.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings.getByTestId("settings-list-models")).toBeVisible();
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toHaveCount(0);

  await openUserMenuEntry(page, "Usage");
  await expect(settings.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings.getByTestId("settings-list-usage")).toBeVisible();
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toHaveCount(0);
});

test("phone Customize is a list of its sections, pushed and popped like Settings", async ({
  page,
}, testInfo) => {
  await startOnBotList(page, `mobile-customize-${Date.now()}@tangow.test`);

  await page.getByTestId("open-customize").click();
  const overlay = page.getByRole("dialog");
  await expect(overlay.getByRole("heading", { name: "Customize", exact: true })).toBeVisible();
  await expect(overlay.getByTestId("customize-nav-skills")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "mobile-customize-list");

  await overlay.getByTestId("customize-list-skills").click();
  await expect(overlay.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  await overlay.getByTestId("customize-list-integrations").click();
  await expect(overlay.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "Close integrations" }).click();
  await expect(overlay).toHaveCount(0);
});

test("the phone bot panel returns to the chat from its own back button", async ({
  page,
}, testInfo) => {
  await signup(page, `mobile-panel-${Date.now()}@tangow.test`, "password12", "Phone Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForURL(/\/app\/[^/]+$/);
  const panel = page.getByTestId("side-panel");

  const botPage = await openBotPage(page);
  await expect(botPage.getByRole("button", { name: "Close panel" })).toBeHidden();
  await captureScreenshot(page, testInfo, "mobile-bot-panel");
  await botPage.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "closed");

  await openBotPage(page);
  await botPage.getByRole("tab", { name: "Settings", exact: true }).click();
  await botPage.locator('[data-opens="model"]').click();
  await expect(botPage.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(botPage.getByRole("button", { name: "Close panel" })).toBeHidden();
  await captureScreenshot(page, testInfo, "mobile-bot-panel-detail");
  await botPage.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(botPage.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
});

test("at desktop width Settings keeps its nav and the panel its close button", async ({
  page,
}, testInfo) => {
  await signup(page, `desktop-settings-${Date.now()}@tangow.test`, "password12", "Desktop Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  await openUserMenuEntry(page, "Settings");
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-list-profile")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Close user settings" })).toBeVisible();
  await captureScreenshot(page, testInfo, "desktop-settings");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  const botPage = await openBotPage(page);
  await expect(botPage.getByRole("button", { name: "Close panel" })).toBeVisible();
  await expect(botPage.getByRole("button", { name: "Chat", exact: true })).toBeHidden();
});
