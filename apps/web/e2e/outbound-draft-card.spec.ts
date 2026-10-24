import type { Request, Route } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, type Page, type TestInfo, test } from "./test";
import { at, type EntryDraft, runStarted, showThread } from "./thread-log";

const RUN = "draft-run";
const EFFECT = "draft-effect";
const BODY =
  "Hi Bo,\n\nWednesday won't work for me after all. Could we do Thursday instead?\n\nAna";
const EDITED = `${BODY.replace("instead?", "instead? Tell me if 8pm is OK.")}`;
// An invented app logo, inline so the spec never fetches one.
const LOGO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#3b6fd8"/><path d="M4 6h12v8H4z" fill="none" stroke="#fff" stroke-width="1.5"/><path d="m4 6 6 5 6-5" fill="none" stroke="#fff" stroke-width="1.5"/></svg>',
)}`;

function card(overrides: Record<string, unknown> = {}, draft: Record<string, unknown> = {}) {
  return {
    kind: "ask",
    approvalEffectId: EFFECT,
    text: "Send this email?",
    status: "pending",
    actions: [
      { id: "allow", label: "Send" },
      { id: "deny", label: "Discard" },
    ],
    draft: {
      app: { name: "Mail", logo: LOGO, account: "ana@example.com" },
      recipients: [
        { role: "to", address: "bo@example.com" },
        { role: "to", address: "cy@example.com" },
        { role: "cc", address: "dee.long-address@partners.example.com" },
        { role: "bcc", address: "ed@example.com" },
      ],
      subject: "Thursday instead of Wednesday",
      body: BODY,
      ...draft,
    },
    ...overrides,
  };
}

function requested(botId: string, id: string, minute: number, block = card()): EntryDraft {
  return {
    id,
    ts: at(minute),
    type: "effect.requested",
    botId,
    runId: RUN,
    payload: { effectId: EFFECT, effectKind: "connector", proposal: {}, card: block },
  };
}

function resolved(
  botId: string,
  id: string,
  minute: number,
  decision: "approved" | "denied",
  dismissed?: true,
): EntryDraft {
  return {
    id,
    ts: at(minute),
    type: "effect.resolved",
    botId,
    runId: RUN,
    payload: { effectId: EFFECT, decision, ...(dismissed ? { dismissed } : {}) },
  };
}

/** The bot asked to send a mail and waits on its draft. */
function waitingDraft(botId: string): EntryDraft[] {
  return [
    {
      id: "draft-request",
      ts: at(10),
      type: "user.message",
      payload: {
        blocks: [{ kind: "text", text: "Email Bo and Cy that Thursday works better." }],
        source: "app",
      },
    },
    runStarted(botId, RUN, 10, "draft-request"),
    {
      id: "draft-reply",
      ts: at(11),
      type: "assistant.text",
      botId,
      runId: RUN,
      payload: { toPerson: true, midTurn: true, blocks: [{ kind: "text", text: "Ready for Bo." }] },
    },
    requested(botId, "draft-card", 11),
  ];
}

/** What the server logs once a Send left: the edited card, the approval, the sent mail. */
function sentAfter(botId: string, target: string, body: string): EntryDraft[] {
  return [
    {
      id: `${target}-edited`,
      ts: at(12),
      type: "effect.edited",
      botId,
      runId: RUN,
      payload: { effectId: EFFECT, proposal: {}, card: card({}, { body }) },
    },
    resolved(botId, `${target}-approved`, 12, "approved"),
    {
      id: `${target}-sent`,
      ts: at(12),
      type: "effect.applied",
      botId,
      runId: RUN,
      payload: { target, sent: { at: "2026-09-17T10:44:00.000Z", edited: body !== BODY } },
    },
  ];
}

type Captured = { body: Record<string, unknown> | undefined };

/**
 * The served app has no mail connector to send through, so Send, Discard and a typed reply are
 * answered here: each records what the card asked for and logs what the server would have.
 */
async function answerRpc(
  page: Page,
  procedure: "answer" | "send",
  respond: (body: Record<string, unknown>) => unknown,
) {
  const captured: Captured = { body: undefined };
  await page.route(new RegExp(`/rpc/threads/${procedure}(?:\\?|$)`), async (route: Route) => {
    const request: Request = route.request();
    const body = (request.postDataJSON() as { json: Record<string, unknown> }).json;
    captured.body = body;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: respond(body) }),
    });
  });
  return captured;
}

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const width = page.viewportSize()?.width;
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await captureScreenshot(page, testInfo, `outbound-draft-${name}-${theme}-${width}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

