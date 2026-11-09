import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";
import { expect, test } from "./test";

test("an invite link survives sign up and joins the invited space", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = Date.now();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signup(page, `invite-owner-${stamp}@rakazo.test`, "password12", "Ada Owner");
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "space");
  const name = settings.getByTestId("space-name-input");
  await name.fill("Family");
  await name.press("Enter");
  await expect(settings.getByTestId("settings-space-label")).toContainText("Family");
  const members = settings.getByTestId("space-members");
  await expect(members.getByText("Ada Owner", { exact: true })).toBeVisible();
  await members.getByRole("button", { name: "Copy invite link" }).click();
  await expect(members.getByRole("button", { name: "Link copied" })).toBeVisible();
  await expect(members.getByTestId("space-invite-row")).toHaveText(
    /Invite link · expires in 7 days/,
  );
  await captureScreenshot(page, testInfo, "space-members-invite-link");
  const inviteUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(inviteUrl).pathname).toMatch(/^\/invite\/.+/);

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await guest.goto(inviteUrl);
  await guest.waitForURL(/\/sign-in$/);
  await guest.getByRole("link", { name: "Sign up" }).click();
  await guest.getByPlaceholder("Your name").fill("Grace Guest");
  await guest.getByPlaceholder("Your email address").fill(`invite-guest-${stamp}@rakazo.test`);
  await guest.getByPlaceholder("Password").fill("password12");
  await guest.getByRole("button", { name: "Create account" }).click();

  await expect(guest.getByRole("heading", { name: "Join Family" })).toBeVisible();
  await expect(guest.getByText("Invited by Ada Owner")).toBeVisible();
  await captureScreenshot(guest, testInfo, "invite-accept");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "invite-accept-phone");
  await guest.setViewportSize({ width: 1280, height: 720 });

  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/(app|onboarding)/);
  const { spaceId: ownerSpaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  await expect
    .poll(() => guest.evaluate(() => window.localStorage.getItem("rakazo:space-id")))
    .toBe(ownerSpaceId);
  await expect(guest.getByText("Family", { exact: true }).first()).toBeVisible();

  await guest.goto(inviteUrl);
  await expect(guest.getByText("This invite link has expired or was already used.")).toBeVisible();
  await guestContext.close();

  await page.reload();
  const reopened = await openUserSettings(page, "space");
  const roster = reopened.getByTestId("space-members");
  await expect(roster.getByText("Grace Guest", { exact: true })).toBeVisible();
  await expect(roster.getByTestId("space-invite-row")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "space-members");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "space-members-phone");
});
