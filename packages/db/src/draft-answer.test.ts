import type { SessionId } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import type { AnswerRunInput, DismissProposalWithTextInput } from "./events.js";
import {
  answerRunInput,
  dismissProposalWithTextInTransaction,
  InvalidAnswerError,
} from "./events.js";
import type { PgliteDatabase } from "./pglite.test-support.js";
import { openPgliteDatabase } from "./pglite.test-support.js";
import { appendSessionEntryInTransaction } from "./sessions.js";

const SPACE = "space_drafts";
const OWNER = "user_drafts";
const MARKER = "__marker";
const BODY_PATH = [2, "arguments", "tools", 0, "arguments", "body"];

let database: PgliteDatabase;
let prisma: PrismaClient;

beforeAll(async () => {
  database = await openPgliteDatabase();
  prisma = database.prisma;
  await prisma.user.create({ data: { id: OWNER, name: "U", email: "drafts@rakazo.test" } });
  await prisma.organization.create({
    data: { id: "org_drafts", name: "O", slug: "org-drafts", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org_drafts", name: "S" } });
});
afterAll(() => database.close());

const request = (body: string, subject = "Hello") => [
  MARKER,
  "mcp_execute_tool",
  {
    id: "r1:COMPOSIO_MULTI_EXECUTE_TOOL",
    arguments: {
      tools: [
        {
          tool_slug: "GMAIL_SEND_EMAIL",
          arguments: {
            recipient_email: "someone@example.com",
            subject,
            body,
            include_signature: false,
          },
        },
      ],
    },
  },
];
const draft = {
  app: { name: "Gmail", logo: null },
  recipients: [{ role: "to" as const, address: "someone@example.com" }],
  body: "Hello from Chief.",
};

let seeded = 0;

const masked = (value: string) => value.replace("sk-live-123", "[redacted]");

/** The proposal the executor logs: the request with run secrets masked. */
const proposal = (body: string, subject = "Hello") => ({
  request: request(masked(body), masked(subject)),
});

/** A run waiting on one approval card: a mail draft, a Create bot card or a routine proposal. */
async function waiting(
  kind: "draft" | "spawn_bot" | "routine_proposal" = "draft",
  subject = "Hello",
  body = "Hello from Chief.",
) {
  seeded += 1;
  const bot = await prisma.bot.create({
    data: { spaceId: SPACE, userId: OWNER, name: `Bot ${seeded}`, color: "#00C46A" },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: OWNER, botId: bot.id },
  });
  const task = await prisma.task.create({
    data: {
      spaceId: SPACE,
      botId: bot.id,
      threadId: thread.id,
      userId: OWNER,
      prompt: "Mail them",
      status: "running",
    },
  });
  const run = await prisma.run.create({
    data: {
      spaceId: SPACE,
      botId: bot.id,
      threadId: thread.id,
      taskId: task.id,
      userId: OWNER,
      status: "waiting_input",
      trigger: "user",
    },
  });
  const effect = await prisma.externalEffect.create({
    data:
      kind === "draft"
        ? {
            spaceId: SPACE,
            runId: run.id,
            kind: "COMPOSIO_MULTI_EXECUTE_TOOL",
            idempotencyKey: `key-${seeded}`,
            status: "intended",
            request: request(body, subject),
            draft: { state: "pending", path: BODY_PATH, proposed: body },
          }
        : {
            spaceId: SPACE,
            runId: run.id,
            kind,
            idempotencyKey: `key-${seeded}`,
            status: "intended",
            request: { name: "Scout", instructions: "Watch." },
          },
  });
  const card = {
    kind: "ask" as const,
    text: "Review before sending",
    approvalEffectId: effect.id,
    status: "pending" as const,
    actions: [
      { id: "allow", label: kind === "draft" ? "Send" : "Create bot" },
      { id: "deny", label: kind === "draft" ? "Discard" : "Cancel" },
    ],
    ...(kind === "draft" ? { draft } : {}),
  };
  const entry = await prisma.$transaction((tx) =>
    appendSessionEntryInTransaction(tx, {
      type: "effect.requested",
      sessionId: thread.sessionId as SessionId,
      botId: bot.id,
      runId: run.id,
      payload: {
        effectId: effect.id,
        effectKind: effect.kind,
        proposal: kind === "draft" ? proposal(body, subject) : {},
        card,
      },
    }),
  );
  const answer = (input: Partial<AnswerRunInput>) =>
    answerRunInput(prisma, {
      spaceId: SPACE,
      threadId: thread.id,
      runId: run.id,
      messageId: entry.id,
      answeredByUserId: OWNER,
      answer: "allow",
      ...input,
    });
  const state = async () => ({
    run: (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status,
    effect: await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
    entries: await prisma.sessionEntry.findMany({
      where: { runId: run.id, type: { not: "effect.requested" } },
      orderBy: { seq: "asc" },
      select: { type: true, payload: true },
    }),
    audit: await prisma.event.findMany({
      where: { runId: run.id, type: "effect.edited" },
      select: { payload: true },
    }),
  });
  const typed = (input: Partial<DismissProposalWithTextInput>) =>
    prisma.$transaction((tx) =>
      dismissProposalWithTextInTransaction(tx, {
        spaceId: SPACE,
        threadId: thread.id,
        runId: run.id,
        userId: OWNER,
        ...input,
      }),
    );
  return { answer, typed, state, key: `key-${seeded}`, messageId: entry.id };
}

describe("answering a mail draft card", () => {
  it("sends the user's text in place of the bot's, under the same key, and logs the edit", async () => {
    const w = await waiting();
    await expect(w.answer({ edits: { text: "Hello, edited." } })).resolves.toBe(true);
    const { run, effect, entries, audit } = await w.state();
    expect(run).toBe("queued");
    expect(effect).toMatchObject({
      status: "approved",
      idempotencyKey: w.key,
      request: request("Hello, edited."),
      draft: { state: "approved", path: BODY_PATH, proposed: "Hello from Chief." },
    });
    expect(entries).toEqual([
      {
        type: "effect.edited",
        payload: expect.objectContaining({
          proposal: { request: request("Hello, edited.") },
          card: expect.objectContaining({
            status: "answered",
            answer: "allow",
            detail: "to: someone@example.com\nbody:\n  Hello, edited.",
            draft: { ...draft, body: "Hello, edited." },
          }),
        }),
      },
      { type: "effect.resolved", payload: expect.objectContaining({ decision: "approved" }) },
    ]);
    expect(audit.map((event) => event.payload)).toEqual([
      expect.objectContaining({ proposed: "Hello from Chief.", approved: "Hello, edited." }),
    ]);
  });

  it("logs the edit on the masked proposal, never the request's secrets", async () => {
    const w = await waiting("draft", "Token sk-live-123", "Your key is sk-live-123.");
    await expect(w.answer({ edits: { text: "Hello, edited." } })).resolves.toBe(true);
    const { entries, audit } = await w.state();
    expect(entries[0]).toMatchObject({
      type: "effect.edited",
      payload: { proposal: proposal("Hello, edited.", "Token sk-live-123") },
    });
    expect(audit.map((event) => event.payload)).toEqual([
      expect.objectContaining({ proposed: "Your key is [redacted].", approved: "Hello, edited." }),
    ]);
    expect(JSON.stringify([entries, audit])).not.toContain("sk-live-123");
  });

  it("sends the bot's text as it is when the user did not edit it", async () => {
    const w = await waiting();
    await expect(w.answer({})).resolves.toBe(true);
    const { effect, entries, audit } = await w.state();
    expect(effect).toMatchObject({ status: "approved", request: request("Hello from Chief.") });
    expect(entries.map((entry) => entry.type)).toEqual(["effect.resolved"]);
    expect(audit).toEqual([]);
  });

  it("discards it", async () => {
    const w = await waiting();
    await expect(w.answer({ answer: "deny" })).resolves.toBe(true);
    const { effect } = await w.state();
    expect(effect).toMatchObject({ status: "denied", draft: { state: "discarded" } });
  });

  it("takes one of two Sends that race, the other finding nothing to answer", async () => {
    const w = await waiting();
    const answered = await Promise.all([
      w.answer({ edits: { text: "First tap." } }),
      w.answer({ edits: { text: "Second device." } }),
    ]);
    expect(answered.toSorted()).toEqual([false, true]);
    const { effect, entries } = await w.state();
    expect(effect.request).toEqual(request(answered[0] ? "First tap." : "Second device."));
    expect(entries.filter((entry) => entry.type === "effect.resolved")).toHaveLength(1);
  });

  it.each([
    ["another member", { answeredByUserId: "user_other" }],
    ["always allow", { answer: "always" }],
  ])("refuses %s and changes nothing", async (_, input) => {
    const w = await waiting();
    await expect(w.answer(input)).resolves.toBe(false);
    const { run, effect } = await w.state();
    expect([run, effect.status]).toEqual(["waiting_input", "intended"]);
  });

  it.each([
    ["an empty text", { text: " \n" }, "This message is empty."],
    [
      "a text too long",
      { text: "x".repeat(20_001) },
      "This message is longer than 20000 characters.",
    ],
    ["a bot's name", { name: "Scout" }, "Only the message text can be edited"],
  ])("refuses %s with a clear error and changes nothing", async (_, edits, message) => {
    const w = await waiting();
    const refused = w.answer({ edits });
    await expect(refused).rejects.toThrow(InvalidAnswerError);
    await expect(refused).rejects.toThrow(message);
    const { run, effect } = await w.state();
    expect([run, effect.status]).toEqual(["waiting_input", "intended"]);
  });

  it.each([
    ["with Discard", { answer: "deny" }, "Edits can only be sent with Send"],
    [
      "by another member",
      { answeredByUserId: "user_other" },
      "Only the owner of this run can edit the message",
    ],
  ])("refuses an edit %s in a draft's own words", async (_, input, message) => {
    const w = await waiting();
    await expect(w.answer({ ...input, edits: { text: "Hi" } })).rejects.toThrow(message);
  });

  it("refuses a text on a Create bot card", async () => {
    const w = await waiting("spawn_bot");
    await expect(w.answer({ edits: { text: "Hi" } })).rejects.toThrow(
      "Only a mail draft's text can be edited",
    );
  });
});

describe("writing to the bot while a mail draft waits", () => {
  it("replaces the draft with the text the user left on it, sending nothing", async () => {
    const w = await waiting();
    await expect(
      w.typed({ draft: { messageId: w.messageId, text: "Hello, edited." } }),
    ).resolves.toEqual({ outcome: "dismissed", status: "queued" });
    const { run, effect, entries, audit } = await w.state();
    expect(run).toBe("queued");
    expect(effect).toMatchObject({
      status: "denied",
      idempotencyKey: w.key,
      request: request("Hello, edited."),
      result: null,
      draft: { state: "replaced", path: BODY_PATH, proposed: "Hello from Chief." },
    });
    expect(entries).toEqual([
      {
        type: "effect.resolved",
        payload: { effectId: effect.id, decision: "denied", dismissed: true },
      },
    ]);
    expect(audit).toEqual([]);
  });

  it("replaces it with the bot's text when the user did not edit it", async () => {
    const w = await waiting();
    await expect(w.typed({})).resolves.toEqual({ outcome: "dismissed", status: "queued" });
    const { effect } = await w.state();
    expect(effect).toMatchObject({
      status: "denied",
      request: request("Hello from Chief."),
      draft: { state: "replaced" },
    });
  });

  it("leaves a Send on the replaced card nothing to answer", async () => {
    const w = await waiting();
    await w.typed({ draft: { messageId: w.messageId, text: "Hello, edited." } });
    await expect(w.answer({ edits: { text: "Too late." } })).resolves.toBe(false);
    const { effect } = await w.state();
    expect([effect.status, effect.request]).toEqual(["denied", request("Hello, edited.")]);
  });

  it.each([
    ["comes from another member", "user_other", undefined],
    ["names a card that is no longer the one waiting", OWNER, "entry_stale"],
  ])("keeps the card when the text %s", async (_, userId, staleId) => {
    const w = await waiting();
    await expect(
      w.typed({ userId, draft: { messageId: staleId ?? w.messageId, text: "Hello, edited." } }),
    ).resolves.toEqual({ outcome: "keep" });
    const { run, effect, entries } = await w.state();
    expect([run, effect.status, effect.request, entries]).toEqual([
      "waiting_input",
      "intended",
      request("Hello from Chief."),
      [],
    ]);
  });

  it("keeps a routine proposal a draft text was sent with", async () => {
    const w = await waiting("routine_proposal");
    await expect(
      w.typed({ draft: { messageId: w.messageId, text: "Hello, edited." } }),
    ).resolves.toEqual({ outcome: "keep" });
    const { run, effect } = await w.state();
    expect([run, effect.status]).toEqual(["waiting_input", "intended"]);
  });
});
