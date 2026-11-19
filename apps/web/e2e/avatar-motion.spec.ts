// Needs the Vite dev server: the fixture is served from source and is not a build entry.

import type { Page } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const FIXTURE = "/e2e/fixtures/avatar-motion.html";
const CHARACTERS = 11;

const liveFaces = (page: Page, column: "still" | "live") =>
  page.locator(`[data-face="${column}"] .tangow-clay-face`);

test("a bot at rest is its still image, and one kept live is drawn over its body", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await expect(liveFaces(page, "live")).toHaveCount(CHARACTERS);
  await expect(liveFaces(page, "still")).toHaveCount(0);
  await expect(page.locator('[data-face="still"] img')).toHaveCount(CHARACTERS);
});

test("a live bot whose body fails to load keeps its still image", async ({ page }) => {
  let failed = 0;
  // In dev, Vite also serves each body's module under /bodies/: only fail the image itself.
  await page.route("**/bodies/**", (route) => {
    if (route.request().resourceType() !== "image") return route.continue();
    failed += 1;
    return route.abort();
  });
  await page.goto(FIXTURE);
  await expect.poll(() => failed).toBe(CHARACTERS);
  await expect(page.locator('[data-face="live"] img')).toHaveCount(CHARACTERS);
  await expect(liveFaces(page, "live")).toHaveCount(0);
});

for (const size of [80, 28]) {
  test(`captures the still and live faces side by side, ${size} px`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${FIXTURE}?size=${size}`);
    await expect(liveFaces(page, "live")).toHaveCount(CHARACTERS);
    await captureScreenshot(page, testInfo, `avatar-still-and-live-${size}`);
  });
}

test("bot avatar ring stays still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${FIXTURE}?status=running&live=none`);

  const avatar = page.locator(".tangow-bot-avatar").first();
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("data-working", "true");

  const ring = avatar.locator(".tangow-bot-avatar-ring");
  await expect(ring).toBeVisible();
  const snapshot = () =>
    ring.evaluate((el: SVGElement) => ({
      animationName: getComputedStyle(el).animationName,
      transform: getComputedStyle(el).transform,
    }));
  const first = await snapshot();
  await page.waitForTimeout(300);
  const second = await snapshot();

  expect(first.animationName).toBe("none");
  expect(second).toEqual(first);
});
