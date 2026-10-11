import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, PostgresSessionLog } from "@rakazo/adapters";
import type { SessionEntry, SessionId } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof createApp>>;
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const fixtureKey = "offline-product-fixture-key";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("uses a saved model connection and the real executor to persist a file and completed run", async () => {
    await journey(
      [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes/result.txt.");
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "product-write",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-write");
            expect(JSON.parse(String(result?.content))).toMatchObject({
              ok: true,
              path: "notes/result.txt",
            });
          },
          response: { type: "text", text: "Saved notes/result.txt." },
        },
      ],
      async ({ app, cookie, bot, prisma, send }) => {
        const sent = await send("Save hello to notes/result.txt.");
        await sent.settled("completed");
        const file = await rpc<{ content: string }>(app, cookie, "computer/readFile", {
          botId: bot.id,
          path: "notes/result.txt",
        });
        expect(file.content).toBe("hello");
        const thread = await rpc<{ messages: Array<{ role: string; blocks: unknown[] }> }>(
          app,
          cookie,
          "threads/get",
          { botId: bot.id },
        );
        const messages = JSON.stringify(thread.messages);
        expect(messages).toContain("Saved notes/result.txt.");
        expect(messages).not.toContain(fixtureKey);
        const tools = await prisma.event.findMany({
          where: { botId: bot.id, type: "agent.tool.called" },
          select: { payload: true },
        });
        expect(tools).toHaveLength(1);
        expect(JSON.stringify(tools[0])).toContain("write_file");
      },
    );
  }, 30_000);

  it("logs a run's tool call and a helper's run in its own session, one chain each", async () => {
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-write",
            name: "write_file",
            arguments: { path: "notes/hello.txt", content: "hello" },
          },
        },
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-delegate",
            name: "run_subagent",
            arguments: { name: "checker", task: "Say checked." },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Say checked.");
          },
          response: { type: "text", text: "checked" },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("journey-delegate");
          },
          response: { type: "text", text: "Saved and checked." },
        },
      ],
      async ({ prisma, send, log }) => {
        const sent = await send("Save hello, then have a helper check it.");
        await sent.settled("completed");

        const parent = await log.readTail(sent.sessionId);
        const [, , call, result, delegation, subagent] = parent;
        expect(parent.map((entry) => entry.type)).toEqual([
          "user.message",
          "run.started",
          "tool.call",
          "tool.result",
          "tool.call",
          "subagent",
          "assistant.text",
          "run.finished",
        ]);
        expect(parent.map((entry) => entry.parentId)).toEqual([
          null,
          ...parent.slice(0, -1).map((entry) => entry.id),
        ]);
        expect(await prisma.sessionEntry.count({ where: { sessionId: sent.sessionId } })).toBe(
          parent.length,
        );
        expect([call, result].map((entry) => payloadOf(entry).callId)).toEqual([
          "journey-write",
          "journey-write",
        ]);
        expect(payloadOf(delegation)).toMatchObject({
          callId: "journey-delegate",
          name: "run_subagent",
        });
        expect(payloadOf(subagent)).toMatchObject({
          callId: "journey-delegate",
          name: "checker",
          task: "Say checked.",
          status: "completed",
          result: "checked",
        });

        const helper = await log.readTail(payloadOf(subagent).sessionId as SessionId);
        const helperRunId = helper[0]?.runId;
        expect(helper.map((entry) => [entry.type, entry.runId])).toEqual([
          ["run.started", helperRunId],
          ["assistant.text", helperRunId],
          ["run.finished", helperRunId],
        ]);
        expect(payloadOf(helper[0])).toMatchObject({
          trigger: { kind: "subagent", entryId: delegation?.id },
        });
        expect(payloadOf(helper[2])).toMatchObject({ status: "completed" });
        expect(
          await prisma.run.findUniqueOrThrow({
            where: { id: helperRunId! },
            select: { parentRunId: true, status: true },
          }),
        ).toEqual({ parentRunId: sent.runId, status: "completed" });
      },
    );
  }, 30_000);

  it("closes a helper behind its parent's thread lock, holding nothing a stop needs first", async () => {
    let helperAsked!: () => void;
    let answerHelper!: () => void;
    const asked = new Promise<void>((resolve) => {
      helperAsked = resolve;
    });
    const answered = new Promise<void>((resolve) => {
      answerHelper = resolve;
    });
    await journey(
      [
        { expect() {}, response: DELEGATE },
        {
          async expect() {
            helperAsked();
            await answered;
          },
          response: { type: "text", text: "checked" },
        },
        { expect() {}, response: { type: "text", text: "Checked." } },
      ],
      async ({ prisma, send }) => {
        const sent = await send("Have a helper check it.");
        await asked;
        const helper = await prisma.run.findFirstOrThrow({ where: { parentRunId: sent.runId } });
        const { threadId } = await prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const holding = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const stopLike = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
            locked();
            await released;
          },
          { timeout: 20_000 },
        );
        await holding;
        answerHelper();
        await expect
          .poll(
            async () => {
              const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
                SELECT count(*)::int AS waiting FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query ILIKE '%FROM threads%FOR UPDATE%'`;
              return row!.waiting;
            },
            { timeout: 10_000, interval: 20 },
          )
          .toBe(1);
        const probe =
          await prisma.$queryRaw`SELECT id FROM runs WHERE id = ${helper.id} FOR NO KEY UPDATE NOWAIT`.then(
            () => "free",
            (error: unknown) => String(error),
          );
        release();
        await stopLike;
        await sent.settled("completed");

        expect(probe).toBe("free");
        expect(
          await prisma.run.findUniqueOrThrow({
            where: { id: helper.id },
            select: { status: true },
          }),
        ).toEqual({ status: "completed" });
      },
    );
  }, 30_000);

  it("keeps a helper's log and its parent's result when the helper's writes fail", async () => {
    await journey(
      [
        { expect() {}, response: DELEGATE },
        { expect() {}, response: { type: "text", text: "checked" } },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(String(result?.content)).toMatch(
              /^Subagent failed: .*injected subagent entry failure/s,
            );
          },
          response: { type: "text", text: "The helper failed." },
        },
      ],
      ({ prisma, send, log }) =>
        withEntryFaults(prisma, 1, async () => {
          const sent = await send("Have a helper check it.");
          await sent.settled("completed");

          const parent = await log.readTail(sent.sessionId);
          const subagent = parent.find((entry) => entry.type === "subagent");
          expect(parent.map((entry) => entry.type)).toEqual([
            "user.message",
            "run.started",
            "tool.call",
            "subagent",
            "assistant.text",
            "run.finished",
          ]);
          expect(payloadOf(subagent)).toMatchObject({
            callId: "journey-delegate",
            status: "failed",
            result: expect.stringMatching(/^Subagent failed: .*injected subagent entry failure/s),
          });
          const helper = await log.readTail(payloadOf(subagent).sessionId as SessionId);
          expect(helper.map((entry) => [entry.type, payloadOf(entry).status])).toEqual([
            ["run.started", undefined],
            ["run.finished", "failed"],
          ]);
          expect(
            await prisma.run.findUniqueOrThrow({
              where: { id: helper[0]!.runId! },
              select: { status: true },
            }),
          ).toEqual({ status: "failed" });
        }),
    );
  }, 30_000);

  it("answers the parent's call with the helper's failure when its log cannot close twice", async () => {
    const failure = /^Subagent failed: .*injected subagent entry failure/s;
    await journey(
      [
        { expect() {}, response: DELEGATE },
        { expect() {}, response: { type: "text", text: "checked" } },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(String(result?.content)).toMatch(failure);
          },
          response: { type: "text", text: "The helper failed." },
        },
      ],
      ({ prisma, send, log }) =>
        withEntryFaults(prisma, 2, async () => {
          const sent = await send("Have a helper check it.");
          await sent.settled("completed");

          const parent = await log.readTail(sent.sessionId);
          expect(parent.map((entry) => entry.type)).toEqual([
            "user.message",
            "run.started",
            "tool.call",
            "tool.result",
            "assistant.text",
            "run.finished",
          ]);
          expect(payloadOf(parent[3])).toMatchObject({
            callId: "journey-delegate",
            isError: true,
            output: expect.stringMatching(failure),
          });
        }),
    );
  }, 30_000);

  it("gives every call one result when the run pauses for an answer, then an approval", async () => {
    const secret = {
      label: "API key",
      purpose: "api_key",
      credential: {
        name: "example_api",
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      },
    };
    const spawn = (instructions: string) =>
      ({
        type: "tool",
        id: "journey-spawn",
        name: "spawn_bot",
        arguments: { name: "Scout", instructions, computer_mode: "team" },
      }) as const;
    await journey(
      [
        {
          expect() {},
          response: { type: "tool", id: "journey-ask", name: "request_secret", arguments: secret },
        },
        {
          expect() {},
          response: { type: "tool", id: "journey-ask", name: "request_secret", arguments: secret },
        },
        { expect() {}, response: spawn("You are Scout.") },
        { expect() {}, response: spawn(EDITED_INSTRUCTIONS) },
        { expect() {}, response: { type: "text", text: "Saved the key and created Scout." } },
      ],
      async ({ app, cookie, bot, prisma, send, log }) => {
        const sent = await send("Save my API key, then create Scout.");
        const answerCard = async (answer: string, edits?: Record<string, string>) => {
          await sent.settled("waiting_input");
          const card = await prisma.message.findFirstOrThrow({
            where: { runId: sent.runId, role: "bot" },
            orderBy: { seq: "desc" },
          });
          await rpc(app, cookie, "threads/answer", {
            botId: bot.id,
            runId: sent.runId,
            messageId: card.id,
            answer,
            ...(edits ? { edits } : {}),
          });
        };
        await answerCard("journey-secret-value");
        await answerCard("allow", { instructions: EDITED_INSTRUCTIONS });
        await sent.settled("completed");

        const entries = await log.readRun(sent.runId);
        expect(
          entries.map((entry) => [entry.type, payloadOf(entry).callId, payloadOf(entry).output]),
        ).toEqual([
          ["run.started", undefined, undefined],
          ["tool.call", "journey-ask", undefined],
          ["assistant.ask", undefined, undefined],
          ["tool.result", "journey-ask", "paused: awaiting answer"],
          ["tool.call", "journey-ask", undefined],
          ["tool.result", "journey-ask", expect.any(String)],
          ["tool.call", "journey-spawn", undefined],
          ["effect.requested", undefined, undefined],
          ["tool.result", "journey-spawn", "paused: awaiting approval"],
          ["effect.edited", undefined, undefined],
          ["effect.resolved", undefined, undefined],
          ["tool.call", "journey-spawn", undefined],
          ["assistant.text", undefined, undefined],
          ["tool.result", "journey-spawn", expect.any(String)],
          ["assistant.text", undefined, undefined],
          ["run.finished", undefined, undefined],
        ]);
        const spawnCalls = entries.filter(
          (entry) => entry.type === "tool.call" && payloadOf(entry).name === "spawn_bot",
        );
        expect(
          spawnCalls.map((entry) => String(payloadOf(entry).input).includes("venues")),
        ).toEqual([false, true]);
        const [requested, edited, resolved] = entries.filter((entry) =>
          entry.type.startsWith("effect."),
        );
        expect([
          payloadOf(requested).proposal,
          payloadOf(edited).proposal,
          payloadOf(resolved).decision,
        ]).toMatchObject([
          { instructions: "You are Scout." },
          { instructions: EDITED_INSTRUCTIONS },
          "approved",
        ]);
        expect(JSON.stringify(entries)).not.toContain("journey-secret-value");
      },
    );
  }, 30_000);

  it("logs a denied approval as the effect's decision, the paused call keeping its result", async () => {
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-spawn",
            name: "spawn_bot",
            arguments: { name: "Scout", instructions: "You are Scout.", computer_mode: "team" },
          },
        },
        { expect() {}, response: { type: "text", text: "I will not create Scout." } },
      ],
      async ({ app, cookie, bot, prisma, send, log }) => {
        const sent = await send("Create a bot named Scout.");
        await sent.settled("waiting_input");
        const card = await prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        await rpc(app, cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer: "deny",
        });
        await sent.settled("completed");

        const entries = await log.readRun(sent.runId);
        expect(
          entries.map((entry) => [
            entry.type,
            payloadOf(entry).output ?? payloadOf(entry).decision ?? payloadOf(entry).status,
          ]),
        ).toEqual([
          ["run.started", undefined],
          ["tool.call", undefined],
          ["effect.requested", undefined],
          ["tool.result", "paused: awaiting approval"],
          ["effect.resolved", "denied"],
          ["assistant.text", undefined],
          ["run.finished", "completed"],
        ]);
      },
    );
  }, 30_000);

  it("closes a helper as cancelled by whoever stopped its parent", async () => {
    let helperOpened!: () => void;
    const helperHolding = new Promise<void>((resolve) => {
      helperOpened = resolve;
    });
    await journey(
      [
        { expect() {}, response: DELEGATE },
        { expect() {}, response: { type: "hold", onOpen: () => helperOpened() } },
      ],
      async ({ app, cookie, bot, prisma, send, log, userId }) => {
        const sent = await send("Have a helper check it.");
        await helperHolding;
        const helper = await prisma.run.findFirstOrThrow({ where: { parentRunId: sent.runId } });
        await rpc(app, cookie, "threads/stop", { botId: bot.id });
        await sent.settled("cancelled");

        const ended = async (runId: string) =>
          (await log.readRun(runId)).map((entry) => [entry.type, payloadOf(entry).status]);
        expect(await ended(helper.id)).toEqual([
          ["run.started", undefined],
          ["run.finished", "cancelled"],
        ]);
        expect(await ended(sent.runId)).toEqual([
          ["run.started", undefined],
          ["tool.call", undefined],
          ["run.finished", "cancelled"],
        ]);
        expect(
          (await log.readRun(helper.id)).map((entry) => payloadOf(entry).by).filter(Boolean),
        ).toEqual([userId]);
        expect(
          await prisma.run.findUniqueOrThrow({
            where: { id: helper.id },
            select: { status: true },
          }),
        ).toEqual({ status: "cancelled" });
      },
    );
  }, 30_000);

  it("starts the run a message sent during the last turn wakes as a steering run", async () => {
    let finalAsked!: () => void;
    let answerFinal!: () => void;
    const asked = new Promise<void>((resolve) => {
      finalAsked = resolve;
    });
    const answered = new Promise<void>((resolve) => {
      answerFinal = resolve;
    });
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-note",
            name: "write_file",
            arguments: { path: "notes/plan.txt", content: "plan" },
          },
        },
        {
          async expect() {
            finalAsked();
            await answered;
          },
          response: { type: "text", text: "Wrote the plan." },
        },
        { expect() {}, response: { type: "text", text: "Added the budget." } },
      ],
      async ({ prisma, send, log }) => {
        const first = await send("Write the plan.");
        await asked;
        const steered = await send("Also add the budget.");
        answerFinal();
        await first.settled("completed");
        const continuation = await prisma.run.findFirstOrThrow({
          where: {
            threadId: (await prisma.run.findUniqueOrThrow({ where: { id: first.runId } })).threadId,
            trigger: "follow_up",
          },
        });
        await expect
          .poll(
            async () =>
              (await prisma.run.findUniqueOrThrow({ where: { id: continuation.id } })).status,
            { timeout: 15_000, interval: 100 },
          )
          .toBe("completed");

        const chain = await log.readTail(first.sessionId);
        const steering = chain.find(
          (entry) => entry.type === "user.message" && entry.id !== chain[0]?.id,
        );
        expect(
          chain.map((entry) =>
            entry.type === "user.message" ? `user:${entry.id === steering?.id}` : entry.type,
          ),
        ).toEqual([
          "user:false",
          "run.started",
          "tool.call",
          "tool.result",
          "user:true",
          "assistant.text",
          "run.finished",
          "run.started",
          "assistant.text",
          "run.finished",
        ]);
        expect(payloadOf(chain.findLast((entry) => entry.type === "run.started")).trigger).toEqual({
          kind: "steering",
          entryId: steering?.id,
        });
        expect(steered.runId).toBe(first.runId);
      },
    );
  }, 30_000);

  it("logs a skill the bot saves with a tool as skill.saved in its run", async () => {
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-skill",
            name: "skill_create",
            arguments: {
              name: "weekly-digest",
              description: "Send the weekly digest.",
              body: "Collect the week's notes and send them.",
            },
          },
        },
        { expect() {}, response: { type: "text", text: "Saved the skill." } },
      ],
      async ({ send, log }) => {
        const sent = await send("Save a skill for the weekly digest.");
        await sent.settled("completed");

        const entries = await log.readRun(sent.runId);
        expect(
          entries.map((entry) => [entry.type, payloadOf(entry).callId ?? payloadOf(entry).name]),
        ).toEqual([
          ["run.started", undefined],
          ["tool.call", "journey-skill"],
          ["skill.saved", "weekly-digest"],
          ["tool.result", "journey-skill"],
          ["assistant.text", undefined],
          ["run.finished", undefined],
        ]);
      },
    );
  }, 30_000);

  it("gives a call the scripted runtime replays under its id a result of its own", async () => {
    await journey(
      [],
      async (fixture) => {
        const entries = await approveEdited(fixture, "spawn a bot named Scout to research venues");
        const tools = entries.filter((entry) => entry.type.startsWith("tool."));
        const callId = payloadOf(tools[0]).callId;
        expect(
          tools.map((entry) => [entry.type, payloadOf(entry).callId, payloadOf(entry).output]),
        ).toEqual([
          ["tool.call", callId, undefined],
          ["tool.result", callId, "paused: awaiting approval"],
          ["tool.call", callId, undefined],
          ["tool.result", callId, expect.stringContaining("Scout")],
        ]);
      },
      "scripted",
    );
  }, 30_000);

  it("logs a stopped run as cancelled by its stopper, then the reply sent to it", async () => {
    let opened!: () => void;
    const holding = new Promise<void>((resolve) => {
      opened = resolve;
    });
    await journey(
      [
        { expect() {}, response: { type: "hold", onOpen: () => opened() } },
        { expect() {}, response: { type: "text", text: "Going on." } },
      ],
      async ({ app, cookie, bot, send, log, userId }) => {
        const stopped = await send("Take your time.");
        await holding;
        await rpc(app, cookie, "threads/stop", { botId: bot.id });
        await stopped.settled("cancelled");
        const [asked] = await log.readTail(stopped.sessionId);
        const reply = await send("Go on.", {
          replyToMessageId: asked?.id,
          replyQuote: "your time",
          clientNonce: "journey-reply",
        });
        await reply.settled("completed");

        const cancelled = await log.readRun(stopped.runId);
        expect(cancelled.map((entry) => entry.type)).toEqual(["run.started", "run.finished"]);
        expect(payloadOf(cancelled[1])).toMatchObject({ status: "cancelled", by: userId });
        const replied = (await log.readTail(reply.sessionId)).find(
          (entry) => entry.type === "user.message" && entry.id !== asked?.id,
        );
        expect(replied?.payload).toEqual({
          blocks: [{ kind: "text", text: "Go on." }],
          replyTo: { entryId: asked?.id, quote: "your time" },
          clientNonce: "journey-reply",
          source: "app",
        });
      },
    );
  }, 30_000);
});

const EDITED_INSTRUCTIONS = "You are Scout. Focus on venues.";
const DELEGATE = {
  type: "tool",
  id: "journey-delegate",
  name: "run_subagent",
  arguments: { name: "checker", task: "Say checked." },
} as const;

/** Fails a helper's first text entry and the first subagent entry, once each, at the database. */
async function withEntryFaults(
  prisma: JourneyFixture["prisma"],
  subagentFailures: number,
  body: () => Promise<void>,
) {
  await prisma.$executeRawUnsafe("CREATE SEQUENCE journey_text_fault");
  await prisma.$executeRawUnsafe("CREATE SEQUENCE journey_subagent_fault");
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION journey_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.type = 'assistant.text'
        AND EXISTS (SELECT 1 FROM sessions WHERE id = NEW."sessionId" AND kind = 'subagent') THEN
        IF nextval('journey_text_fault') = 1 THEN
          RAISE EXCEPTION 'injected helper text failure';
        END IF;
      END IF;
      IF NEW.type = 'subagent' THEN
        IF nextval('journey_subagent_fault') <= ${subagentFailures} THEN
          RAISE EXCEPTION 'injected subagent entry failure';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await prisma.$executeRawUnsafe(
    "CREATE TRIGGER journey_fault BEFORE INSERT ON session_entries FOR EACH ROW EXECUTE FUNCTION journey_fault()",
  );
  try {
    await body();
  } finally {
    await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS journey_fault ON session_entries");
    await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS journey_fault()");
    await prisma.$executeRawUnsafe("DROP SEQUENCE IF EXISTS journey_text_fault");
    await prisma.$executeRawUnsafe("DROP SEQUENCE IF EXISTS journey_subagent_fault");
  }
}

async function approveEdited(
  { app, cookie, bot, prisma, send, log }: JourneyFixture,
  text: string,
): Promise<SessionEntry[]> {
  const sent = await send(text);
  await sent.settled("waiting_input");
  const card = await prisma.message.findFirstOrThrow({
    where: { runId: sent.runId, role: "bot" },
    orderBy: { seq: "desc" },
  });
  await rpc(app, cookie, "threads/answer", {
    botId: bot.id,
    runId: sent.runId,
    messageId: card.id,
    answer: "allow",
    edits: { instructions: EDITED_INSTRUCTIONS },
  });
  await sent.settled("completed");
  const entries = await log.readRun(sent.runId);
  const effect = entries.filter((entry) => entry.type.startsWith("effect."));
  expect(effect.map((entry) => entry.type)).toEqual([
    "effect.requested",
    "effect.edited",
    "effect.resolved",
  ]);
  expect(payloadOf(effect[1])).toMatchObject({ proposal: { instructions: EDITED_INSTRUCTIONS } });
  expect(payloadOf(effect[2])).toMatchObject({ decision: "approved" });
  return entries;
}

function payloadOf(entry: SessionEntry | undefined) {
  return (entry?.payload ?? {}) as Record<string, unknown>;
}

type JourneyFixture = {
  app: App;
  cookie: string;
  bot: { id: string };
  userId: string;
  prisma: Handles["prisma"];
  log: PostgresSessionLog;
  send: (
    text: string,
    options?: { replyToMessageId?: string; replyQuote?: string; clientNonce?: string },
  ) => Promise<{
    runId: string;
    sessionId: SessionId;
    settled: (status: string) => Promise<void>;
  }>;
};

async function journey(
  steps: ModelEmulatorStep[],
  drive: (fixture: JourneyFixture) => Promise<void>,
  agentRuntime: "pi" | "scripted" = "pi",
) {
  const model = await startModelEmulator({ apiKey: fixtureKey, steps });
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-product-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: fixtureOrigin,
      webOrigin: fixtureOrigin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime,
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "offline-model-fixture-encryption-key",
    });
    stop = handles.stop;
    const email = `offline-pi-${randomUUID()}@rakazo.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixtureOrigin },
      body: JSON.stringify({ email, password: "password12", name: "Offline fixture" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const user = await handles.prisma.user.findUniqueOrThrow({ where: { email } });
    await rpc(handles.app, cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: fixtureKey,
    });
    const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "File fixture",
      title: "",
      description: "",
      instructions: "Complete the task.",
      notifyOnFinish: false,
    });
    await rpc(handles.app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: model.model.provider,
      modelId: model.model.id,
    });
    await drive({
      app: handles.app,
      cookie,
      bot,
      userId: user.id,
      prisma: handles.prisma,
      log: new PostgresSessionLog(handles.prisma),
      async send(text, options) {
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text,
          ...options,
        });
        const thread = await handles.prisma.thread.findFirstOrThrow({
          where: { botId: bot.id },
          select: { sessionId: true },
        });
        return {
          runId: sent.runId,
          sessionId: thread.sessionId as SessionId,
          async settled(status) {
            await expect
              .poll(
                async () => {
                  const run = await handles.prisma.run.findUnique({
                    where: { id: sent.runId },
                    select: { status: true },
                  });
                  if (run?.status === "failed") model.assertComplete();
                  return run?.status;
                },
                { timeout: 15_000, interval: 100 },
              )
              .toBe(status);
          },
        };
      },
    });
    model.assertComplete();
  } finally {
    try {
      await stop?.();
    } finally {
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
