import { randomUUID } from "node:crypto";
import type { MemoryLibraryDocument } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import type { Page } from "./test";
import { expect, test } from "./test";

test.use({ actionTimeout: 10_000 });

async function setup(page: Page, collection: "personal" | "agent" = "personal") {
  await signup(
    page,
    `memory-navigation-${randomUUID()}@rakazo.test`,
    "password12",
    "Navigation Fixture",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const document = await rpc<MemoryLibraryDocument>(page, "memory/library/create", {
    collection,
    ...(collection === "agent" ? { botId } : {}),
    title: "Navigation protocol",
    content: "Prepare open questions before an interview.",
    idempotencyKey: randomUUID(),
  });
  return { botId, document, conversation: page.url() };
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`memory back leaves the library after closing a detail (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const { conversation } = await setup(page);
    const openNavigation = page.getByRole("button", { name: "Open navigation", exact: true });
    if (await openNavigation.isVisible()) await openNavigation.click();
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    const detail = page.getByTestId("memory-detail");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByRole("button", { name: "Navigation protocol", exact: true }).click();
      await expect(detail).toBeVisible();
      await detail.getByRole("button", { name: "Close memory", exact: true }).click();
      await expect(detail).toHaveCount(0);
    }
    await captureScreenshot(page, testInfo, `memory-back-list-${viewport.name}`);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(conversation, { timeout: 3_000 });
    await expect(page.getByTestId("memory-library")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible();
  });
}

test("memory browser back and forward preserve the list; closing after reload returns to the conversation", async ({
  page,
}) => {
  const { conversation } = await setup(page, "agent");
  await page.getByTestId("open-settings-panel").click();
  await page.getByTestId("bot-settings").getByText("Advanced", { exact: true }).click();
  await page
    .getByTestId("bot-knowledge")
    .getByRole("button", { name: "Open memory", exact: true })
    .click();
  await page.getByRole("button", { name: "Proposals", exact: true }).click();
  await expect(page).toHaveURL(/status=proposed/);
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page).toHaveURL(/status=active/);
  await page.getByRole("textbox", { name: "Search memories", exact: true }).fill("interview");
  await expect(page).toHaveURL(/q=interview/);
  const listUrl = page.url();
  await page.getByRole("button", { name: "Navigation protocol", exact: true }).click();
  await expect(page.getByTestId("memory-detail")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByTestId("memory-detail")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByTestId("memory-detail")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Close memory", exact: true }).click();
  await expect(page).toHaveURL(listUrl);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(conversation, { timeout: 3_000 });
});

test("memory opened by a direct link can return to the app without prior history", async ({
  page,
}) => {
  const { botId, document } = await setup(page);
  const linked = await page.context().newPage();
  try {
    await linked.goto(`/app/memory?collection=personal&status=active&memory=${document.id}`);
    await linked.getByRole("button", { name: "Close memory", exact: true }).click();
    await expect(linked.getByTestId("memory-list")).toContainText("Navigation protocol");
    await linked.getByRole("button", { name: "Back", exact: true }).click();
    await expect(linked).toHaveURL(new RegExp(`/app/${botId}$`), { timeout: 3_000 });
  } finally {
    await linked.close();
  }
});

test("memory filters do not add browser history or overwrite the next selection", async ({
  page,
}) => {
  const { conversation } = await setup(page);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: "Shared", exact: true }).click();
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await page.getByRole("button", { name: "Proposals", exact: true }).click();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await page.getByRole("textbox", { name: "Search memories", exact: true }).fill("interview");
  await expect(page.getByRole("button", { name: "Personal", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Active", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("memory-list")).toContainText("Navigation protocol");
  const listUrl = page.url();
  await page.goBack();
  await expect(page).toHaveURL(conversation);
  await page.goForward();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole("textbox", { name: "Search memories", exact: true })).toHaveValue(
    "interview",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(conversation);
});
