import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

type Message = Record<string, unknown>;

/** A thread that shows the whole message grammar at once, with stable content. */
function quietThread(botId: string): Message[] {
  const at = (minute: number) => `2026-09-17T09:${String(minute).padStart(2, "0")}:00.000Z`;
  return [
    {
      id: "quiet-user",
      threadId: "quiet-thread",
      seq: 1,
      role: "user",
      createdAt: at(24),
      blocks: [{ kind: "text", text: "Pull the Q3 numbers.\nBoth regions." }],
    },
    {
      // The server stores an inbound peer receipt with role "user" (it is the
      // recipient's prompt, but still peer activity — see bot-messages.ts) and no
      // botId; it must still render as a centered aside, not a reply from "Bot".
      id: "quiet-peer",
      replyToMessageId: "quiet-user",
      threadId: "quiet-thread",
      seq: 2,
      role: "user",
      createdAt: at(24),
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "quiet-research",
          fromBotName: "Research",
          text: "here are the Q3 numbers",
        },
      ],
    },
    {
      id: "quiet-handoff",
      threadId: "quiet-thread",
      seq: 3,
      role: "bot",
      botId,
      createdAt: at(25),
      blocks: [
        {
          kind: "handoff",
          fromBotId: botId,
          toBotId: "quiet-research",
          text: "the Q3 sheet",
        },
      ],
    },
    {
      id: "quiet-reply",
      threadId: "quiet-thread",
      seq: 4,
      role: "bot",
      botId,
      createdAt: at(26),
      blocks: [
        {
          kind: "steps",
          durationMs: 124_000,
          steps: [
            { label: "Searched the drive", count: 1 },
            { label: "Read the Q3 sheet", count: 1 },
          ],
        },
        {
          kind: "text",
          text: [
            "Revenue is up in both regions.",
            "",
            "| Region | Revenue |",
            "| --- | ---: |",
            "| EU | 1,240 |",
            "| US | 2,310 |",
          ].join("\n"),
        },
      ],
    },
    {
      id: "quiet-note",
      threadId: "quiet-thread",
      seq: 5,
      role: "bot",
      botId,
      createdAt: at(27),
      blocks: [
        { kind: "text", text: "I stopped there." },
        { kind: "meta", text: "Run stopped by you" },
      ],
    },
  ];
}

/** Both hydrate RPCs carry the transcript; one handler avoids racing globs. */
const HYDRATE_RPC = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;

async function showQuietThread(page: Page, botId: string) {
  const messages = quietThread(botId);
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

test("the thread reads as names, prose and asides", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `quiet-messages-${stamp}@rakazo.test`, "password12", "Quiet Messages");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);

  // Reasoning only renders when the person asked to see agent steps.
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("display-agent-steps").click();
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await showQuietThread(page, botId);

  const transcript = page.getByTestId("transcript");
  const reply = transcript.locator('[data-message-id="quiet-reply"]');
  await expect(reply).toBeVisible({ timeout: 20_000 });

  // Mono (single-bot) thread: a bot message carries no per-message name or
  // avatar any more — the bot's identity lives in the header (D2-a) — but its
  // prose is now a `muted` bubble, revealing its time on hover instead of a
  // permanent clock.
  const row = reply.locator('[data-slot="message-row"]');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  const prose = reply.getByTestId("message-bot-bubble");
  await expect(prose).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(reply.getByTestId("message-hover-time")).toHaveCount(1);
  // Figures line up in a markdown table, and the `---:` column reads from the end.
  const revenue = prose.locator("td").nth(1);
  await expect(revenue).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(revenue).toHaveCSS("text-align", "end");
  await expect(prose.locator("td").first()).toHaveCSS("text-align", "start");

  // The reply is set in the Quiet mono family wherever it shows figures.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
    ),
  ).toContain("Geist Mono");

  // What the person said keeps its bubble and its line breaks.
  const userBubble = transcript.getByTestId("message-user-bubble");
  await expect(userBubble).toHaveCSS("white-space", "pre-wrap");
  await expect(userBubble).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const transcriptBox = await transcript.boundingBox();
  expect(transcriptBox).not.toBeNull();
  const expectCentered = async (aside: Locator) => {
    const box = await aside.boundingBox();
    expect(box).not.toBeNull();
    expect(
      Math.abs(box!.x + box!.width / 2 - (transcriptBox!.x + transcriptBox!.width / 2)),
    ).toBeLessThanOrEqual(2);
  };

  // A message a bot received from a peer is an aside between messages, not a
  // reply from "Bot" — even though the server stores it with role "user".
  const chip = transcript.getByTestId("peer-receipt-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAccessibleName(/Message from Research/);
  await expect(chip.locator('[data-slot="stacked-avatars"]')).toHaveAttribute("data-size", "17");
  await expectCentered(chip);
  const peerRow = transcript.locator('[data-message-id="quiet-peer"]');
  await expect(peerRow.locator('[data-slot="message-row"]')).toHaveCount(0);
  await expect(peerRow.getByTestId("message-hover-actions")).toHaveCount(0);
  await expect(peerRow.getByTestId("reply-parent-preview")).toHaveCount(0);
  await expect(peerRow.getByTestId("message-hover-rail")).toHaveCount(0);

  // So is a handoff, and neither carries message actions or a clock.
  const handoff = transcript.locator('[data-message-id="quiet-handoff"]');
  await expect(handoff.locator('[data-slot="interstitial"]')).toContainText("the Q3 sheet");
  await expect(handoff.getByTestId("message-hover-rail")).toHaveCount(0);
  await expect(handoff.getByTestId("message-hover-time")).toHaveCount(0);
  await expectCentered(handoff.locator('[data-slot="interstitial"]'));

  // A message that says something and adds a note is still a normal row —
  // mono carries no per-message author any more, but its text is a bubble.
  const note = transcript.locator('[data-message-id="quiet-note"]');
  await expect(note.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(note).toContainText("I stopped there.");
  await expect(note).toContainText("Run stopped by you");

  // Reasoning folds under one line, and opens onto the steps it took.
  const toggle = reply.getByTestId("agent-steps-toggle");
  await expect(toggle).toHaveText("Thought for 2m 04s · 2 steps");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(reply.getByRole("button", { name: "Read the Q3 sheet" })).toBeVisible();

  await setAppearance(page, "light");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "quiet-messages-light");

  await setAppearance(page, "dark");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "quiet-messages-dark");
});
