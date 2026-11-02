// Needs the Vite dev server: the fixture is served from source and is not a build entry.

import type { Page } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const HUES = [210, 340, 150, 40, 270, 190, 20, 100];

/** A tall page-like picture per artifact: a bar on top, so the crop from the top is visible. */
function picture(artifactId: string): string {
  const hue =
    HUES[[...artifactId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % HUES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600"><rect width="1200" height="1600" fill="hsl(${hue} 30% 94%)"/><rect width="1200" height="220" fill="hsl(${hue} 55% 42%)"/><rect x="80" y="320" width="720" height="40" rx="20" fill="hsl(${hue} 20% 70%)"/><rect x="80" y="420" width="1040" height="40" rx="20" fill="hsl(${hue} 20% 80%)"/><rect x="80" y="520" width="900" height="40" rx="20" fill="hsl(${hue} 20% 80%)"/></svg>`;
  return Buffer.from(svg).toString("base64");
}

/** Opens the fixture and returns the artifacts it reads, in order. */
async function open(page: Page) {
  const reads: string[] = [];
  await page.route("**/rpc/artifacts/get", (route) => {
    const artifactId: string = route.request().postDataJSON()?.json?.artifactId ?? "";
    reads.push(artifactId);
    return route.fulfill({
      json: {
        json: {
          id: artifactId,
          name: `${artifactId}.svg`,
          mimeType: "image/svg+xml",
          contentBase64: picture(artifactId),
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/image-stack.html");
  return reads;
}

/** What a stack's arrival animates: the cards' own web animations, not the CSS transitions that move them. */
const arrivalKeys = (element: Element) =>
  element
    .getAnimations({ subtree: true })
    .filter((animation) => Object.getPrototypeOf(animation) === Animation.prototype)
    .flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes())
    .flatMap((keyframe) => Object.keys(keyframe));

const theme = (page: Page, value: "light" | "dark") =>
  page.evaluate((scheme) => document.documentElement.setAttribute("data-theme", scheme), value);

test("consecutive images gather in one stack that opens in a viewer you step through", async ({
  page,
}, testInfo) => {
  const reads = await open(page);

  const stacks = page.locator('[data-slot="image-stack"]');
  await expect(stacks).toHaveCount(2);
  const people = stacks.first();
  const bot = stacks.last();
  await expect(people).toHaveAccessibleName("Image 1 of 5, from You");
  await expect(people).toContainText("5");
  await expect(bot).toHaveAccessibleName("Image 1 of 3, from Pixel");
  await expect(bot).not.toContainText(/\d/);
  await expect(bot.locator("img").first()).toHaveAttribute("src", /^blob:/);

  // A thread opened with its images already in place plays no arrival.
  expect(await bot.evaluate(arrivalKeys)).toEqual([]);
  // Each stack reads its front before the cards peeking behind it.
  expect(reads.slice(0, 2).sort()).toEqual(["art_c", "art_p5"]);

  const front = bot.locator('[data-depth="0"]');
  const frame = await front.boundingBox();
  expect(frame!.width / frame!.height).toBeCloseTo(4 / 3, 1);
  const before = await bot.boundingBox();

  for (const scheme of ["light", "dark"] as const) {
    await theme(page, scheme);
    await captureScreenshot(page, testInfo, `image-stack-${scheme}`);
  }

  // A fourth image lands on top: the stack keeps its size, shows the count, and the card springs in.
  await page.evaluate(() => window.dispatchEvent(new Event("add-image")));
  await expect(bot).toHaveAccessibleName("Image 1 of 4, from Pixel");
  await expect(bot).toContainText("4");
  expect(await bot.boundingBox()).toEqual(before);
  const landing = await bot.locator('[data-depth="0"]').evaluate(arrivalKeys);
  expect(landing).toContain("translate");

  // With reduced motion it fades in without moving.
  await bot.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.dispatchEvent(new Event("add-image")));
  await expect(bot).toHaveAccessibleName("Image 1 of 5, from Pixel");
  const faded = await bot.locator('[data-depth="0"]').evaluate(arrivalKeys);
  expect(faded).toContain("opacity");
  expect(faded).not.toContain("translate");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // A click opens the viewer on the front, the newest image, as image 1.
  const srcAt = (depth: number) => bot.locator(`[data-depth="${depth}"] img`).getAttribute("src");
  await bot.click();
  await expect(page.getByRole("dialog", { name: "Image 1 of 5, from Pixel" })).toBeVisible();
  const viewer = page.getByRole("dialog");
  await expect(viewer).toContainText("Pixel");
  const shown = viewer.getByRole("img", { name: /^Image \d of 5, from Pixel$/ });
  await expect(shown).toHaveAttribute("src", (await srcAt(0))!);
  const previous = viewer.getByRole("button", { name: "Previous image" });
  const next = viewer.getByRole("button", { name: "Next image" });
  await expect(previous).toBeDisabled();
  // A strip of thumbnails, one per image in the same order, marks the one shown.
  const thumbs = viewer.getByRole("button", { name: /^Image \d of 5, from Pixel$/ });
  await expect(thumbs).toHaveCount(5);
  await expect(thumbs.locator("img")).toHaveCount(5);
  await expect(thumbs.first()).toHaveAttribute("aria-current", "true");
  await expect(thumbs.nth(0).locator("img")).toHaveAttribute("src", (await srcAt(0))!);
  await expect(thumbs.nth(1).locator("img")).toHaveAttribute("src", (await srcAt(1))!);

  // Next and the right arrow go down the stack to the older image; the left arrow comes back up.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "Image 2 of 5, from Pixel" })).toBeVisible();
  await expect(shown).toHaveAttribute("src", (await srcAt(1))!);
  await next.click();
  await expect(page.getByRole("dialog", { name: "Image 3 of 5, from Pixel" })).toBeVisible();
  await expect(shown).toHaveAttribute("src", (await srcAt(2))!);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("dialog", { name: "Image 2 of 5, from Pixel" })).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await theme(page, scheme);
    await captureScreenshot(page, testInfo, `image-viewer-${scheme}`);
  }

  // Clicking down to the oldest image leaves Next disabled under focus; the arrow keys still work.
  for (const n of [3, 4, 5]) {
    await next.click();
    await expect(page.getByRole("dialog", { name: `Image ${n} of 5, from Pixel` })).toBeVisible();
  }
  await expect(next).toBeDisabled();
  await expect(thumbs.last()).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("dialog", { name: "Image 4 of 5, from Pixel" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("dialog", { name: "Image 3 of 5, from Pixel" })).toBeVisible();

  // A thumbnail jumps straight to its image.
  await thumbs.first().click();
  await expect(page.getByRole("dialog", { name: "Image 1 of 5, from Pixel" })).toBeVisible();
  await expect(thumbs.first()).toHaveAttribute("aria-current", "true");
  await expect(thumbs.nth(2)).not.toHaveAttribute("aria-current");
  await expect(previous).toBeDisabled();

  // The stack, the viewer and the strip share what they read: no image is read twice.
  expect(reads).toHaveLength(new Set(reads).size);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(bot).toBeFocused();
});

test("a stack keeps its frame at phone width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const bot = page.locator('[data-slot="image-stack"]').last();
  await expect(bot.locator("img").first()).toHaveAttribute("src", /^blob:/);
  const box = await bot.boundingBox();
  expect(box!.width).toBeLessThan(390 * 0.85);
  for (const scheme of ["light", "dark"] as const) {
    await theme(page, scheme);
    await captureScreenshot(page, testInfo, `image-stack-phone-${scheme}`);
  }
  await bot.click();
  await expect(page.getByRole("dialog", { name: "Image 1 of 3, from Pixel" })).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: /^Image \d of 3/ })
      .locator("img"),
  ).toHaveCount(3);
  await captureScreenshot(page, testInfo, "image-viewer-phone-dark");
  await theme(page, "light");
  await captureScreenshot(page, testInfo, "image-viewer-phone-light");
});
