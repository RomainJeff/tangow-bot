// Needs the Vite dev server: the fixture is served from source and is not a build entry.
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

test("a routine the bot proposes shows what it creates, decides on the right, and settles", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/routine-proposal.html");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  const pending = page.getByTestId("routine-proposal-pending");
  const preview = pending.getByTestId("routine-preview");
  await expect(pending.getByText("Je m'en occupe chaque lundi matin ?")).toBeVisible();
  await expect(preview.getByText("Offres de la semaine", { exact: true })).toBeVisible();
  await expect(preview.getByText("Mondays at 09:00 Europe/Paris")).toBeVisible();
  await expect(preview.getByText("Notifies you each run")).toBeVisible();
  await expect(pending.getByText("Needs your call")).toHaveCount(0);
  await expect(pending.locator("[data-consequential]")).toHaveCount(0);

  const actions = pending.locator('[data-slot="framed-block-actions"][data-align="end"]');
  const labels = await actions.locator("button").allTextContents();
  expect(labels).toEqual(["Not now", "Create routine"]);
  const box = (await actions.boundingBox())!;
  const create = (await actions.getByRole("button", { name: "Create routine" }).boundingBox())!;
  expect(create.x + create.width).toBeCloseTo(box.x + box.width, 0);

  const created = page.getByTestId("routine-proposal-created");
  await expect(
    created.getByRole("link", { name: /Routine created · Offres de la semaine/ }),
  ).toHaveAttribute("href", "/app/bot-1?routine=routine-1");
  await expect(created.getByTestId("routine-preview")).toHaveCount(0);
  await expect(page.getByTestId("routine-proposal-not-now")).toContainText("Not now");
  await expect(page.getByTestId("routine-proposal-dismissed")).toContainText("Not now");
  await expect(page.getByTestId("routine-proposal-failed")).toContainText("Couldn't create");

  await page.mouse.move(0, 0);
  const shot = testInfo.outputPath("routine-proposal-card.png");
  await pending.screenshot({ animations: "disabled", caret: "hide", path: shot });
  await testInfo.attach("routine-proposal-card", { contentType: "image/png", path: shot });
  await captureScreenshot(page, testInfo, "routine-proposal-light");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(22, 22, 24)");
  await captureScreenshot(page, testInfo, "routine-proposal-dark");
});
