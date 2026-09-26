import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/** Submit from the Send control so an in-flight prior send cannot swallow Enter. */
async function sendComposerMessage(page: Page, composer: Locator, text: string) {
  await composer.fill(text);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(composer).toHaveValue("");
}

/** Hover the row and wait for its floating pill to reveal, then park focus on More for stable screenshots. */
async function revealHoverPill(row: Locator): Promise<Locator> {
  const pill = row.getByTestId("message-hover-rail");
  await expect
    .poll(async () => {
      await row.hover();
      return pill.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      });
    })
    .toEqual({ opacity: "1", pointerEvents: "auto" });
  // Incoming replies can move the row away from the pointer; keep real focus for screenshots.
  await pill.getByRole("button", { name: "More" }).focus();
  return pill;
}

/** Park the pointer outside the message and blur focus so the pill returns to opacity-0. */
async function expectPillAtRest(page: Page, row: Locator) {
  const pill = row.getByTestId("message-hover-rail");
  const box = await row.boundingBox();
  if (box) {
    // (0,0) can still sit on the first transcript row; leave below the row instead.
    await page.mouse.move(Math.max(0, box.x) + 8, box.y + box.height + 32);
  }
  // More keeps focus after Escape; blur so focus-within does not leave the pill visible.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await expect(pill).toHaveCSS("opacity", "0");
  await expect(pill).toHaveCSS("pointer-events", "none");
  // Only a user bubble carries a hover time; a bot row states it beside the name.
  const hoverTime = row.getByTestId("message-hover-time");
  if ((await hoverTime.count()) > 0) await expect(hoverTime).toHaveCSS("opacity", "0");
}

/** The pill floats at the row's own top-end corner, inside the row's bounds. */
async function expectPillAtTopEnd(pill: Locator, row: Locator) {
  await expect
    .poll(async () => {
      const pillBox = await pill.boundingBox();
      const rowBox = await row.boundingBox();
      if (!pillBox || !rowBox) return null;
      return {
        // "end" edge: within a few px of the row's own end edge, never past it.
        nearEndEdge: Math.abs(pillBox.x + pillBox.width - (rowBox.x + rowBox.width)) < 20,
        withinRowWidth: pillBox.x + pillBox.width <= rowBox.x + rowBox.width + 1,
        // "top": at or just above the row's own top edge, never near its middle or end.
        nearTop: pillBox.y <= rowBox.y + 4,
      };
    })
    .toEqual({ nearEndEdge: true, withinRowWidth: true, nearTop: true });
}

