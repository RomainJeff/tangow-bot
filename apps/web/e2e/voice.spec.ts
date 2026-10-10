import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";
import { expect, test } from "./test";

test("voice settings connect a key, speak a reply, and open a call", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Voice ${stamp}`;
  await signup(page, `voice-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await expect(page.getByRole("button", { name: "Call", exact: true })).toHaveCount(0);
  // The call moved to the thread header; the composer's mic is dictation now.
  await expect(page.getByTestId("open-voice-call")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "voice-header");
  await page.getByTestId("open-voice-call").click();
  await expect(page.getByTestId("voice-settings")).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "voice-settings");
  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("voice-settings")).toHaveCount(0);

  const preparedOff = await rpc<{ ready: boolean }>(page, "voice/prepare", {
    text: "Hello there.",
  });
  expect(preparedOff.ready).toBe(false);

  await openUserSettings(page, "voice");
  await expect(page.getByTestId("voice-settings")).toBeVisible();
  await page.getByRole("button", { name: /Scripted/ }).click();
  const apiKeyInput = page.getByPlaceholder(/Paste your API key/);
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-voice-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "voice-settings-connected");

  const spoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await page.getByRole("button", { name: "Hear a sample" }).click();
  const clip = await spoken;
  expect(clip.headers()["content-type"]).toContain("audio/mpeg");

  const credentials = await rpc<Array<{ hasKey: boolean; provider: string }>>(
    page,
    "voice/credentials",
    {},
  );
  expect(credentials).toEqual([expect.objectContaining({ hasKey: true, provider: "scripted" })]);
  expect(JSON.stringify(credentials)).not.toContain("fake-scripted-voice-key");

  await page.getByRole("button", { name: "Close voice settings" }).click();

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("say hello");
  await page.keyboard.press("Enter");
  // Speak now lives in the row's hover pill, so the row needs a hover first.
  // A reply can render more than one text bubble; speak the latest one.
  const replyRow = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ has: page.getByRole("button", { name: "Speak this reply" }) })
    .last();
  await expect(replyRow).toBeVisible({ timeout: 30_000 });
  await replyRow.hover();
  const speakReply = replyRow.getByRole("button", { name: "Speak this reply" });
  await expect(speakReply).toBeVisible();

  const replySpoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await speakReply.click();
  await replySpoken;

  await openUserSettings(page, "voice");
  await expect(page.getByRole("button", { name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close voice settings" }).click();

  // The screen panel sits above the call view; starting a call
  // must close it so it can never hide Mute/End call behind it.
  await page.getByTestId("open-computer-panel").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "computer");

  await page.getByTestId("open-voice-call").click();
  await expect(page.getByTestId("call-view")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
  await captureScreenshot(page, testInfo, "call-view");

  const appearanceSettings = await openUserSettings(page);
  await appearanceSettings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await appearanceSettings.getByRole("button", { name: "Close user settings" }).click();
  await expect(appearanceSettings).toBeHidden();
  await captureScreenshot(page, testInfo, "call-view-dark");

  await page.getByRole("button", { name: "End call" }).click();
  await expect(page.getByTestId("call-view")).toHaveCount(0);

  await openUserSettings(page, "voice");
  const settings = page.getByTestId("voice-settings");
  await settings.getByPlaceholder(/Paste a replacement key/).fill("leftover-voice-key");
  await settings.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(rpc<Array<{ provider: string }>>(page, "voice/credentials", {})).resolves.toEqual(
    [],
  );
});
