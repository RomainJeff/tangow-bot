// Needs the Vite dev server: the fixture is served from source and is not a build entry.

import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

// A 1x1 PNG: the artifact stands in for the stored WebP picture.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("link previews render in three formats, only for articles and photos, and never contact the linked site", async ({
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
  await expect(cards).toHaveCount(6);
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

  // A link to a page that is not an article has no card: it stays a plain link in the bubble.
  const plain = page.locator('[data-message-id="plain"]');
  await expect(plain.locator('[data-slot="link-preview-card"]')).toHaveCount(0);
  await expect(plain.locator('[data-testid="message-bot-bubble"]')).toContainText(
    "https://docs.example.net/roadmap",
  );

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

  // A site icon is drawn whole and centered inside the 56 px thumbnail, never cropped; a page
  // picture still fills and crops.
  const icon = page.locator('[data-message-id="icon"] [data-slot="link-preview-picture"]');
  await expect(icon).toHaveAttribute("data-fit", "contain");
  await expect(icon.locator("img")).toHaveCSS("object-fit", "contain");
  const thumb = await icon
    .locator("xpath=ancestor::div[contains(@class,'size-link-thumb')]")
    .boundingBox();
  const glyph = await icon.locator("img").boundingBox();
  expect(thumb!.width).toBe(56);
  expect(glyph!.width).toBeGreaterThan(0);
  expect(glyph!.width).toBeLessThan(thumb!.width);
  expect(glyph!.x - thumb!.x).toBeCloseTo(thumb!.x + thumb!.width - (glyph!.x + glyph!.width), 0);
  const cover = page.locator('[data-message-id="compact"] [data-slot="link-preview-picture"]');
  await expect(cover).toHaveAttribute("data-fit", "cover");
  await expect(cover.locator("img")).toHaveCSS("object-fit", "cover");

  // A compact card without a picture shows the site's initial in the same 56 px tile (the tile is
  // decorative, the card keeps its name), and the bubble does not repeat the link's own line.
  const letter = page.locator('[data-message-id="letter"]');
  const tile = letter.locator('[data-slot="link-preview-initial"]');
  await expect(tile).toHaveText("L");
  await expect(tile).toHaveAttribute("aria-hidden", "true");
  expect((await tile.locator("xpath=..").boundingBox())!.width).toBe(56);
  await expect(letter.locator('[data-slot="link-preview-card"]')).toHaveAttribute(
    "aria-label",
    /^J'ai eu peur .* lycees, lefigaro\.fr$/,
  );
  await expect(letter.locator('[data-testid="message-bot-bubble"]')).toHaveText(
    "Voici l'article du Figaro :",
  );
  // A link in the middle of a sentence stays.
  await expect(
    page.locator('[data-message-id="compact"] [data-testid="message-user-bubble"]'),
  ).toContainText("https://news.example.org/briefing");

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

test("the composer's draft card shrinks to a phone-width capsule", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/e2e/fixtures/link-preview.html");

  const composer = await page.getByTestId("composer-bar").boundingBox();
  const draft = await page.locator('[data-slot="composer-link-preview"]').boundingBox();
  expect(composer!.width).toBeLessThan(360);
  expect(draft!.x).toBeGreaterThanOrEqual(composer!.x);
  expect(draft!.x + draft!.width).toBeLessThanOrEqual(composer!.x + composer!.width);
  await page.locator('[data-slot="composer-link-preview"]').scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "link-preview-composer-phone");
});
