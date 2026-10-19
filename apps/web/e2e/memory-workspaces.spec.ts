import { randomUUID } from "node:crypto";
import type { Space, SpaceNavigation } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`memory identifies and switches workspace from global settings (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await signup(page, `memory-spaces-${randomUUID()}@rakazo.test`, "password12", "Space Fixture");
    await completeOnboarding(page);
    const conversation = page.url();
    const navigation = await rpc<SpaceNavigation>(page, "spaces/list", {});
    const other = await rpc<Space>(page, "spaces/create", { name: "Research team" });
    for (const [spaceId, title] of [
      [navigation.current.id, "Personal workspace protocol"],
      [other.id, "Research workspace protocol"],
    ]) {
      const response = await page.request.post("/rpc/memory/library/create", {
        headers: { "x-rakazo-space-id": spaceId! },
        data: {
          json: {
            collection: "space",
            title,
            content: "Prepare open questions.",
            idempotencyKey: randomUUID(),
          },
        },
      });
      expect(response.ok()).toBeTruthy();
    }
    const openNavigation = page.getByRole("button", { name: "Open navigation", exact: true });
    if (await openNavigation.isVisible()) await openNavigation.click();
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByRole("textbox", { name: "Organization API key" })).not.toBeVisible();
    await page.getByRole("button", { name: "Open memory", exact: true }).click();
    const workspace = page.getByRole("combobox", { name: "Space", exact: true });
    await expect(workspace).toHaveValue(navigation.current.id);
    await expect(page.getByTestId("memory-list")).toContainText("Personal workspace protocol");
    await expect(page.getByTestId("memory-list")).not.toContainText("Research workspace protocol");
    await workspace.selectOption(other.id);
    await expect(page).toHaveURL(new RegExp(`space=${other.id}`));
    await expect(page.getByTestId("memory-list")).toContainText("Research workspace protocol");
    await expect(page.getByTestId("memory-list")).not.toContainText("Personal workspace protocol");
    await page.getByRole("button", { name: "Research workspace protocol", exact: true }).click();
    await expect(page.getByTestId("memory-detail").getByTestId("memory-location")).toContainText(
      "Research team",
    );
    await page.reload();
    await expect(page.getByTestId("memory-detail").getByTestId("memory-location")).toContainText(
      "Research team",
    );
    await page.getByRole("button", { name: "Close memory", exact: true }).click();
    await expect(workspace).toHaveValue(other.id);
    await captureScreenshot(page, testInfo, `memory-workspaces-${viewport.name}`);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(conversation);
  });
}

test("an unavailable workspace does not strand memory navigation", async ({ page }) => {
  await signup(page, `memory-missing-${randomUUID()}@rakazo.test`, "password12", "Space Fixture");
  await completeOnboarding(page);
  const conversation = page.url();
  await page.goto("/app/memory?space=unavailable-space&collection=space");
  await expect(page.getByRole("alert")).toHaveText("Could not load space");
  await expect(page.getByTestId("memory-list")).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(conversation);
});
