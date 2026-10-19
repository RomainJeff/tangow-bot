import { randomUUID } from "node:crypto";
import type { MemoryLibraryDocument } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotTab,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./test";

test("memory V01–V03: remember a message and reopen it from the agent library", async ({
  page,
}, testInfo) => {
  await signup(page, `memory-capture-${randomUUID()}@rakazo.test`, "password12", "Capture Fixture");
  await completeOnboarding(page);
  const sourceBotId = activeBotId(page);
  const source = "Use a seven-day invitation window for this experiment.";
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(source);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const row = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: source })
    .first();
  await expect(row).toBeVisible();
  const messageId = await row.getAttribute("data-message-id");
  await row.hover();
  const remember = row.getByRole("button", { name: "Remember", exact: true });
  await expect(remember).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-M01-capture-action");
  await remember.click();
  const detail = page.getByTestId("memory-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(source);
  await expect(detail.getByTestId("memory-location")).toContainText("Personal · Bot · Chief");
  await detail.locator("summary", { hasText: "Details" }).click();
  await expect(detail.locator("blockquote")).toHaveText(source);
  await page.reload();
  await expect(detail).toContainText(source);
  const memoryId = new URL(page.url()).searchParams.get("memory");
  const document = await rpc<MemoryLibraryDocument>(page, "memory/library/get", {
    documentId: memoryId,
  });
  expect(document.collection.kind).toBe("agent");
  expect(document.evidence).toContainEqual(
    expect.objectContaining({ sourceReferenceId: messageId, status: "verified", excerpt: source }),
  );
  await detail.getByRole("button", { name: "Close memory", exact: true }).click();
  await expect(page.getByTestId("memory-list")).toContainText(source);
  await captureScreenshot(page, testInfo, "memory-M03-agent-library");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/${sourceBotId}$`));
  await expect(detail).toHaveCount(0);
});

test("memory detail renders Markdown and history", async ({ page }, testInfo) => {
  await signup(page, `memory-reader-${randomUUID()}@rakazo.test`, "password12", "Reader Fixture");
  await completeOnboarding(page);
  const document = await rpc<MemoryLibraryDocument>(page, "memory/library/create", {
    collection: "personal",
    title: "Reading fixture",
    content: "## Reusable protocol\n\nPrepare **open questions**.",
    idempotencyKey: randomUUID(),
  });
  await page.goto(`/app/memory?collection=personal&status=proposed&memory=${document.id}`);
  const detail = page.getByTestId("memory-detail");
  await expect(detail.getByRole("heading", { name: "Reading fixture" })).toBeVisible();
  await expect(detail.locator("strong")).toHaveText("open questions");
  await detail.locator("summary", { hasText: "Details" }).click();
  await detail.getByRole("button", { name: "History", exact: true }).click();
  await expect(detail.locator("summary", { hasText: "rev 1" })).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-read-only");
});

test("memory skill is enabled per bot from Knowledge", async ({ page }, testInfo) => {
  await signup(page, `memory-skill-${randomUUID()}@rakazo.test`, "password12", "Skill Fixture");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const knowledge = await openBotTab(page, "Knowledge");
  const toggle = knowledge
    .getByTestId("bot-skills")
    .getByRole("switch", { name: "memory-management", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => {
      const entries = await rpc<Array<{ id: string; visibleBotIds: string[] }>>(
        page,
        "agentSkills/list",
        {},
      );
      return entries.find((entry) => entry.id === "builtin:memory-management")?.visibleBotIds;
    })
    .toEqual([botId]);
  await captureScreenshot(page, testInfo, "memory-skill-assigned");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});