for (const width of [1440, 390]) {
  test(`a mail draft is edited in place, sent, retried, discarded and replaced (${width})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signup(
      page,
      `outbound-draft-${width}-${Date.now()}@rakazo.test`,
      "password12",
      "Ana Lima",
    );
    await completeOnboarding(page);
    const botId = activeBotId(page);
    const drafts = waitingDraft(botId);
    const reset = async (entries: EntryDraft[]) => {
      drafts.splice(0, drafts.length, ...entries);
      await page.reload({ waitUntil: "domcontentloaded" });
    };
    let onAnswer: (body: Record<string, unknown>) => void = () => undefined;
    const answered = await answerRpc(page, "answer", (body) => {
      onAnswer(body);
      return { ok: true };
    });
    const sent = await answerRpc(page, "send", (body) => {
      drafts.push(resolved(botId, "draft-replaced", 13, "denied", true), {
        id: "draft-typed",
        ts: at(13),
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: body.text }], source: "app" },
      });
      return { taskId: "draft-task", runId: RUN, seq: 99 };
    });
    await showThread(page, drafts, { run: null });

    const draftCard = page.getByTestId("draft-card");
    const text = draftCard.getByRole("textbox", { name: "Edit message", exact: true });
    const header = draftCard.locator('[data-slot="framed-block-header"]');
    const button = (name: string) => draftCard.getByRole("button", { name, exact: true });

    // At rest: the app and account, every recipient by role, the subject, the text, nothing else.
    await expect(header).toHaveText("Mail · ana@example.com");
    await expect(draftCard.getByText("To bo@example.com, cy@example.com")).toBeVisible();
    await expect(draftCard.getByText("Cc dee.long-address@partners.example.com")).toBeVisible();
    await expect(draftCard.getByText("Bcc ed@example.com")).toBeVisible();
    await expect(draftCard.getByText("Subject Thursday instead of Wednesday")).toBeVisible();
    await expect(text).toHaveValue(BODY);
    await expect(draftCard.locator('[data-slot="framed-block-status"]')).toHaveCount(0);
    const [trash, copy, send] = await Promise.all(
      ["Discard", "Copy", "Send"].map((name) => button(name).boundingBox()),
    );
    expect(trash!.x).toBeLessThan(copy!.x);
    expect(copy!.x).toBeLessThan(send!.x);
    await expect(button("Send")).toHaveAttribute("data-consequential", "true");
    await shoot(page, testInfo, "rest");

    // Editing in place: the state reads Editing while typing, Edited once the field is left.
    await text.click();
    await expect(header).toContainText("Editing");
    await text.fill(EDITED);
    await shoot(page, testInfo, "editing");
    await draftCard.getByText("Subject").click();
    await expect(header).toContainText("Edited");

    // Send carries the edited text, then the card settles on the bot's paper.
    onAnswer = () => drafts.push(...sentAfter(botId, "draft-card", EDITED));
    await button("Send").click();
    await expect(draftCard).toHaveAttribute("data-answered", "true");
    expect(answered.body).toMatchObject({
      runId: RUN,
      messageId: "draft-card",
      answer: "allow",
      edits: { text: EDITED },
    });
    await expect(
      draftCard.getByText(/^Sent to bo@example\.com, cy@example\.com · \d/),
    ).toBeVisible();
    await expect(draftCard).toContainText("Tell me if 8pm is OK.");
    await shoot(page, testInfo, "sent");

    // A send that did not leave opens again, Not sent with its reason, answered under its new entry.
    const failure = { reason: "Mail is disconnected.", disconnected: true };
    await reset([
      ...waitingDraft(botId),
      resolved(botId, "draft-approved", 12, "approved"),
      requested(botId, "draft-card-again", 13, card({}, { body: EDITED, failure })),
    ]);
    await expect(header).toContainText("Not sent");
    await expect(draftCard.getByText("Mail is disconnected.", { exact: true })).toBeVisible();
    await expect(text).toHaveValue(EDITED);
    await expect(button("Try again")).toHaveCount(0);
    await shoot(page, testInfo, "not-sent");
    await button("Reconnect Mail").click();
    const integrations = page.getByRole("dialog");
    await expect(integrations.getByRole("button", { name: "Close integrations" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(integrations).toHaveCount(0);
    onAnswer = () => drafts.push(...sentAfter(botId, "draft-card-again", EDITED));
    await button("Try again").click();
    await expect(draftCard.getByText(/^Sent to /)).toBeVisible();
    expect(answered.body).toMatchObject({ messageId: "draft-card-again", answer: "allow" });

    // Discard waits five seconds with Undo, then tells the server.
    await reset(waitingDraft(botId));
    answered.body = undefined;
    await button("Discard").click();
    await expect(draftCard).toContainText("Discarded · Undo");
    await draftCard.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(button("Send")).toBeVisible();
    onAnswer = () => drafts.push(resolved(botId, "draft-denied", 12, "denied"));
    await button("Discard").click();
    await expect(draftCard).toHaveText(/Discarded$/, { timeout: 10_000 });
    expect(answered.body).toMatchObject({ messageId: "draft-card", answer: "deny" });

    // Typing to the bot while the draft waits replaces it and carries the edited text.
    await reset(waitingDraft(botId));
    await text.fill(EDITED);
    const composer = page.locator('textarea[name="chat-message"]');
    await composer.fill("Make it Friday instead.");
    await composer.press("Enter");
    await expect(draftCard).toContainText("Replaced");
    expect(sent.body).toMatchObject({
      text: "Make it Friday instead.",
      draft: { messageId: "draft-card", text: EDITED },
    });
    await shoot(page, testInfo, "replaced");

    // Another member of the thread sees the owner's draft, read-only and with no actions.
    const owner = { userId: "another-member", name: "Bo Chen" };
    await reset([
      ...waitingDraft(botId).slice(0, -1),
      requested(botId, "draft-card", 11, card({}, { owner })),
    ]);
    await expect(draftCard.getByText("BC", { exact: true })).toBeVisible();
    await expect(draftCard.getByRole("textbox")).toHaveCount(0);
    await expect(draftCard.getByRole("button")).toHaveCount(0);
    await expect(
      draftCard.getByText("Could we do Thursday instead?", { exact: false }),
    ).toBeVisible();
  });
}

test("a discard still reaches its own thread when the person moves to another one within Undo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, `outbound-draft-move-${Date.now()}@rakazo.test`, "password12", "Ana Lima");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const other = await rpc<{ id: string }>(page, "bots/create", {
    name: "Scout",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const answered = await answerRpc(page, "answer", () => ({ ok: true }));
  await showThread(page, waitingDraft(botId), { run: null });
  const draftCard = page.getByTestId("draft-card");
  await draftCard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(draftCard).toContainText("Discarded · Undo");

  await page.getByText("Scout", { exact: true }).filter({ visible: true }).first().click();
  await page.waitForURL(new RegExp(`/app/${other.id}$`));
  await expect
    .poll(() => answered.body)
    .toMatchObject({
      botId,
      runId: RUN,
      messageId: "draft-card",
      answer: "deny",
    });
});
