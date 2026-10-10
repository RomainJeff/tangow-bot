// Needs the Vite dev server: the fixture is served from source and is not a build entry.
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("a skill line sits under the bot's message, opens the skill, and cannot be faked", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/skill-line.html");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  const learned = page.locator('[data-message-id="learned"]');
  const line = learned.getByRole("link", { name: "Skill learned · Book a room" });
  await expect(line).toBeVisible();
  await expect(line.locator("svg")).toHaveCount(2);
  await expect(learned.locator('[data-slot="message-row-bubble"]').getByRole("link")).toHaveCount(
    1,
  );

  // Under the text, at the bubble's left, and still at rest: this is history, not news.
  const bubbleBox = (await learned.locator('[data-slot="message-row-bubble"]').boundingBox())!;
  const lineBox = (await line.boundingBox())!;
  expect(lineBox.x).toBeCloseTo(bubbleBox.x + 14, 0);
  await expect(line).toHaveCSS("animation-name", "none");

  // Several skills, one line each, in the order the run changed them.
  const report = page.locator('[data-message-id="report"]');
  await expect(report.locator('[data-slot="message-row-meta"]')).toHaveText([
    "Skill updated · Relever les factures",
    "Skill deleted · Old checklist",
  ]);

  // Renamed since the line was written: the line still opens it, under its name now.
  await line.click();
  await expect(page.getByTestId("opened")).toHaveText(
    '{"tab":"knowledge","detail":{"kind":"skill","skillId":"user:meeting-rooms"}}',
  );

  // A skill the catalog no longer has opens the Knowledge list.
  await page
    .locator('[data-message-id="alone"]')
    .getByRole("link", { name: /^Skill updated/ })
    .click();
  await expect(page.getByTestId("opened")).toHaveText('{"tab":"knowledge","detail":null}');

  // A deleted skill has nothing to open: its line is a plain trace, icon and all.
  await expect(report.getByRole("link")).toHaveCount(1);
  const deleted = report.locator('[data-slot="message-row-meta"]').filter({
    hasText: "Skill deleted · Old checklist",
  });
  await expect(deleted.locator("svg")).toHaveCount(1);

  // A message with only the line draws no bubble and stays at the bubble's inset, never centred.
  const alone = page.locator('[data-message-id="alone"]');
  await expect(alone.locator('[data-slot="message-row-bubble"]')).toHaveCount(0);
  const aloneBox = (await alone.getByRole("link").boundingBox())!;
  const columnBox = (await alone.boundingBox())!;
  expect(aloneBox.x).toBeCloseTo(columnBox.x + 14, 0);

  // The bot writing the same words in its text gets neither the icon nor a button.
  const lookalike = page.locator('[data-message-id="lookalike"]');
  await expect(lookalike.getByText("Skill learned · Book a room")).toBeVisible();
  await expect(lookalike.getByRole("link")).toHaveCount(0);
  await expect(lookalike.locator("svg")).toHaveCount(0);
  await expect(lookalike.locator('[data-slot="message-row-meta"]')).toHaveCount(0);

  // A markdown link that imitates the line is an ordinary anchor: no icon, no line slot, and it
  // leaves for its address instead of opening a skill.
  const lookalikeLink = page.locator('[data-message-id="lookalike-link"]');
  const anchor = lookalikeLink.getByRole("link", { name: "Skill learned · Book a room" });
  await expect(anchor).toHaveJSProperty("tagName", "A");
  await expect(anchor).toHaveAttribute("href", "https://example.test/skills");
  await expect(lookalikeLink.locator("svg")).toHaveCount(0);
  await expect(lookalikeLink.locator('[data-slot="message-row-meta"]')).toHaveCount(0);

  // In a group there is no bot page to open: the line names the skill without a link.
  const group = page.locator('[data-message-id="group"]');
  await expect(group.locator('[data-slot="message-row-meta"]')).toHaveText(
    "Skill learned · Book a room",
  );
  await expect(group.getByRole("link")).toHaveCount(0);

  // A long name is cut to one line inside the bubble.
  const long = page.locator('[data-message-id="long"] [data-slot="message-row-meta"]');
  expect(await long.locator(".truncate").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  expect(await long.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(24);

  await captureScreenshot(page, testInfo, "skill-line-light");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(12, 12, 14)");
  await captureScreenshot(page, testInfo, "skill-line-dark");
});
