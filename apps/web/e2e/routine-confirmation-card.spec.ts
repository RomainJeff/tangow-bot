// Needs the Vite dev server: the fixture is served from source and is not a build entry.
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

test("a routine the user asked for shows a settled card that opens on when it runs and links to it", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/routine-confirmation.html");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  const weekly = page.getByTestId("routine-confirmation-weekly");
  await expect(weekly.getByText("Mondays at 09:00 Europe/Paris")).toBeVisible();
  await expect(
    weekly.getByRole("link", { name: /Routine created · Offres de la semaine/ }),
  ).toHaveAttribute("href", "/app/bot-1?routine=routine-1");

  const once = page.getByTestId("routine-confirmation-once");
  await expect(once.getByText("Once on Oct 7, 2026 at 17:00 Europe/Paris")).toBeVisible();
  await expect(once.getByRole("link", { name: /Routine created · Tea/ })).toHaveAttribute(
    "href",
    "/app/bot-1?routine=routine-2",
  );

  const updated = page.getByTestId("routine-confirmation-updated");
  await expect(updated.getByText("Mondays at 08:00 Europe/Paris")).toBeVisible();
  await expect(
    updated.getByRole("link", { name: /Routine updated · Offres de la semaine/ }),
  ).toHaveAttribute("href", "/app/bot-1?routine=routine-1");

  for (const card of [weekly, once, updated]) {
    await expect(card.locator("button")).toHaveCount(0);
    await expect(card.getByText("Needs your call")).toHaveCount(0);
    await expect(card.locator("pre")).toHaveCount(0);
  }

  await page.mouse.move(0, 0);
  const shot = testInfo.outputPath("routine-confirmation-card.png");
  await weekly.screenshot({ animations: "disabled", caret: "hide", path: shot });
  await testInfo.attach("routine-confirmation-card", { contentType: "image/png", path: shot });
  const updatedShot = testInfo.outputPath("routine-updated-card.png");
  await updated.screenshot({ animations: "disabled", caret: "hide", path: updatedShot });
  await testInfo.attach("routine-updated-card", { contentType: "image/png", path: updatedShot });
  await captureScreenshot(page, testInfo, "routine-confirmation-light");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(12, 12, 14)");
  await captureScreenshot(page, testInfo, "routine-confirmation-dark");
});
