import { expect, type Page, type Route, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

type Message = Record<string, unknown>;

/** A user message followed by three consecutive prose messages from the same bot,
 * close enough in time to collapse under one shared header. */
function groupedThread(botId: string): Message[] {
  const at = (minute: number) => `2026-09-17T09:${String(minute).padStart(2, "0")}:00.000Z`;
  return [
    {
      id: "mg-user",
      threadId: "mg-thread",
      seq: 1,
      role: "user",
      createdAt: at(23),
      blocks: [{ kind: "text", text: "Where does the RAS note come from?" }],
    },
    {
      id: "g1",
      threadId: "mg-thread",
      seq: 2,
      role: "bot",
      botId,
      createdAt: at(24),
      blocks: [{ kind: "text", text: "Looking at where that RAS note comes from." }],
    },
    {
      id: "g2",
      threadId: "mg-thread",
      seq: 3,
      role: "bot",
      botId,
      createdAt: at(25),
      blocks: [{ kind: "text", text: "It is the evening routine: personal plus family over 48h." }],
    },
    {
      id: "g3",
      threadId: "mg-thread",
      seq: 4,
      role: "bot",
      botId,
      createdAt: at(26),
      blocks: [{ kind: "text", text: "It comes from the daily-conflict-watch routine." }],
    },
  ];
}

/** Both hydrate RPCs carry the transcript; one handler avoids racing globs. */
const HYDRATE_RPC = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;

async function showGroupedThread(page: Page, botId: string) {
  const messages = groupedThread(botId);
  await page.route(HYDRATE_RPC, async (route: Route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as {
        json?: {
          messages?: Message[];
          olderCursor?: number | null;
          thread?: { messages?: Message[]; olderCursor?: number | null };
        };
      };
      if (body.json?.messages) {
        body.json.messages = messages;
        body.json.olderCursor = null;
      }
      if (body.json?.thread?.messages) {
        body.json.thread.messages = messages;
        body.json.thread.olderCursor = null;
      }
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (/already handled|Target closed|Request context disposed/i.test(String(error))) return;
      throw error;
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function setAppearance(page: Page, theme: "light" | "dark") {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId(`ui-appearance-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

test("a bot's stacked consecutive messages share one header", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `message-grouping-${stamp}@rakazo.test`, "password12", "Message Grouping");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);

  await showGroupedThread(page, botId);

  const transcript = page.getByTestId("transcript");
  const g1 = transcript.locator('[data-message-id="g1"]');
  const g2 = transcript.locator('[data-message-id="g2"]');
  const g3 = transcript.locator('[data-message-id="g3"]');
  await expect(g1).toBeVisible({ timeout: 20_000 });
  await expect(g2).toBeVisible();
  await expect(g3).toBeVisible();

  // The first message of the group keeps its full header: name and time.
  const g1Row = g1.locator('[data-slot="message-row"]');
  await expect(g1Row).not.toHaveAttribute("data-continued", "true");
  await expect(g1.locator('[data-slot="message-row-author"]')).toHaveText("Chief");
  await expect(g1.locator('[data-slot="message-row-time"] time')).toHaveText(/\d/);

  // The second and third messages are continuations: no repeated header, just content.
  const g2Row = g2.locator('[data-slot="message-row"]');
  const g3Row = g3.locator('[data-slot="message-row"]');
  await expect(g2Row).toHaveAttribute("data-continued", "true");
  await expect(g3Row).toHaveAttribute("data-continued", "true");
  await expect(g2.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(g3.locator('[data-slot="message-row-author"]')).toHaveCount(0);

  // Exactly one author header across the whole group of three.
  await expect(
    transcript
      .locator('[data-message-id="g1"], [data-message-id="g2"], [data-message-id="g3"]')
      .locator('[data-slot="message-row-author"]'),
  ).toHaveCount(1);

  // A continuation still carries its own time, revealed on hover in the avatar gutter.
  const g2Time = g2.locator('[data-slot="message-row-time"]');
  await expect(g2Time).toHaveCount(1);
  await g2Row.hover();
  await expect(g2Time).toBeAttached();

  await setAppearance(page, "light");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "message-grouping-light");

  await setAppearance(page, "dark");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "message-grouping-dark");
});
