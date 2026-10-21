import type { Page } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";
import { expect, test } from "./test";

async function prepareOnboarding(page: Page) {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: false } } });
  });
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          providers: [],
          webUrl: "https://example.test/integrations/setup",
        },
      },
    }),
  );
}

/** At phone width the bot list is its own page, as in the iPhone app: open a chat, go back. */
test("the phone bot list is a page that a chat opens from and returns to", async ({
  page,
}, testInfo) => {
  await prepareOnboarding(page);
  await signup(page, `mobile-nav-${Date.now()}@rakazo.test`, "password12", "Phone Nav");
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
