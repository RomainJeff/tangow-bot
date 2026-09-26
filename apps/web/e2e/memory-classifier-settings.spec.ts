import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("shared judgment connection: masked key, failed probe, connect, reopen and disconnect", async ({
  page,
}, testInfo) => {
  await signup(page, `classifier-${randomUUID()}@rakazo.test`, "password12", "Classifier Fixture");
  await completeOnboarding(page);
  let connected = false;
  let attempts = 0;
  const settings = () => ({
    spaceName: "Demo Space",
    canConfigure: true,
    providers: [{ id: "typesafe-jev", name: "Jev · TypeSafe", defaultModel: "jev-latest" }],
    connection: connected ? { provider: "typesafe-jev", model: "jev-latest" } : null,
  });
  // Only provider-facing routes are mocked: no real credentials or paid calls in CI.
  await page.route("**/rpc/models/judgmentConnection/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.split("/").at(-1);
    if (procedure === "connect") {
      const input = route.request().postDataJSON().json;
      expect(input).toEqual({
        provider: "typesafe-jev",
        model: "jev-latest",
        apiKey: "fake-demo-key",
      });
      attempts++;
      if (attempts === 1) {
        await route.fulfill({
          status: 400,
          json: {
            json: { defined: false, code: "BAD_REQUEST", status: 400, message: "Probe failed" },
          },
        });
        return;
      }
      connected = true;
    }
    if (procedure === "disconnect") connected = false;
    await route.fulfill({ json: { json: settings() } });
  });
  let allowed = false;
  await page.route("**/rpc/aiConsent/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.split("/").at(-1);
    const input = route.request().postDataJSON().json;
    if (procedure === "allow") {
      expect(input).toMatchObject({
        keys: ["fixture-jev"],
        query: { uses: ["memory-classification"] },
      });
      allowed = true;
    }
    if (procedure === "revoke") {
      expect(input.key).toBe("fixture-jev");
      allowed = false;
    }
    await route.fulfill({
      json: {
        json: {
          scope: "fixture",
          version: "2026-09-24",
          recipients: [
            {
              key: "fixture-jev",
              name: "Jev · TypeSafe",
              use: "memory-classification",
              detail: "jev-latest",
              allowed,
            },
          ],
        },
      },
    });
  });
  await openUserSettings(page, "models");
  await page.locator("summary", { hasText: /^Judgment model$/ }).click();
  const panel = page.getByTestId("judgment-connection-settings");
  await expect(panel.getByLabel("Model", { exact: true })).toHaveValue("jev-latest");
  await expect(panel.getByRole("button", { name: "Test and connect" })).toBeDisabled();
  await panel.getByLabel("API key", { exact: true }).fill("fake-demo-key");
  await expect(panel.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await captureScreenshot(page, testInfo, "memory-judgment-connection");
  await panel.getByRole("button", { name: "Test and connect" }).click();
  await expect(panel.getByRole("alert")).toContainText("Could not connect");
  await expect(panel.getByLabel("API key", { exact: true })).toHaveValue("fake-demo-key");
  await panel.getByRole("button", { name: "Test and connect" }).click();
  await expect(panel.getByRole("status")).toHaveText("Connected");
  await expect(panel.getByLabel("API key", { exact: true })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Allow memory analysis", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Allow memory analysis", exact: true }).click();
  await expect.poll(() => allowed).toBe(true);
  await panel.locator("summary", { hasText: "Data sharing" }).click();
  await expect(
    panel.getByRole("button", { name: "Withdraw permission", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-classifier-connected");
  await panel.getByRole("button", { name: "Withdraw permission", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Allow memory analysis", exact: true }),
  ).toBeVisible();
  expect(allowed).toBe(false);

  await page.locator("summary", { hasText: /^Judgment model$/ }).click();
  await page.locator("summary", { hasText: /^Judgment model$/ }).click();
  await expect(panel.getByRole("status")).toHaveText("Connected");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(panel.getByLabel("API key", { exact: true })).toHaveValue("");
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Test and connect" })).toBeDisabled();
  expect(attempts).toBe(2);
});
