import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./test";

test("a group's creator adds a person, who writes in it and leaves", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `group-people-owner-${stamp}@rakazo.test`, "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  const { url: inviteUrl } = await rpc<{ url: string }>(page, "spaces/createInvite", { spaceId });
  // Scout stays Ada's alone; Helper is shared with the Space.
  await createNamedBot(page, "Scout");
  const helperId = await createNamedBot(page, "Helper");
  await rpc(page, "bots/share", { botId: helperId, visibility: "space", userIds: [] });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, `group-people-guest-${stamp}@rakazo.test`, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);

  await page.reload();
  await openNewGroup(page);
  const panel = page.getByTestId("side-panel");
  await panel.locator("label:has-text('Name') input").fill("Launch crew");
  await panel.getByRole("button", { name: "Grace Guest" }).click();
  await panel.getByRole("button", { name: "Helper" }).click();
  await panel.getByRole("button", { name: "Scout" }).click();
  await panel.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  // The lead answers a message naming no bot: Ada makes it her own Scout.
  await page.getByTestId("bot-settings-trigger").click();
  await expect(panel.getByRole("button", { name: "Grace Guest" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await panel.getByLabel("Lead bot").selectOption({ label: "Scout" });
  await captureScreenshot(page, testInfo, "group-settings-people");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "group-settings-people-phone");
  await page.setViewportSize({ width: 1280, height: 720 });
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  const composer = page.getByRole("combobox", { name: "Message Launch crew" });
  await composer.fill("Kickoff is at noon.");
  await composer.press("Enter");
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Kickoff is at noon.", { exact: true })).toBeVisible();

  // The group is in Grace's own sidebar, and Ada's message carries her name.
  await guest.reload();
  await guest
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Launch crew/ })
    .click();
  const guestTranscript = guest.getByTestId("transcript");
  await expect(guestTranscript.getByText("Kickoff is at noon.", { exact: true })).toBeVisible();
  await expect(guestTranscript.getByText("Ada Owner", { exact: true })).toBeVisible();

  // Only the bot Grace can wake is offered; Ada's own Scout is not.
  const guestComposer = guest.getByRole("combobox", { name: "Message Launch crew" });
  await guestComposer.fill("@");
  await expect(guest.getByRole("option", { name: "@Helper", exact: true })).toBeVisible();
  await expect(guest.getByRole("option", { name: "@Scout", exact: true })).toHaveCount(0);
  // Naming no bot wakes the lead, Scout, which Grace cannot use: the message stands alone.
  await guestComposer.fill("Works for me.");
  await guestComposer.press("Enter");
  await expect(guestTranscript.getByText("Works for me.", { exact: true })).toBeVisible();
  // A shared history: nobody edits it alone.
  await expect(guest.getByTestId("message-edit")).toHaveCount(0);

  await page.reload();
  await expect(transcript.getByText("Works for me.", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Grace Guest", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-people-thread");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "group-people-thread-phone");
  await page.setViewportSize({ width: 1280, height: 720 });

  // Grace sees who is in it, changes nothing, and leaves.
  await guest.getByTestId("bot-settings-trigger").click();
  const guestPanel = guest.getByTestId("side-panel");
  await expect(guestPanel.getByText("Ada Owner", { exact: true })).toBeVisible();
  await expect(guestPanel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await guestPanel.getByRole("button", { name: "Leave group", exact: true }).click();
  await guest.waitForURL(/\/app\/(?!g\/)[^/]+$/);
  await expect(
    guest
      .locator("aside")
      .first()
      .getByRole("button", { name: /^Launch crew/ }),
  ).toHaveCount(0);
  await guestContext.close();
});
