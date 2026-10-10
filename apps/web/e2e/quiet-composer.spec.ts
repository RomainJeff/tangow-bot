import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  openUserSettings,
  signup,
} from "./helpers";
import { expect, type Locator, type Page, test } from "./test";

async function setupGroupComposer(page: Page) {
  const stamp = Date.now();
  await signup(page, `quiet-composer-${stamp}@rakazo.test`, "password12", "Quiet Composer");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const helperId = await createNamedBot(page, "Helper");
  expect(helperId).toBeTruthy();

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Quiet composer team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Helper" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: "Message Quiet composer team" });
  await expect(composer).toBeVisible();
  return composer;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  const settings = await openUserSettings(page);
  await settings.getByTestId(`ui-appearance-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

/**
 * Stubs `window.SpeechRecognition` before the app loads, so the composer's
 * dictation (`apps/web/src/lib/dictation.ts`) drives a fake engine instead of
 * a real one. The test reaches the running instance through
 * `window.__fakeRecognition` to fire `onresult` the way a browser would.
 */
async function stubSpeechRecognition(page: Page) {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        Object.assign(window, { __fakeRecognition: this });
      }
      stop() {}
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: FakeSpeechRecognition });
  });
}

function speak(page: Page, transcript: string) {
  return page.evaluate((text) => {
    const rec = (
      window as unknown as {
        __fakeRecognition?: { onresult?: (event: unknown) => void };
      }
    ).__fakeRecognition;
    rec?.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] });
  }, transcript);
}

/** Adds a mention chip for Helper and returns it. */
async function addMentionChip(page: Page, composer: Locator) {
  await composer.fill("@Help");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: "@Helper" }).click();
  const chip = page.getByTestId("mention-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Helper");
  return chip;
}

async function removeMentionChip(page: Page) {
  await page.getByRole("button", { name: "Remove mention Helper" }).click();
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
}

test("composer capsule: empty, typing, and mention chip in light and dark", async ({
  page,
}, testInfo) => {
  const composer = await setupGroupComposer(page);
  const bar = page.getByTestId("composer-bar");

  // Empty — the round-icon buttons show, but Send only mounts once there's a draft.
  await expect(bar.getByRole("button", { name: "Attach file" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  const emptyBox = await composer.boundingBox();
  expect(emptyBox).toBeTruthy();
  await captureScreenshot(page, testInfo, "quiet-composer-empty-light");

  // Typing — Send appears, but the field doesn't reflow: an aria-hidden placeholder
  // holds Send's footprint while it's unmounted, so the row width stays constant.
  await composer.fill("Ping the team about the launch");
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  const typingBox = await composer.boundingBox();
  expect(typingBox).toBeTruthy();
  expect(Math.abs(typingBox!.width - emptyBox!.width)).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "quiet-composer-typing-light");
  await composer.fill("");
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);

  // Mention chip — a 30 px capsule carrying an 18 px bot avatar.
  const lightChip = await addMentionChip(page, composer);
  const lightChipBox = await lightChip.boundingBox();
  expect(lightChipBox).toBeTruthy();
  expect(lightChipBox!.height).toBeGreaterThanOrEqual(29);
  expect(lightChipBox!.height).toBeLessThanOrEqual(31);
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-mention-chip-light");
  await removeMentionChip(page);

  await setTheme(page, "dark");

  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-composer-empty-dark");

  await composer.fill("Ping the team about the launch");
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-typing-dark");
  await composer.fill("");

  const darkChip = await addMentionChip(page, composer);
  const darkChipBox = await darkChip.boundingBox();
  expect(darkChipBox).toBeTruthy();
  expect(darkChipBox!.height).toBeGreaterThanOrEqual(29);
  expect(darkChipBox!.height).toBeLessThanOrEqual(31);
  await captureScreenshot(page, testInfo, "quiet-composer-mention-chip-dark");
});

/** Pastes a tiny fake PNG into the composer, the same way `composer-paste.spec.ts` does. */
async function pasteImageAttachment(page: Page, name: string) {
  await page.evaluate((fileName) => {
    const target = document.querySelector("textarea[name='chat-message']");
    if (!target) throw new Error("composer textarea not found");
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], fileName, { type: "image/png" });
    const clipboardData = {
      files: [file],
      types: ["Files"],
      items: [{ kind: "file" }],
      getData: () => "",
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    target.dispatchEvent(event);
  }, name);
}

// The composer at rest, and with multi-line text plus one pending
// attachment, in both themes — the capture the PR links as proof of render.
test("composer capsule: rest, then multiline text with an attachment, light and dark", async ({
  page,
}, testInfo) => {
  const composer = await setupGroupComposer(page);

  await captureScreenshot(page, testInfo, "quiet-composer-rest-light");

  await composer.fill(
    "Deux semaines en août, quatre personnes.\nOn garde la réserve de 2 000 € intacte, ça change quoi sur le budget ?\nEt si on décale d'une semaine ?",
  );
  await composer.click();
  await pasteImageAttachment(page, "receipt.png");
  await expect(page.getByRole("button", { name: "Remove receipt.png" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-multiline-attachment-light");

  await setTheme(page, "dark");
  await expect(page.getByRole("button", { name: "Remove receipt.png" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-multiline-attachment-dark");

  await page.getByRole("button", { name: "Remove receipt.png" }).click();
  await composer.fill("");
  await expect(page.getByRole("button", { name: "Remove receipt.png" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-composer-rest-dark");
});

test("dictation: mic opens dictation mode, transcribes, and only inserts on ✓", async ({
  page,
}, testInfo) => {
  await stubSpeechRecognition(page);
  const composer = await setupGroupComposer(page);
  const bar = page.getByTestId("composer-bar");

  await composer.fill("Notes:");
  await bar.getByRole("button", { name: "Dictate" }).click();
  await expect(bar).toHaveAttribute("data-state", "dictating");
  // The mic, Send and Attach are inactive/gone; ✓ and × take over.
  await expect(bar.getByRole("button", { name: "Dictate" })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Attach file" })).toBeDisabled();
  const preview = bar.getByRole("textbox", { name: "Message Quiet composer team" });
  await expect(preview).toContainText("Notes:");
  await captureScreenshot(page, testInfo, "quiet-composer-dictating-light");

  await speak(page, "call the vendor");
  await expect(preview).toContainText("call the vendor");

  // Nothing is sent by dictation itself.
  await expect(page.getByTestId("transcript")).not.toContainText("call the vendor");

  await bar.getByRole("button", { name: "Insert dictation" }).click();
  await expect(bar).toHaveAttribute("data-state", "typing");
  await expect(composer).toHaveValue("Notes: call the vendor");
  await expect(bar.getByRole("button", { name: "Dictate" })).toBeVisible();
  await expect(page.getByTestId("transcript")).not.toContainText("call the vendor");

  await setTheme(page, "dark");
  await composer.fill("Notes:");
  await bar.getByRole("button", { name: "Dictate" }).click();
  await expect(bar).toHaveAttribute("data-state", "dictating");
  await speak(page, "call the vendor");
  await expect(preview).toContainText("call the vendor");
  await captureScreenshot(page, testInfo, "quiet-composer-dictating-dark");
  await bar.getByRole("button", { name: "Cancel dictation" }).click();
});

test("dictation: × restores the draft exactly as it was", async ({ page }) => {
  await stubSpeechRecognition(page);
  const composer = await setupGroupComposer(page);
  const bar = page.getByTestId("composer-bar");

  await composer.fill("keep me");
  await bar.getByRole("button", { name: "Dictate" }).click();
  await speak(page, "discard me");
  await expect(bar.getByRole("textbox", { name: "Message Quiet composer team" })).toContainText(
    "discard me",
  );

  await bar.getByRole("button", { name: "Cancel dictation" }).click();
  await expect(bar).toHaveAttribute("data-state", "typing");
  await expect(composer).toHaveValue("keep me");
});
