import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";
import { expect, test } from "./test";

test("a bot shared with one person gives them their own thread until it is unshared", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `share-owner-${stamp}@rakazo.test`, "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  await rpc(page, "spaces/rename", { spaceId, name: "Studio" });
  const { url: inviteUrl } = await rpc<{ url: string }>(page, "spaces/createInvite", { spaceId });
  await createNamedBot(page, "Release notes");
  await rpc(page, "agentSkills/create", {
    name: "Changelog",
    description: "Write the changelog",
    body: "Steps",
  });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, `share-guest-${stamp}@rakazo.test`, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);
  const guestSidebar = guest.locator("aside").first();
  await expect(guestSidebar.getByRole("button", { name: /^Release notes/ })).toHaveCount(0);

  const ownerRow = page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Release notes/ });
  await ownerRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const sheet = page.getByTestId("share-bot-dialog");
  await expect(sheet.getByRole("heading", { name: "Share Release notes" })).toBeVisible();
  const grace = sheet.getByRole("checkbox", { name: "Grace Guest" });
  const filesNote = sheet.getByText(
    "Everyone who uses this bot can see its files and browser sign-ins.",
  );
  const skillsHeading = sheet.getByRole("heading", { name: "Skills this bot can use" });
  const changelog = sheet.getByRole("checkbox", { name: "Changelog" });
  await expect(filesNote).toHaveCount(0);
  await expect(skillsHeading).toHaveCount(0);
  await grace.click();
  await expect(grace).toBeChecked();
  await expect(filesNote).toBeVisible();
  await expect(sheet.getByRole("switch", { name: "Everyone in Studio" })).not.toBeChecked();
  await expect(skillsHeading).toBeVisible();
  await expect(changelog).not.toBeChecked();
  await changelog.click();
  await expect(changelog).toBeChecked();
  await captureScreenshot(page, testInfo, "share-sheet");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "share-sheet-phone");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  await guest.reload();
  await guestSidebar.getByRole("button", { name: /^Release notes/ }).click();
  await expect(guest.getByTestId("open-settings-panel")).toHaveCount(0);
  await guest.getByPlaceholder("Message Release notes").fill("Hello from Grace");
  await guest.keyboard.press("Enter");
  await expect(guest.getByText("Hello from Grace")).toBeVisible();
  await captureScreenshot(guest, testInfo, "shared-bot-member-thread");

  await page.reload();
  await expect(page.getByPlaceholder("Message Release notes")).toBeVisible();
  await expect(page.getByText("Hello from Grace")).toHaveCount(0);

  await ownerRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  await grace.click();
  await expect(grace).not.toBeChecked();
  await expect(filesNote).toHaveCount(0);
  await page.keyboard.press("Escape");

  await guest.reload();
  await expect(guestSidebar.getByRole("button", { name: /^Release notes/ })).toHaveCount(0);
  await guestContext.close();
});
