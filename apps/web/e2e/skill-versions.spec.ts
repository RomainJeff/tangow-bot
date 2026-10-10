// Needs the Vite dev server: the fixture is served from source and is not a build entry.
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const open = async (page: Page, query: string) => {
  await page.goto(`/e2e/fixtures/skill-versions.html?${query}`);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
};

const versions = (page: Page) => page.getByTestId("skill-version");

test("Versions shows only when there is something to undo or read", async ({ page }) => {
  await open(page, "skill=user:lone-user");
  await expect(page.getByTestId("bot-knowledge-skill-editor")).toBeVisible();
  await expect(page.getByTestId("skill-versions")).toHaveCount(0);

  await open(page, "skill=builtin:readonly");
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(page.getByTestId("skill-versions")).toHaveCount(0);

  await open(page, "skill=user:lone-bot");
  await expect(versions(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
});

test("Undo moves the current mark back one version and keeps the undone one readable", async ({
  page,
}, testInfo) => {
  await open(page, "skill=user:rooms");
  await expect(versions(page)).toHaveCount(4);
  await expect(versions(page).nth(0)).toContainText("Scout · updated · Undone");
  await expect(versions(page).nth(1)).toHaveAttribute("aria-current", "true");
  await expect(versions(page).nth(1)).toContainText("You · updated");
  await expect(versions(page).nth(3)).toContainText("Scout · learned");
  await expect(versions(page).nth(1).locator('[data-current="true"]')).toHaveCSS("opacity", "1");
  await captureScreenshot(page, testInfo, "skill-versions-light");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(versions(page).nth(2)).toHaveAttribute("aria-current", "true");
  await expect(versions(page).nth(1)).toContainText("You · updated · Undone");
  await expect(versions(page).nth(1)).not.toHaveAttribute("aria-current", "true");
  await expect(versions(page).nth(1).locator("[data-current]")).toHaveCSS("opacity", "0");

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await captureScreenshot(page, testInfo, "skill-versions-dark");
});

test("an Undo refused because the skill changed shows the server's sentence and reloads", async ({
  page,
}) => {
  await open(page, "skill=user:rooms&conflict=1");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("This skill changed. Reload and try again.");
  await expect(versions(page).nth(1)).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(versions(page).nth(2)).toHaveAttribute("aria-current", "true");
});

test("Undo on a bot's creation closes the editor", async ({ page }) => {
  await open(page, "skill=user:lone-bot");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("closed")).toHaveText("changed");
});

test("a version opens read-only, and only an older one can be deleted", async ({
  page,
}, testInfo) => {
  await open(page, "skill=user:rooms");
  await versions(page).nth(1).click();
  const view = page.getByTestId("skill-version-view");
  await expect(view).toContainText("Open the booking tool");
  await expect(view.getByText("scripts/book.py")).toBeVisible();
  await expect(view.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await view.getByRole("button", { name: "Back" }).click();

  await versions(page).nth(2).click();
  await expect(view.locator("pre")).toHaveCSS("background-color", /rgb/);
  await captureScreenshot(page, testInfo, "skill-version-view-light");
  await view.getByRole("button", { name: "Delete" }).click();
  await expect(view.getByRole("button", { name: "Confirm delete" })).toBeVisible();
  await view.getByRole("button", { name: "Confirm delete" }).click();
  await expect(versions(page)).toHaveCount(3);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
});
