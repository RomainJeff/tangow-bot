import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";
import { expect, test } from "./test";

test("adds, replaces and deletes a vault key without ever showing its value", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const first = `fake-vault-key-${stamp}`;
  const second = `fake-vault-key-rotated-${stamp}`;
  await signup(page, `vault-${stamp}@tangow.test`, "password12", `Vault ${stamp}`);
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "vault");
  const dialog = page.getByTestId("vault-item-dialog");
  const row = settings.getByRole("button", { name: /example_api/ });

  await settings.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Site").fill("api.example.test");
  await dialog.getByLabel("Name").fill("example_api");
  await dialog.getByLabel("Key").fill(first);
  await captureScreenshot(page, testInfo, "vault-add");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row).toContainText("api.example.test");
  await captureScreenshot(page, testInfo, "vault-list");

  await row.click();
  await expect(dialog.getByLabel("Key")).toHaveValue("");
  await dialog.getByLabel("Key").fill(second);
  await dialog.getByRole("button", { name: "Replace key" }).click();
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await row.click();
  await expect(dialog.getByLabel("Key")).toHaveValue("");
  await captureScreenshot(page, testInfo, "vault-replace-phone");
  for (const value of [first, second]) {
    await expect(page.locator("body")).not.toContainText(value);
  }
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toBeHidden();
});

test("adds a site login whose password is never shown again", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const password = `fake-login-password-${stamp}`;
  await signup(page, `vault-login-${stamp}@tangow.test`, "password12", `Login ${stamp}`);
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "vault");
  const dialog = page.getByTestId("vault-item-dialog");
  const row = settings.getByRole("button", { name: /example_site/ });

  await settings.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Login", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "New login" })).toBeVisible();
  await dialog.getByLabel("Site").fill("example.test");
  await dialog.getByLabel("Name", { exact: true }).fill("example_site");
  await dialog.getByLabel("Username").fill("me@example.test");
  await dialog.getByLabel("Password").fill(password);
  await captureScreenshot(page, testInfo, "vault-login-add");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row).toContainText("example.test");

  await page.setViewportSize({ width: 390, height: 844 });
  await row.click();
  await expect(dialog.getByLabel("Password")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Replace password" })).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-login-phone");
  await expect(page.locator("body")).not.toContainText(password);
});
