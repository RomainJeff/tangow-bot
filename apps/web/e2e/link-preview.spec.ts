// Needs the Vite dev server: the fixture is served from source and is not a build entry.
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

// A 1x1 PNG: the artifact stands in for the stored WebP picture.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("link previews render in three formats and never contact the linked site", async ({
  page,
}, testInfo) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.route("**/rpc/artifacts/get", (route) =>
    route.fulfill({
      json: {
        json: { id: "art-1", name: "preview.webp", mimeType: "image/png", contentBase64: PIXEL },
      },
    }),
  );
  await page.goto("/e2e/fixtures/link-preview.html");

  const cards = page.locator('[data-slot="link-preview-card"]');
  await expect(cards).toHaveCount(4);
  await expect(page.locator('[data-format="large"]')).toHaveAttribute(
    "aria-label",
    "The city that removed its traffic lights, example.com",
  );
  await expect(page.locator('[data-format="photo"]')).toHaveAttribute(
    "aria-label",
    "images.example.com",
  );
  for (const card of await cards.all()) {
    await expect(card).toHaveAttribute("rel", "noreferrer noopener");
    await expect(card).toHaveAttribute("href", /^https:\/\//);
  }

  // The picture comes from the thread's artifact, as a local blob.
  await expect(page.locator('[data-format="large"] img')).toHaveAttribute("src", /^blob:/);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="link-preview-card"] *')].some(
        (element) =>
          /^https?:/i.test(element.getAttribute("src") ?? "") ||
          /url\(["']?https?:/i.test(getComputedStyle(element).backgroundImage),
      ),
    ),
  ).toBe(false);
  expect(requested.filter((url) => /example\.(com|org|net)/.test(url))).toEqual([]);

  // A link-only message has no bubble: the card carries the message's actions.
  const linkOnly = page.locator('[data-message-id="link-only"]');
  await expect(linkOnly.locator('[data-slot="message-row-bubble"]')).toHaveCount(0);
  await linkOnly.locator('[data-slot="link-preview-card"]').hover();
  await expect(linkOnly.locator('[data-slot="hover-pill"]')).toHaveCSS("opacity", "1");
  await expect(linkOnly.getByRole("button", { name: "Remove preview" })).toBeVisible();

  for (const scheme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      scheme,
    );
    await captureScreenshot(page, testInfo, `link-preview-${scheme}`);
  }

  // On a phone the card keeps its bubble's width cap, so its side still says who sent it.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const card of await cards.all()) {
    const box = await card.boundingBox();
    expect(box!.width).toBeLessThan(390 * 0.85);
  }
  await captureScreenshot(page, testInfo, "link-preview-phone");
});
