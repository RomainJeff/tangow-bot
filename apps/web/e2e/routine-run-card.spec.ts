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

// The routine-run card only renders for a sub-bot's own routine (parentBotId set, see
// packages/adapters/src/executor.ts `isSubBotRoutineRun`); a top-level bot's routine stays a
// normal message. spawn_bot is the only way to create a parented bot, so this spec asks the
// real model to spawn one before creating and running a routine on it directly via RPC.
test("renders a routine run card in a sub-bot's own thread", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-run-card-${stamp}@rakazo.test`, "password12", "Routine Run Card");
  await completeOnboarding(page);
  const orchestratorId = activeBotId(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(
    "Use spawn_bot to create a team bot named Aide whose only job is quick status checks.",
  );
  await page.keyboard.press("Enter");

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