test("message hover shows a floating action pill; reply links to parent", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hover-actions-${stamp}@rakazo.test`, "password12", "Hover Actions");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const transcript = page.getByTestId("transcript");

  // Empty start: no Fresh-start greeting. Answer the focus card so a plain
  // bot text bubble exists for hover layout checks.
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  const botText = page.getByText(/Got it\./);
  await expect(botText).toBeVisible({ timeout: 20_000 });
  const botRow = transcript.locator(`[data-message-id]`).filter({ has: botText }).first();
  await expect(botRow).toBeVisible();
  await expectPillAtRest(page, botRow);
  await captureScreenshot(page, testInfo, "message-actions-rest-desktop");

  const botPill = await revealHoverPill(botRow);
  const botToolbar = botRow.getByTestId("message-hover-actions");
  // A bot row states its time beside the author, so it needs no hover clock.
  await expect(botRow.getByTestId("message-hover-time")).toHaveCount(0);
  await expect(botRow.locator('[data-slot="message-row-time"]')).toHaveText(/\d/);

  // Reply/Copy stay direct actions; Remember belongs in More.
  await expect(botToolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(botToolbar.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(botToolbar.getByRole("button", { name: "More" })).toBeVisible();
  await botToolbar.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menuitem", { name: "Remember", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // Voice is not configured in this test, so the pill carries no Speak button.
  await expect(botToolbar.getByRole("button", { name: "Speak this reply" })).toHaveCount(0);
  await expectPillAtTopEnd(botPill, botRow);
  await captureScreenshot(page, testInfo, "message-bot-actions-desktop");
  await expectPillAtRest(page, botRow);

  const parentText = `hover-parent-${stamp}`;
  const replyText = `hover-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await sendComposerMessage(page, composer, parentText);

  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  // Your own message is a bare right-aligned bubble: it never wears the bot
  // avatar-and-name row header (a regression once labelled it "Bot").
  await expect(parentRow.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(parentRow.locator('[data-slot="message-row-avatar"]')).toHaveCount(0);

  const pill = await revealHoverPill(parentRow);
  const toolbar = parentRow.getByTestId("message-hover-actions");
  await expect(toolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Copy" })).toBeVisible();
  // Edit and resend remains in More alongside Remember.
  await expect(toolbar.getByRole("button", { name: "More" })).toBeVisible();
  await toolbar.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit and resend" })).toBeVisible();
  // Reply/Copy already sit in the pill on a fine pointer, so More does not repeat them.
  await expect(page.getByRole("menuitem", { name: "Reply" })).toBeHidden();
  await expect(page.getByRole("menuitem", { name: "Copy" })).toBeHidden();
  await page.keyboard.press("Escape");
  const react = toolbar.getByRole("button", { name: "React" });
  await expect(react).toBeVisible();
  // Default reaction matches Reply/More: muted control color, not yellow.
  await expect
    .poll(async () => {
      const mutedColor = await toolbar
        .getByRole("button", { name: "More" })
        .evaluate((el) => getComputedStyle(el).color);
      const reactionColor = await react.evaluate((el) => getComputedStyle(el).color);
      return reactionColor === mutedColor;
    })
    .toBe(true);

  await expectPillAtTopEnd(pill, parentRow);

  // Bot prose now runs the column's width — nothing narrows it to hug the pill.
  const frame = parentRow.getByTestId("message-bubble-frame");
  const botFrame = botRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const frameBox = await botFrame.boundingBox();
      const transcriptBox = await transcript.boundingBox();
      if (!frameBox || !transcriptBox) return null;
      return transcriptBox.width - frameBox.width;
    })
    .toBeLessThan(4);

  // User bubble is a muted elevated surface (not cream invert / bright pill),
  // and keeps its own 78% cap regardless of message length.
  const userSurface = parentRow.getByTestId("message-user-bubble");
  await expect(userSurface).toBeVisible();
  await expect
    .poll(async () => userSurface.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toMatch(/^rgb\(241,\s*241,\s*239\)$/); // not cream primary foreground

  // Long user bubble: the bubble itself still caps near 78%, and the pill
  // still sits at the row's own top-end corner, not stretched with content.
  const longText = `hover-long-${stamp}-${"x".repeat(220)}`;
  await sendComposerMessage(page, composer, longText);
  const longRow = transcript
    .locator(`[data-message-id]`)
    .filter({ hasText: longText.slice(0, 40) })
    .first();
  await expect(longRow).toBeVisible({ timeout: 20_000 });
  const longPill = await revealHoverPill(longRow);
  await expectPillAtTopEnd(longPill, longRow);
  const longBubble = longRow.getByTestId("message-user-bubble");
  await expect
    .poll(async () => {
      const bubbleBox = await longBubble.boundingBox();
      const transcriptBox = await transcript.boundingBox();
      if (!bubbleBox || !transcriptBox) return null;
      return bubbleBox.width / transcriptBox.width;
    })
    .toBeLessThan(0.8);

  // Time appears at the opposite row edge on hover, outside the pill.
  await revealHoverPill(parentRow);
  const rowTime = parentRow.getByTestId("message-hover-time");
  await expect(rowTime).toHaveCSS("opacity", "1");
  await expect(rowTime).toHaveText(/\d/);
  const timeBox = await rowTime.boundingBox();
  const rowBox = await parentRow.boundingBox();
  expect(timeBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(Math.abs(timeBox!.x - rowBox!.x)).toBeLessThan(2);
  await toolbar.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menu").locator("time")).toHaveCount(0);
  // Escape closes More and restores focus to the trigger so the pill stays up.
  await page.keyboard.press("Escape");
  await expect(toolbar.getByRole("button", { name: "More" })).toBeFocused();
  await captureScreenshot(page, testInfo, "message-user-actions-hover-desktop");
  // Default transcript shot: pill at rest (no hover pin, mouse clear).
  await expectPillAtRest(page, parentRow);
  await captureScreenshot(page, testInfo, "message-user-bubble-desktop");

  // Clip shot of bubble + pill for gallery geometry.
  await revealHoverPill(parentRow);
  const pillBox = await pill.boundingBox();
  const frameBox = await frame.boundingBox();
  if (!pillBox || !frameBox) throw new Error("missing hover pill geometry");
  const pad = 16;
  const top = Math.min(pillBox.y, frameBox.y);
  const clip = {
    x: Math.max(0, Math.min(pillBox.x, frameBox.x) - pad),
    y: Math.max(0, top - pad),
    width:
      Math.max(pillBox.x + pillBox.width, frameBox.x + frameBox.width) -
      Math.min(pillBox.x, frameBox.x) +
      pad * 2,
    height: Math.max(pillBox.y + pillBox.height, frameBox.y + frameBox.height) - top + pad * 2,
  };
  const hoverPath = testInfo.outputPath("message-hover-toolbar.png");
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    clip,
    path: hoverPath,
  });
  await testInfo.attach("message-hover-toolbar", { contentType: "image/png", path: hoverPath });

  await react.click();
  for (const emoji of ["👍", "👎", "❤️", "😂", "🎉", "😮"]) {
    await expect(page.getByRole("button", { name: emoji, exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "message-reaction-picker");
  await page.getByRole("button", { name: "❤️", exact: true }).click();
  await expect(parentRow.getByTestId("message-reactions")).toHaveText("❤️");
  await parentRow.hover();
  await react.click();
  await page.getByRole("button", { name: "👍", exact: true }).click();
  await expect(parentRow.getByTestId("message-reactions")).toContainText("👍");
  await parentRow.hover();
  await react.click();
  await page.getByRole("button", { name: "❤️", exact: true }).click();
  await expect(parentRow.getByTestId("message-reactions")).toContainText("❤️ 2");
  await captureScreenshot(page, testInfo, "message-multiple-reactions");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(parentRow.getByTestId("message-reactions")).toContainText("❤️ 2");
  await expect(parentRow.getByTestId("message-reactions")).toContainText("👍");

  await parentRow.hover();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await toolbar.getByRole("button", { name: "Copy" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(parentText);

  await parentRow.hover();
  await toolbar.getByRole("button", { name: "Reply" }).click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(/Replying to/);

  await sendComposerMessage(page, composer, replyText);
  await expect(replyChip).toHaveCount(0);

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText(parentText);
  await captureScreenshot(page, testInfo, "message-reply-thread");

  await parentPreview.click();
  await expect(parentRow).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  await botRow.scrollIntoViewIfNeeded();
  await revealHoverPill(botRow);
  await captureScreenshot(page, testInfo, "message-bot-actions-mobile");
  await parentRow.scrollIntoViewIfNeeded();
  await revealHoverPill(parentRow);
  await captureScreenshot(page, testInfo, "message-user-actions-mobile");
});

test("reply preview jumps to parent outside the loaded page", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `hover-page-${stamp}@rakazo.test`, "password12", "Hover Page");
  await completeOnboarding(page);

  const parentText = `page-parent-${stamp}`;
  const replyText = `page-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await sendComposerMessage(page, composer, parentText);

  const transcript = page.getByTestId("transcript");
  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  const parentId = await parentRow.getAttribute("data-message-id");
  expect(parentId).toBeTruthy();

  await parentRow.hover();
  await parentRow.getByRole("button", { name: "Reply" }).click();
  await sendComposerMessage(page, composer, replyText);

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  await expect(replyRow.getByTestId("reply-parent-preview")).toContainText(parentText);

  // Simulate a paginated snapshot where the parent is older than the loaded page.
  // Bootstrap and threads/get both hydrate the transcript on reload.
  const stripParent = (body: {
    json?: {
      messages?: Array<{ id: string }>;
      olderCursor?: number | null;
      thread?: { messages?: Array<{ id: string }>; olderCursor?: number | null };
    };
  }) => {
    if (body.json?.messages) {
      body.json.messages = body.json.messages.filter((message) => message.id !== parentId);
      body.json.olderCursor = body.json.olderCursor ?? 1;
    }
    if (body.json?.thread?.messages) {
      body.json.thread.messages = body.json.thread.messages.filter(
        (message) => message.id !== parentId,
      );
      body.json.thread.olderCursor = body.json.thread.olderCursor ?? 1;
    }
  };

  // One handler for both hydrate RPCs avoids overlapping globs racing on reload
  // (Playwright "Route is already handled" when fulfill runs twice).
  const hydrateRpc = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;
  const stripHydrate = async (route: Route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Parameters<typeof stripParent>[0];
      stripParent(body);
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Reload can cancel an in-flight intercepted request after fetch returns.
      if (/already handled|Target closed|Request context disposed/i.test(String(error))) return;
      throw error;
    }
  };
  await page.route(hydrateRpc, stripHydrate);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toHaveCount(0);
  const offlinePreview = page
    .locator(`[data-message-id]`)
    .filter({ hasText: replyText })
    .getByTestId("reply-parent-preview");
  await expect(offlinePreview).toBeVisible();
  await expect(offlinePreview).toHaveText("Earlier message");

  await page.unroute(hydrateRpc, stripHydrate);
  await offlinePreview.click();
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toContainText(parentText);
});

test.describe("touch message actions", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the pill needs no hover to be reachable", async ({ page }, testInfo) => {
    await signup(page, `touch-actions-${Date.now()}@rakazo.test`, "password12", "Touch Actions");
    await completeOnboarding(page);
    expect(
      await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
    ).toBe(false);
    await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /Day-to-day work/ }).click();
    const botText = page.getByText(/Got it\./);
    await expect(botText).toBeVisible({ timeout: 20_000 });
    const row = page
      .getByTestId("transcript")
      .locator("[data-message-id]")
      .filter({ has: botText })
      .first();
    // A touch pointer has no hover to reveal the pill with, so it stays put —
    // but stays down to React and More, not six permanent buttons.
    const pill = row.getByTestId("message-hover-rail");
    await expect(pill).toHaveCSS("opacity", "1");
    await expect(pill).toHaveCSS("pointer-events", "auto");
    await expect(pill.getByRole("button", { name: "Reply", exact: true })).toBeHidden();
    await expect(pill.getByRole("button", { name: "Copy", exact: true })).toBeHidden();
    await expect(pill.getByRole("button", { name: "React", exact: true })).toBeVisible();
    await expect(pill.getByRole("button", { name: "More", exact: true })).toBeVisible();
    await pill.getByRole("button", { name: "React", exact: true }).tap();
    await expect(page.getByRole("button", { name: "🎉", exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "message-reaction-picker-touch");
    await page.getByRole("button", { name: "🎉", exact: true }).tap();
    await expect(row.getByTestId("message-reactions")).toHaveText("🎉");
    await pill.getByRole("button", { name: "React", exact: true }).tap();
    await page.getByRole("button", { name: "🎉", exact: true }).tap();
    await expect(row.getByTestId("message-reactions")).toHaveText("🎉 2");
    // Reply is not a pill icon on a coarse pointer; More is the only way to it.
    await pill.getByRole("button", { name: "More" }).tap();
    await expect(page.getByRole("menuitem", { name: "Reply" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await captureScreenshot(page, testInfo, "message-actions-touch-menu");
    await page.getByRole("menuitem", { name: "Reply", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Cancel reply" })).toBeVisible();
  });
});
