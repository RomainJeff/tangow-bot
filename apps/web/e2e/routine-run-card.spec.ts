import { expect, type Page, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

type ThreadBlock = { kind: string; botId?: string; state?: string };

async function threadBlocks(page: Page, botId: string): Promise<ThreadBlock[]> {
  const history = await rpc<{ messages: Array<{ blocks: ThreadBlock[] }> }>(
    page,
    "threads/messages",
    { botId },
  );
  return history.messages.flatMap((message) => message.blocks);
}

// A scheduled routine only renders as a run card for a sub-bot (parentBotId set, see
// packages/adapters/src/executor.ts `showsRoutineRunCard`); a top-level bot's scheduled routine
// stays a normal message. spawn_bot is the only way to create a parented bot, so this spec asks
// the bot to spawn one, approves its card, then creates and runs a routine on it directly via RPC.
test("renders a routine run card in a sub-bot's own thread", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-run-card-${stamp}@rakazo.test`, "password12", "Routine Run Card");
  await completeOnboarding(page);
  const orchestratorId = activeBotId(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("Spawn a bot named Aide whose only job is quick status checks.");
  await page.keyboard.press("Enter");

  // A bot never creates a bot on its own: the approval card comes first.
  await page.getByRole("button", { name: "Create bot", exact: true }).click({ timeout: 30_000 });
  await expect(page.getByText("Created", { exact: true })).toBeVisible();

  let subBotId: string | undefined;
  await expect
    .poll(
      async () => {
        const block = (await threadBlocks(page, orchestratorId)).find(
          (candidate) => candidate.kind === "child_bot",
        );
        subBotId = block?.botId;
        return subBotId;
      },
      { timeout: 60_000 },
    )
    .not.toBeUndefined();
  if (!subBotId) throw new Error("spawn_bot did not create a sub-bot");

  const routine = await rpc<Routine>(page, "routines/create", {
    botId: subBotId,
    name: "Status check",
    prompt:
      "Reply with a short status digest formatted as markdown: a **bolded** one-word verdict, " +
      "then a bullet list of two short items. No preamble, no images.",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
  });
  await rpc(page, "routines/testRun", { routineId: routine.id });

  await page.goto(`/app/${subBotId}`);
  const card = page.getByTestId("routine-run-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Status check");
  await expect(card).toContainText(/Running|Completed/i);
  await expect(card).toContainText("Completed", { timeout: 60_000 });

  // The "Subscribed" pill is gone (CA-R3, CA-R1); a bell with an accessible name replaces it.
  await expect(card).not.toContainText("Subscribed");
  await expect(card.getByRole("img", { name: /Notifications on/i })).toBeVisible();

  // notify:true defaults the card open (CA13) — the digest toggle starts expanded, rendering
  // the routine's digest as sanitised markdown (CA-R4) with no live image loads (CA-R5).
  const collapseButton = card.getByRole("button", { name: "Hide details" });
  await expect(collapseButton).toBeVisible();
  await expect(card.locator("strong")).toBeVisible();
  await expect(card.locator("img")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "routine-run-card");

  await collapseButton.click();
  await expect(card.getByRole("button", { name: "Show details" })).toBeVisible();

  await expect
    .poll(
      async () =>
        (await threadBlocks(page, subBotId!)).some(
          (block) => block.kind === "routine_run" && block.state === "completed",
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
});

// An inbound wake reports through a run card on every bot: the routine's instructions and the
// payload stay in the run, not in a user bubble on the main thread.
test("renders a webhook-woken routine as a run card, not a user message", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `webhook-run-card-${stamp}@rakazo.test`, "password12", "Webhook Run Card");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Deploy watch",
    prompt: "Reply with a one-line status digest of the delivery. No preamble, no images.",
    active: true,
    notify: true,
    webhookEnabled: true,
    requireToolApproval: false,
  });
  const { secret, path } = await rpc<{ secret: string; path: string }>(
    page,
    "bots/rotateWebhookSecret",
    { botId },
  );
  const delivered = await page.request.post(path, {
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": `deploy-${stamp}` },
    data: { event: "deploy.finished", service: "checkout" },
  });
  expect(delivered.ok()).toBe(true);

  const card = page.getByTestId("routine-run-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Deploy watch");
  await expect(card).toContainText("Completed", { timeout: 60_000 });
  await expect(page.getByText(/Run routine "Deploy watch"/)).toHaveCount(0);
  await expect(page.getByText("deploy.finished")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "webhook-routine-run-card");

  const history = await rpc<{ messages: Array<{ role: string; blocks: unknown[] }> }>(
    page,
    "threads/messages",
    { botId },
  );
  expect(
    history.messages.some(
      (message) => message.role === "user" && JSON.stringify(message.blocks).includes("deploy."),
    ),
  ).toBe(false);
});
