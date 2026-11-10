import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";
import { expect, test } from "./test";

test("a member's run on a shared bot saves for the team and the thread says so", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `team-memory-owner-${stamp}@rakazo.test`, "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  const { url: inviteUrl } = await rpc<{ url: string }>(page, "spaces/createInvite", { spaceId });
  const botId = await createNamedBot(page, "Release notes");
  await rpc(page, "bots/share", { botId, visibility: "space", userIds: [] });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, `team-memory-guest-${stamp}@rakazo.test`, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);
  await guest
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Release notes/ })
    .click();
  await guest
    .getByPlaceholder("Message Release notes")
    .fill("Remember for the team that release notes go out on Thursdays");
  await guest.keyboard.press("Enter");
  await expect(guest.getByText("noted for the team.")).toBeVisible();
  await expect(guest.getByText("Saved for the team", { exact: true })).toBeVisible();
  await guest.mouse.move(1, 1);
  await captureScreenshot(guest, testInfo, "team-memory-thread-line");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "team-memory-thread-line-phone");
  await guestContext.close();
});
