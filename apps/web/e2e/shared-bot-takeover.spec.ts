import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./test";

test("a member takes over their own screen when their run on a shared bot asks", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `takeover-owner-${stamp}@rakazo.test`, "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  const { url: inviteUrl } = await rpc<{ url: string }>(page, "spaces/createInvite", { spaceId });
  const botId = await createNamedBot(page, "Release notes");
  await rpc(page, "bots/share", { botId, visibility: "space", userIds: [] });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, `takeover-guest-${stamp}@rakazo.test`, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);
  await guest
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Release notes/ })
    .click();
  await guest.getByPlaceholder("Message Release notes").fill("install the gsc cli and sign in");
  await guest.keyboard.press("Enter");

  const openFromCard = guest.getByTestId("takeover-open-computer");
  await expect(openFromCard).toHaveCount(1, { timeout: realSandboxTimeout(90_000, 30_000) });
  await openFromCard.click();
  const done = guest.getByRole("button", { name: "I’m done", exact: true }).last();
  await expect(done).toBeVisible();
  await expect(guest.locator('iframe[title="Bot screen"]')).toBeVisible();
  // Teaching and the computer's upkeep stay with the owner.
  await expect(guest.getByTestId("teach-start-button")).toHaveCount(0);
  await captureScreenshot(guest, testInfo, "shared-bot-member-takeover");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "shared-bot-member-takeover-phone");
  await guest.setViewportSize({ width: 1280, height: 720 });

  await done.click();
  await expect(guest.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(guest.getByText(/signed in|session stays/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await guestContext.close();
});
