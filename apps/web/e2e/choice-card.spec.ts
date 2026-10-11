import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./test";
import { threadEntries } from "./thread-log";

test("renders tappable choice buttons and submits the offered action id", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `choice-card-${stamp}@rakazo.test`, "password12", "Choice Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("pick from these cities with tappable choices");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await prompt.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(prompt).toBeVisible({ timeout: 15_000 });

  const berlin = page.getByRole("button", { name: "Berlin", exact: true });
  const seoul = page.getByRole("button", { name: "Seoul", exact: true });
  const toronto = page.getByRole("button", { name: "Toronto", exact: true });
  const lisbon = page.getByRole("button", { name: "Lisbon", exact: true });
  await expect(berlin).toBeVisible();
  await expect(seoul).toBeVisible();
  await expect(toronto).toBeVisible();
  await expect(lisbon).toBeVisible();

  // Options render as wrapping quick-reply capsules inside the shared options container;
  // these short labels share one row at this width.
  const optionsContainer = page.getByTestId("ask-options").filter({ has: berlin });
  await expect(optionsContainer).toBeVisible();
  const berlinBox = await berlin.boundingBox();
  const seoulBox = await seoul.boundingBox();
  const torontoBox = await toronto.boundingBox();
  expect(berlinBox).toBeTruthy();
  expect(seoulBox).toBeTruthy();
  expect(torontoBox).toBeTruthy();
  expect(Math.abs(berlinBox!.y - seoulBox!.y)).toBeLessThan(2);
  expect(Math.abs(seoulBox!.y - torontoBox!.y)).toBeLessThan(2);
  expect(seoulBox!.x).toBeGreaterThan(berlinBox!.x + berlinBox!.width - 2);
  await captureScreenshot(page, testInfo, "choice-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(berlin).toBeVisible();
  await expect(lisbon).toBeVisible();
  // On a phone the capsules wrap rather than overflow the card.
  const narrowOptions = await optionsContainer.boundingBox();
  const narrowLisbon = await lisbon.boundingBox();
  expect(narrowOptions).toBeTruthy();
  expect(narrowLisbon).toBeTruthy();
  expect(narrowLisbon!.x + narrowLisbon!.width).toBeLessThanOrEqual(
    narrowOptions!.x + narrowOptions!.width + 1,
  );
  await expect(lisbon).toBeEnabled();
  await captureScreenshot(page, testInfo, "choice-card-narrow");

  await page.setViewportSize({ width: 1280, height: 720 });
  const answered = page.waitForRequest((request) => request.url().includes("/rpc/threads/answer"));
  await seoul.click();
  expect((await answered).postDataJSON().json.answer).toBe("choice-2");

  await expect(page.getByText("Answered: Seoul", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Seoul", exact: true })).toHaveCount(0);

  await expect
    .poll(
      async () => {
        const entries = await threadEntries(page, { botId });
        const ask = entries.find((entry) => entry.type === "assistant.ask");
        if (!ask) return null;
        const reply = entries.find(
          (entry) => entry.type === "user.message" && entry.payload.replyTo?.entryId === ask.id,
        );
        const answered = entries.find(
          (entry) => entry.type === "card.answered" && entry.payload.target === ask.id,
        );
        return {
          reply: reply?.type === "user.message" ? reply.payload.blocks : null,
          answer: answered?.type === "card.answered" ? answered.payload.answer : null,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ reply: [{ kind: "text", text: "Seoul" }], answer: "choice-2" });

  await captureScreenshot(page, testInfo, "choice-card-answered");
});
