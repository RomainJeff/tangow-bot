import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("edit and resend rewinds the thread to the edited message", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `rewind-${stamp}@rakazo.test`, "password12", "Rewind User");
  await completeOnboarding(page);

  const firstText = `rewind-first-${stamp}`;
  const secondText = `rewind-second-${stamp}`;
  const editedText = `rewind-edited-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(firstText);
  await composer.press("Enter");

  const transcript = page.getByTestId("transcript");
  const firstRow = transcript.locator("[data-message-id]").filter({ hasText: firstText }).first();
  await expect(firstRow).toBeVisible({ timeout: 20_000 });

  await composer.fill(secondText);
  await composer.press("Enter");
  const secondRow = transcript.locator("[data-message-id]").filter({ hasText: secondText }).first();
  await expect(secondRow).toBeVisible({ timeout: 20_000 });

  // Edit and resend sits under your own bubble on hover.
  await firstRow.hover();
  await firstRow.getByRole("button", { name: "Edit and resend" }).click();

  const chip = page.getByTestId("rewind-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/Editing message from/);
  await expect(composer).toHaveValue(firstText);
  await expect(firstRow).toHaveAttribute("data-rewound", "true");
  await expect(secondRow).toHaveAttribute("data-rewound", "true");
  await captureScreenshot(page, testInfo, "message-rewind-mode");

  // Escape leaves the thread untouched.
  await composer.press("Escape");
  await expect(chip).toHaveCount(0);
  await expect(secondRow).toBeVisible();

  await firstRow.hover();
  await firstRow.getByRole("button", { name: "Edit and resend" }).click();
  await expect(page.getByTestId("rewind-chip")).toBeVisible();
  await composer.fill(editedText);
  await composer.press("Enter");

  await expect(page.getByTestId("rewind-chip")).toHaveCount(0);
  await expect(
    transcript.locator("[data-message-id]").filter({ hasText: editedText }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(transcript.locator("[data-message-id]").filter({ hasText: secondText })).toHaveCount(
    0,
  );
  await expect(transcript.locator("[data-message-id]").filter({ hasText: firstText })).toHaveCount(
    0,
  );
});
