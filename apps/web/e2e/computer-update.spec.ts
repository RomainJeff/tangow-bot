import type { ComputerStatus, ComputerUpdate, ComputerUpdateAllResult } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./test";

test("global Computer settings updates idle computers without taking control and reports busy ones", async ({
  page,
}, testInfo) => {
  await signup(page, `computer-batch-${Date.now()}@rakazo.test`, "password12", "Computer Batch");
  await completeOnboarding(page);
  const busyBotId = await createNamedBot(page, "Busy computer", { computerMode: "dedicated" });
  await rpc(page, "computer/boot", { botId: busyBotId });
  await rpc(page, "computer/takeover", { botId: busyBotId });
  const controlRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/rpc\/computer\/(boot|takeover)$/.test(new URL(request.url()).pathname)) {
      controlRequests.push(request.url());
    }
  });
  const settings = await openUserSettings(page, "computer");
  await expect(settings.getByTestId("computer-settings-row")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "computer-settings-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "computer-settings-phone");
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/rpc/computer/updateAll",
  );
  await settings.getByRole("button", { name: "Update all computers", exact: true }).click();
  const result: { json: ComputerUpdateAllResult } = await (await response).json();
  expect(result.json.queued).toHaveLength(1);
  expect(result.json.skipped).toEqual([
    { botId: busyBotId, name: "Busy computer", reason: "busy" },
  ]);
  await expect(settings.getByRole("status")).toContainText("Updates queued: 1");
  await expect(settings.getByRole("status")).toContainText("Busy. Try again when idle.");
  expect(controlRequests).toEqual([]);
  expect(await rpc<ComputerStatus>(page, "computer/status", { botId: busyBotId })).toMatchObject({
    controlHolder: "user",
    controlBotId: busyBotId,
  });
  await captureScreenshot(page, testInfo, "computer-settings-batch-result");
  await rpc(page, "computer/release", { botId: busyBotId });
});

test("computer maintenance shows durable background progress and failure recovery", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await signup(page, `computer-update-${Date.now()}@rakazo.test`, "password12", "Computer Update");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let updates: ComputerUpdate[] = [];
  const status = await rpc<ComputerStatus>(page, "computer/status", { botId });
  await page.route("**/rpc/computer/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            botId,
            name: "Chief",
            status: {
              ...status,
              state: updates.some((item) => item.status !== "failed" && item.status !== "completed")
                ? "booting"
                : "stopped",
            },
          },
        ],
      },
    }),
  );
  const updating: ComputerUpdate = {
    id: "update-example",
    botId,
    name: "Chief",
    mode: "team",
    action: "update",
    status: "running",
    stage: "restoring",
  };
  await page.route("**/rpc/computer/updates", (route) =>
    route.fulfill({ json: { json: updates } }),
  );
  await page.route("**/rpc/computer/update", (route) => {
    updates = [updating];
    return route.fulfill({ json: { json: updating } });
  });
  await page.route("**/rpc/computer/recover", (route) => {
    updates = [{ ...updating, id: "recovery-example", action: "recover", stage: "preparing" }];
    return route.fulfill({ json: { json: updates[0] } });
  });
  let releases = 0;
  await page.route("**/rpc/computer/releaseInterrupted", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      json: { id: updating.id, workersStopped: true },
    });
    releases++;
    updates = [{ ...updating, status: "failed" }];
    return route.fulfill({ json: { json: { ok: true } } });
  });
  const settings = await openUserSettings(page, "computer");
  await settings.getByTestId("computer-more-button").click();
  await page.getByRole("menuitem", { name: "Update computer", exact: true }).click();
  const dialog = page.getByTestId("computer-update-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Updating Team Computer");
  await expect(dialog.locator('[aria-current="step"]')).toHaveText("Restoring your workspace");
  await captureScreenshot(page, testInfo, "computer-update-progress");
  await dialog.getByRole("button", { name: "Continue in Background" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(settings.getByTestId("computer-more-button")).toBeDisabled();
  await captureScreenshot(page, testInfo, "computer-update-background");
  updates = [];
  await expect(settings.getByTestId("computer-more-button")).toBeEnabled();
  updates = [updating];
  await page.reload();
  await page.getByRole("button", { name: /Updating Team Computer/ }).click();
  await expect(dialog).toBeVisible();
  updates = [{ ...updating, status: "interrupted" }];
  await expect(
    dialog.getByText("Recovery is unavailable until the previous operation has stopped."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-interrupted");
  updates = [{ ...updating, status: "interrupted", canReleaseReservation: true }];
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await captureScreenshot(page, testInfo, "computer-update-release-confirmation");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(releases).toBe(0);
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  await confirmation.getByRole("button", { name: "Nothing is still running", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Recover computer", exact: true })).toBeVisible();
  expect(releases).toBe(1);
  await expect(dialog.getByRole("heading")).toHaveText("Update failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Recovering Team Computer");
  await captureScreenshot(page, testInfo, "computer-recovery-progress");
  updates = [];
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
});
