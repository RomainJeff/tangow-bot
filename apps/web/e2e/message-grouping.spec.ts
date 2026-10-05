import { expect, type Page, type Route, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type Message = Record<string, unknown>;

/**
 * A user message followed by three consecutive prose messages from the same
 * bot, close enough in time to collapse under one shared header.
 *
 * Rendered in a group (multi-bot) thread: a mono (single-bot) thread never
 * shows a per-message name or avatar any more (D2-a puts the bot's identity
 * in the header instead), so grouping's shared header only shows there — the
 * grouping *spacing* (3px within a group, 14px between groups) still applies
 * in a mono thread, but that has no header to assert on.
 */
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

test("a bot's stacked consecutive messages in a group thread share one header", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `message-grouping-${stamp}@rakazo.test`, "password12", "Message Grouping");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);

  // A single-member group is still a "multi" thread for grouping purposes
  // (`inGroup === true`): its grammar carries a name and avatar per group,
  // unlike a mono thread.
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Solo group",
    botIds: [chiefId],
  });
  await page.goto(`/app/g/${group.id}`);
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  await showGroupedThread(page, chiefId);

  const transcript = page.getByTestId("transcript");
  const g1 = transcript.locator('[data-message-id="g1"]');
  const g2 = transcript.locator('[data-message-id="g2"]');
  const g3 = transcript.locator('[data-message-id="g3"]');
  await expect(g1).toBeVisible({ timeout: 20_000 });
  await expect(g2).toBeVisible();
  await expect(g3).toBeVisible();

  // The first message of the group keeps the shared header: a name, and an
  // avatar reserved at the group's foot (not its own row).
  await expect(g1.locator('[data-slot="message-row-author"]')).toHaveText("Chief");
  await expect(g1.locator('[data-slot="message-row-avatar"] .rakazo-organic-avatar')).toHaveCount(
    0,
  );

  // The second and third messages are continuations: no repeated name.
  await expect(g2.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(g3.locator('[data-slot="message-row-author"]')).toHaveCount(0);

  // Exactly one author header across the whole group of three, and exactly
  // one avatar — at the group's foot (the last message), not its head.
  await expect(
    transcript
      .locator('[data-message-id="g1"], [data-message-id="g2"], [data-message-id="g3"]')
      .locator('[data-slot="message-row-author"]'),
  ).toHaveCount(1);
  await expect(g3.locator('[data-slot="message-row-avatar"] .rakazo-organic-avatar')).toHaveCount(
    1,
  );

  // Every message in the group still reveals its own time on hover, even a
  // continuation with no header of its own.
  const g2Time = g2.getByTestId("message-hover-time");
  await expect(g2Time).toHaveCount(1);
  await g2.hover();
  await expect(g2Time).toBeAttached();

  await setAppearance(page, "light");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "message-grouping-light");

  await setAppearance(page, "dark");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "message-grouping-dark");
});
