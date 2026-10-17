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

test("links the server resolved show as mentions with their site's icon, in place in the sentence", async ({
  page,
}, testInfo) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.route("**/rpc/artifacts/get", (route) =>
    route.request().postDataJSON()?.json?.artifactId === "art-broken"
      ? route.fulfill({ status: 500, json: {} })
      : route.fulfill({
          json: {
            json: { id: "art-1", name: "icon.webp", mimeType: "image/png", contentBase64: PIXEL },
          },
        }),
  );
  await page.goto("/e2e/fixtures/link-preview.html");

  const bot = page.locator('[data-message-id="mention-bot"]');
  const user = page.locator('[data-message-id="mention-user"]');
  const mentions = page.locator('[data-slot="link-mention"]');
  await expect(bot.locator('[data-slot="link-mention"]')).toHaveCount(4);
  await expect(user.locator('[data-slot="link-mention"]')).toHaveCount(2);

  // Named "label, host"; the label is the author's words, else the server's title, else the host.
  for (const name of [
    "Compte rendu du 12 octobre, docs.example.org",
    "Put the iPhone key's eye and copy icons inside the field, like the web, code.example.org",
    "tracker.example.net",
    "Handbook, wiki.example.org",
  ]) {
    await expect(bot.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(user.getByRole("link", { name: "Roadmap Q4, notion.example.com" })).toBeVisible();
  await expect(
    user.getByRole("link", { name: "Onboarding flow, design.example.net" }),
  ).toBeVisible();
  for (const mention of await mentions.all()) {
    await expect(mention).toHaveAttribute("title", /^https:\/\//);
    await expect(mention).toHaveAttribute("rel", "noreferrer noopener");
    await expect(mention.locator(".rk-link-mention-icon")).toHaveAttribute("aria-hidden", "true");
  }

  // The icon comes from the thread's artifact, read once the mention nears the viewport; no icon,
  // or one that cannot be read, is the glyph.
  const docs = bot.getByRole("link", { name: "Compte rendu du 12 octobre, docs.example.org" });
  await docs.scrollIntoViewIfNeeded();
  await expect(docs.locator("img")).toHaveAttribute("src", /^blob:/);
  for (const name of ["tracker.example.net", "Handbook, wiki.example.org"]) {
    const mention = bot.getByRole("link", { name, exact: true });
    await mention.scrollIntoViewIfNeeded();
    await expect(mention.locator('[data-slot="link-mention-glyph"]')).toBeVisible();
    await expect(mention.locator("img")).toHaveCount(0);
  }
  await expect(
    user
      .getByRole("link", { name: "Roadmap Q4, notion.example.com" })
      .locator('[data-slot="link-mention-glyph"]'),
  ).toBeVisible();

  // A link without a mention is the plain link it always was.
  const plain = bot.locator('a[href="https://forum.example.com/t/unrelated"]');
  await expect(plain).toHaveText("https://forum.example.com/t/unrelated");
  await expect(plain).not.toHaveAttribute("data-slot", "link-mention");

  // One line box tall, icon at 16 px and never split from its label; a long label ends in an
  // ellipsis inside the bubble.
  const long = bot.getByRole("link", { name: /^Put the iPhone key's eye/ });
  const lineHeight = await long.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element.parentElement!).lineHeight),
  );
  const box = (await long.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(lineHeight + 0.5);
  const icon = (await long.locator("img").boundingBox())!;
  expect(icon.width).toBe(16);
  expect(icon.height).toBe(16);
  expect(icon.y - box.y).toBeCloseTo((box.height - 16) / 2, 0);
  const label = long.locator(".rk-link-mention-label");
  await expect(label).toHaveCSS("text-overflow", "ellipsis");
  expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  expect(requested.filter((url) => /example\.(com|org|net)/.test(url))).toEqual([]);

  await bot.scrollIntoViewIfNeeded();
  for (const scheme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      scheme,
    );
    await captureScreenshot(page, testInfo, `link-mention-${scheme}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const message of [bot, user]) {
    const bubble = (await message
      .locator('[data-slot="message-row-bubble"], [data-slot="user-bubble"]')
      .first()
      .boundingBox())!;
    for (const mention of await message.locator('[data-slot="link-mention"]').all()) {
      const edge = (await mention.boundingBox())!;
      expect(edge.x + edge.width).toBeLessThanOrEqual(bubble.x + bubble.width);
    }
  }
  await captureScreenshot(page, testInfo, "link-mention-phone");
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
