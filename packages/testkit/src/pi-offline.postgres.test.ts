import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, composioEntityId, PostgresSessionLog } from "@rakazo/adapters";
import type { SessionEntry, SessionId, ThreadEntry } from "@rakazo/contracts";
import { askDraftState, EntrySeq, SessionId as SessionIdSchema } from "@rakazo/contracts";
import { projectThreadItems } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { latestCard, sessionCookieHeader } from "./index.js";
import type {
  ModelEmulatorRequest,
  ModelEmulatorResponse,
  ModelEmulatorStep,
} from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof createApp>>;
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
const fixtureKey = "offline-product-fixture-key";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("discovers a fact only in an archived recap after compaction and answers without repeating file tools", async () => {
    let priorRunId = "";
    const toolResult = (request: ModelEmulatorRequest) =>
      JSON.parse(String(request.messages.findLast((message) => message.role === "tool")?.content));
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "save",
            name: "write_file",
            arguments: { path: "receipt.txt", content: "Receipt Zebra731" },
          },
        },
        {
          expect(request) {
            expect(toolResult(request)).toMatchObject({ ok: true });
          },
          response: {
            type: "tool",
            id: "read",
            name: "read_file",
            arguments: { path: "receipt.txt" },
          },
        },
        {
          expect(request) {
            expect(toolResult(request)).toMatchObject({ content: "Receipt Zebra731" });
          },
          response: {
            type: "tool",
            id: "say",
            name: "message_user",
            arguments: { message: "Receipt captured." },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            text: JSON.stringify({
              version: 1,
              results: ["Receipt Zebra731"],
              references: [{ callId: "read" }],
            }),
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).not.toContain("Zebra731");
            expect(request.messages.some((message) => message.role === "tool")).toBe(false);
          },
          response: {
            type: "tool",
            id: "catalog",
            name: "search_runs",
            arguments: { query: "Zebra731" },
          },
        },
        {
          expect(request) {
            expect(toolResult(request)).toMatchObject({ items: [{ runId: priorRunId }] });
          },
          response: () => ({
            type: "tool",
            id: "archive",
            name: "search_runs",
            arguments: { runId: priorRunId, query: "Zebra731" },
          }),
        },
        {
          expect(request) {
            expect(toolResult(request)).toMatchObject({
              hits: [{ runId: priorRunId, excerpt: expect.stringContaining("Receipt Zebra731") }],
            });
          },
          response: {
            type: "tool",
            id: "answer",
            name: "message_user",
            arguments: { message: "The captured receipt was Zebra731." },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            text: JSON.stringify({
              version: 1,
              results: ["Answered from the retained receipt"],
              references: [],
            }),
          },
        },
      ],
      async ({ app, cookie, bot, prisma, log, send }) => {
        const first = await send("Capture the receipt in its file.");
        await first.settled("completed");
        priorRunId = first.runId;
        for (let index = 0; index < 2; index++) {
          const head = (await log.readTail(first.sessionId)).at(-1)!;
          await prisma.$transaction((tx) =>
            log.append(tx, {
              type: "compaction",
              sessionId: first.sessionId,
              botId: bot.id,
              parentId: head.id,
              payload: {
                summary: "Earlier work finished.",
                coveredUpToSeq: EntrySeq.parse(head.seq),
              },
            }),
          );
        }
        const second = await send("What did the captured receipt say?");
        await second.settled("completed");
        const entries = await log.readRun(second.runId);
        expect(
          entries.filter((entry) => entry.type === "tool.call").map((entry) => entry.payload.name),
        ).toEqual(["search_runs", "search_runs", "message_user"]);
        const thread = await rpc<{ entries: ThreadEntry[] }>(app, cookie, "threads/get", {
          botId: bot.id,
        });
        const messages = projectThreadItems(thread.entries).filter(
          (item) => item.kind === "message",
        );
        expect(JSON.stringify(messages)).toContain("The captured receipt was Zebra731.");
        expect(JSON.stringify(messages)).not.toContain("Answered from the retained receipt");
      },
    );
  }, 30_000);

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
          response: {
            type: "tool",
            id: "product-reply",
            name: "message_user",
            arguments: { message: "Saved notes/result.txt." },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            text: JSON.stringify({
              version: 1,
              results: ["Saved hello to notes/result.txt"],
              references: [{ callId: "product-write" }],
            }),
          },
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
        const thread = await rpc<{ entries: ThreadEntry[] }>(app, cookie, "threads/get", {
          botId: bot.id,
        });
        const entries = JSON.stringify(thread.entries);
        expect(entries).toContain("Saved notes/result.txt.");
        expect(entries).not.toContain(fixtureKey);
        expect(thread.entries.filter((entry) => entry.type === "run.recap")).toEqual([
          expect.objectContaining({
            runId: sent.runId,
            payload: expect.objectContaining({
              recap: {
                state: "available",
                facts: {
                  version: 1,
                  results: ["Saved hello to notes/result.txt"],
                  references: [{ callId: "product-write" }],
                },
              },
            }),
          }),
        ]);
        const visible = JSON.stringify(projectThreadItems(thread.entries));
        expect(visible).toContain("Saved notes/result.txt.");
        expect(visible).not.toContain('"references"');
        expect(visible).not.toContain('"recap"');
        const tools = await prisma.sessionEntry.findMany({
          where: { botId: bot.id, type: "tool.call" },
          orderBy: { seq: "asc" },
          select: { payload: true },
        });
        expect(tools.map(({ payload }) => (payload as { name: string }).name)).toEqual([
          "write_file",
          "message_user",
        ]);
      },
    );
  }, 30_000);

  it.each([false, true])(
    "reaches the person when the model initially writes privately, structured recap %s",
    async (structured) => {
      const answer = "Le Monde leads with the supermarket cyberattack.";
      const privateText = structured
        ? JSON.stringify({ version: 1, results: [answer], references: [] })
        : answer;
      await journey(
        [
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("What is on the front page?");
            },
            response: { type: "text", text: privateText },
          },
          {
            expect(request) {
              expect(turnsOf(request.messages).texts.at(-2)).toEqual(["assistant", privateText]);
            },
            response: reply(answer),
          },
          DONE,
        ],
        async ({ bot, prisma, send }) => {
          const sent = await send("What is on the front page?");
          await sent.settled("completed");
          const shown = await prisma.sessionEntry.findMany({
            where: { botId: bot.id, runId: sent.runId, type: "assistant.text" },
            orderBy: { seq: "asc" },
            select: { payload: true },
          });
          expect(JSON.stringify(shown)).toContain(answer);
          expect(JSON.stringify(shown)).not.toContain('"references"');
        },
      );
    },
    30_000,
  );

  it("keeps a deliberate silence after one reminder", async () => {
    const text = JSON.stringify({
      version: 1,
      limits: ["Nothing worth sending today"],
      references: [],
    });
    await journey(
      [
        { expect() {}, response: { type: "text", text } },
        { expect() {}, response: { type: "text", text } },
      ],
      async ({ bot, prisma, send }) => {
        const sent = await send("Anything new?");
        await sent.settled("completed");
        const shown = await prisma.sessionEntry.findMany({
          where: { botId: bot.id, runId: sent.runId, type: "assistant.text" },
          select: { payload: true },
        });
        expect(shown).toEqual([]);
        const recaps = await prisma.sessionEntry.findMany({
          where: { runId: sent.runId, type: "run.recap" },
          select: { payload: true },
        });
        expect(recaps).toEqual([
          {
            payload: expect.objectContaining({
              recap: {
                state: "available",
                facts: { version: 1, limits: ["Nothing worth sending today"], references: [] },
              },
            }),
          },
        ]);
      },
    );
  }, 30_000);

  it("does not remind a model that already messaged the user", async () => {
    const answer = "Le Monde leads with the supermarket cyberattack.";
    await journey(
      [
        { expect() {}, response: reply(answer) },
        { expect() {}, response: { type: "text", text: "Sent." } },
      ],
      async ({ bot, prisma, send }) => {
        const sent = await send("What is on the front page?");
        await sent.settled("completed");
        const shown = await prisma.sessionEntry.findMany({
          where: { botId: bot.id, runId: sent.runId, type: "assistant.text" },
          select: { payload: true },
        });
        expect(JSON.stringify(shown).split(answer)).toHaveLength(2);
      },
    );
  }, 30_000);

  it("reminds a model whose plain-text answer follows an update and more tool work", async () => {
    const answer = "Saved hello to notes/result.txt.";
    await journey(
      [
        { expect() {}, response: reply("On it.", "journey-update") },
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-write",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        { expect() {}, response: { type: "text", text: answer } },
        { expect() {}, response: reply(answer) },
        DONE,
      ],
      async ({ bot, prisma, send }) => {
        const sent = await send("Save hello to notes/result.txt.");
        await sent.settled("completed");
        const shown = await prisma.sessionEntry.findMany({
          where: { botId: bot.id, runId: sent.runId, type: "assistant.text" },
          orderBy: { seq: "asc" },
          select: { payload: true },
        });
        expect(JSON.stringify(shown)).toContain("On it.");
        expect(JSON.stringify(shown)).toContain(answer);
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
          response: reply("Saved and checked."),
        },
        DONE,
      ],
      async ({ prisma, send, log }) => {
        const sent = await send("Save hello, then have a helper check it.");
        await sent.settled("completed");

        const parent = await log.readTail(await sent.executionSessionId());
        const [, call, result, delegation, subagent] = parent;
        expect(parent.map((entry) => entry.type)).toEqual([
          "run.started",
          "tool.call",
          "tool.result",
          "tool.call",
          "subagent",
          "tool.call",
          "tool.result",
          "run.finished",
        ]);
        expect(parent.map((entry) => entry.parentId)).toEqual([
          null,
          ...parent.slice(0, -1).map((entry) => entry.id),
        ]);
        expect(
          await prisma.sessionEntry.count({
            where: { sessionId: await sent.executionSessionId() },
          }),
        ).toBe(parent.length);
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

        const conversation = await log.readTail(sent.sessionId);
        expect(conversation.map((entry) => entry.type)).toEqual([
          "user.message",
          "assistant.text",
          "run.recap",
        ]);
        expect(JSON.stringify(projectThreadItems(conversation))).toContain("Saved and checked.");
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
          response: reply("The helper failed."),
        },
        DONE,
      ],
      ({ prisma, send, log }) =>
        withEntryFaults(prisma, 1, async () => {
          const sent = await send("Have a helper check it.");
          await sent.settled("completed");

          const parent = await log.readTail(await sent.executionSessionId());
          const subagent = parent.find((entry) => entry.type === "subagent");
          expect(parent.map((entry) => entry.type)).toEqual([
            "run.started",
            "tool.call",
            "subagent",
            "tool.call",
            "tool.result",
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
          response: reply("The helper failed."),
        },
        DONE,
      ],
      ({ prisma, send, log }) =>
        withEntryFaults(prisma, 2, async () => {
          const sent = await send("Have a helper check it.");
          await sent.settled("completed");

          const parent = await log.readTail(await sent.executionSessionId());
          expect(parent.map((entry) => entry.type)).toEqual([
            "run.started",
            "tool.call",
            "tool.result",
            "tool.call",
            "tool.result",
            "run.finished",
          ]);
          expect(payloadOf(parent[2])).toMatchObject({
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
        { expect() {}, response: reply("Saved the key and created Scout.") },
        DONE,
      ],
      async ({ app, cookie, bot, prisma, send, log }) => {
        const sent = await send("Save my API key, then create Scout.");
        const answerCard = async (answer: string, edits?: Record<string, string>) => {
          await sent.settled("waiting_input");
          const card = await latestCard(prisma, sent.runId);
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
          ["card.answered", undefined, undefined],
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
          ["tool.call", "journey-reply", undefined],
          ["assistant.text", undefined, undefined],
          ["tool.result", "journey-reply", expect.any(String)],
          ["run.recap", undefined, undefined],
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
        { expect() {}, response: reply("I will not create Scout.") },
        DONE,
      ],
      async ({ app, cookie, bot, prisma, send, log }) => {
        const sent = await send("Create a bot named Scout.");
        await sent.settled("waiting_input");
        const card = await latestCard(prisma, sent.runId);
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
          ["tool.call", undefined],
          ["assistant.text", undefined],
          ["tool.result", expect.any(String)],
          ["run.recap", undefined],
          ["run.finished", "completed"],
        ]);
      },
    );
  }, 30_000);

  describe("a mail draft", () => {
    const mail = {
      recipient_email: "someone@example.test",
      subject: "Hello",
      body: "Draft from the bot.",
    };
    const proposeMail: ModelEmulatorStep = {
      expect(request) {
        expect(request.tools?.map((tool) => tool.function.name)).toContain("GMAIL_SEND_EMAIL");
      },
      response: { type: "tool", id: "journey-mail", name: "GMAIL_SEND_EMAIL", arguments: mail },
    };
    /** Gmail connected through the Composio emulator for the fixture's user; its sent mail. */
    async function connectGmail(composio: ComposioEmulator, fixture: JourneyFixture) {
      const { spaceId } = await fixture.prisma.bot.findUniqueOrThrow({
        where: { id: fixture.bot.id },
        select: { spaceId: true },
      });
      await composio.begin(
        { provider: "GMAIL", redirectUrl: "http://127.0.0.1.invalid/callback" },
        {
          operationId: "journey",
          traceId: "journey",
          spaceId,
          userId: fixture.userId,
          signal: new AbortController().signal,
        },
      );
      await fixture.prisma.connection.create({
        data: {
          spaceId,
          userId: fixture.userId,
          provider: "GMAIL",
          displayName: "Gmail",
          status: "pending",
        },
      });
      return () =>
        composio
          .mailboxFor(composioEntityId({ spaceId, userId: fixture.userId }))
          ?.messages.filter((message) => message.to === mail.recipient_email)
          .map((message) => message.messageText);
    }
    async function answerDraft(fixture: JourneyFixture, runId: string, edits?: { text: string }) {
      const card = await latestCard(fixture.prisma, runId);
      await rpc(fixture.app, fixture.cookie, "threads/answer", {
        botId: fixture.bot.id,
        runId,
        messageId: card.id,
        answer: "allow",
        ...(edits ? { edits } : {}),
      });
    }

    it("leaves once, with the user's edit, before the bot's next turn", async () => {
      const composio = new ComposioEmulator();
      await journey(
        [
          proposeMail,
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain(
                "The user sent your draft from its card.",
              );
              expect(JSON.stringify(request.messages)).toContain("Edited by me.");
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          const mailed = await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId, { text: "Edited by me." });
          await sent.settled("completed");
          expect(composio.executions.map((call) => [call.tool, call.args])).toEqual([
            ["GMAIL_SEND_EMAIL", { ...mail, body: "Edited by me.", include_signature: false }],
          ]);
          expect(mailed()).toEqual(["Edited by me."]);
          // The run also records its message_user call, so the mail's row is read by its tool.
          const effects = await fixture.prisma.externalEffect.findMany({
            where: { runId: sent.runId, kind: "GMAIL_SEND_EMAIL" },
          });
          expect(effects).toMatchObject([
            { status: "completed", draft: { state: "sent", proposed: "Draft from the bot." } },
          ]);
        },
        { composio },
      );
    }, 30_000);

    it("asks the user to check Gmail when the send timed out after it left, sending nothing more", async () => {
      const composio = new ComposioEmulator();
      composio.failNext("GMAIL_SEND_EMAIL", { kind: "timeout" });
      await journey(
        [proposeMail],
        async (fixture) => {
          const mailed = await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).block, {
              timeout: 15_000,
            })
            .toMatchObject({
              status: "pending",
              draft: { failure: { reason: "Check Gmail before trying again." } },
            });
          await sent.settled("waiting_input");
          expect(mailed()).toEqual(["Draft from the bot."]);
        },
        { composio },
      );
    }, 30_000);

    it("shows Not sent when Gmail refuses it, and Try again sends it once", async () => {
      const composio = new ComposioEmulator();
      composio.failNext("GMAIL_SEND_EMAIL", { kind: "fail", error: "Invalid recipient" });
      await journey(
        [proposeMail, { expect() {}, response: reply("Sent.") }, DONE],
        async (fixture) => {
          const mailed = await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).block, {
              timeout: 15_000,
            })
            .toMatchObject({
              status: "pending",
              draft: { failure: { reason: "Invalid recipient" } },
            });
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await sent.settled("completed");
          expect(mailed()).toEqual(["Draft from the bot."]);
        },
        { composio },
      );
    }, 30_000);

    it("is replaced by what the user writes, the bot reading their edit and nothing leaving", async () => {
      const composio = new ComposioEmulator();
      await journey(
        [
          proposeMail,
          {
            expect(request) {
              const seen = JSON.stringify(request.messages);
              expect(seen).toContain("The user wrote to you instead of sending this draft");
              expect(seen).toContain("Edited by me.");
              expect(seen).toContain("Make it shorter.");
            },
            response: reply("Here is a shorter one."),
          },
          DONE,
        ],
        async (fixture) => {
          await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          const card = await latestCard(fixture.prisma, sent.runId);
          await expect(
            fixture.send("Make it shorter.", {
              draft: { messageId: "entry_stale", text: "Edited by me." },
            }),
          ).rejects.toThrow("threads/send: 409");
          await fixture.send("Make it shorter.", {
            draft: { messageId: card.id, text: "Edited by me." },
          });
          await sent.settled("completed");

          expect(composio.executions).toEqual([]);
          const effect = await fixture.prisma.externalEffect.findFirstOrThrow({
            where: { runId: sent.runId, kind: "GMAIL_SEND_EMAIL" },
          });
          expect(effect).toMatchObject({
            status: "denied",
            draft: { state: "replaced", proposed: "Draft from the bot." },
          });
          const thread = await rpc<{ entries: ThreadEntry[] }>(
            fixture.app,
            fixture.cookie,
            "threads/get",
            { botId: fixture.bot.id },
          );
          const cards = projectThreadItems(thread.entries).flatMap((item) =>
            item.kind === "effect" && item.card ? [askDraftState(item.card)] : [],
          );
          expect(cards).toEqual(["replaced"]);
        },
        { composio },
      );
    }, 30_000);

    it("tells the bot about the replaced draft once, not again after its next card", async () => {
      const composio = new ComposioEmulator();
      // How often the bot reads the replaced draft, and whether only beside the user's message.
      const told = (request: ModelEmulatorRequest) => {
        const seen = JSON.stringify(request.messages);
        const besideMessage = seen.slice(seen.indexOf("Additional user context:"));
        return [seen.split("editedByUser").length - 1, besideMessage.includes("editedByUser")];
      };
      await journey(
        [
          proposeMail,
          {
            expect(request) {
              expect(told(request)).toEqual([1, true]);
            },
            response: {
              type: "tool",
              id: "journey-which",
              name: "ask_user",
              arguments: { question: "Formal or casual?", options: ["Formal", "Casual"] },
            },
          },
          {
            expect(request) {
              expect(told(request)).toEqual([1, true]);
            },
            response: reply("Here is a casual one."),
          },
          DONE,
        ],
        async (fixture) => {
          await connectGmail(composio, fixture);
          const sent = await fixture.send("Mail them hello.");
          await sent.settled("waiting_input");
          const card = await latestCard(fixture.prisma, sent.runId);
          await fixture.send("Make it shorter.", {
            draft: { messageId: card.id, text: "Edited by me." },
          });
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).id, {
              timeout: 15_000,
            })
            .not.toBe(card.id);
          await sent.settled("waiting_input");
          const question = await latestCard(fixture.prisma, sent.runId);
          await rpc(fixture.app, fixture.cookie, "threads/answer", {
            botId: fixture.bot.id,
            runId: sent.runId,
            messageId: question.id,
            answer: "choice-2",
          });
          await sent.settled("completed");
          expect(composio.executions).toEqual([]);
        },
        { composio },
      );
    }, 30_000);
  });

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
          ["run.recap", undefined],
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
        { expect() {}, response: reply("Wrote the plan.") },
        {
          async expect() {
            finalAsked();
            await answered;
          },
          response: { type: "text", text: "" },
        },
        { expect() {}, response: reply("Added the budget.") },
        DONE,
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
          "assistant.text",
          "user:true",
          "run.recap",
          "assistant.text",
          "run.recap",
        ]);
        const continued = await prisma.run.findUniqueOrThrow({ where: { id: continuation.id } });
        const trace = await log.readTail(SessionIdSchema.parse(continued.sessionId));
        expect(payloadOf(trace.find((entry) => entry.type === "run.started")).trigger).toEqual({
          kind: "steering",
          entryId: steering?.id,
        });
        expect(steered.runId).toBe(first.runId);
      },
    );
  }, 30_000);

  it("logs a skill the bot creates as skill.learnt once its run ended", async () => {
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
        { expect() {}, response: reply("Saved the skill.") },
        DONE,
      ],
      async ({ send, log }) => {
        const sent = await send("Save a skill for the weekly digest.");
        await sent.settled("completed");

        await expect
          .poll(async () =>
            (await log.readRun(sent.runId)).map((entry) => [
              entry.type,
              payloadOf(entry).callId ?? payloadOf(entry).change,
            ]),
          )
          .toEqual([
            ["run.started", undefined],
            ["tool.call", "journey-skill"],
            ["tool.result", "journey-skill"],
            ["tool.call", "journey-reply"],
            ["assistant.text", undefined],
            ["tool.result", "journey-reply"],
            ["run.recap", undefined],
            ["run.finished", undefined],
            ["skill.learnt", "learned"],
          ]);
        const learnt = (await log.readRun(sent.runId)).at(-1);
        expect(learnt).toMatchObject({
          sessionId: sent.sessionId,
          payload: { skillId: "user:weekly-digest", name: "weekly-digest", change: "learned" },
        });
      },
    );
  }, 30_000);

  it("hands the skill nudge the exchange it just had, every call with the output it returned", async () => {
    const calls = Array.from({ length: 15 }, (_, index) => `journey-search-${index}`);
    let exchange: ModelEmulatorRequest | undefined;
    await journey(
      [
        ...calls.map(
          (id): ModelEmulatorStep => ({
            expect() {},
            response: { type: "tool", id, name: "skill_search", arguments: { query: "table" } },
          }),
        ),
        { expect() {}, response: reply("Booked the table.") },
        {
          expect(request) {
            exchange = request;
          },
          response: { type: "text", text: "" },
        },
        {
          expect(request) {
            const said = turnsOf(exchange!.messages);
            const nudge = turnsOf(request.messages);
            expect(nudge.calls).toEqual(said.calls);
            expect(nudge.outputs).toEqual(said.outputs);
            expect(nudge.outputs.map(([id]) => id)).toEqual([...calls, "journey-reply"]);
            expect(nudge.texts.slice(0, -2)).toEqual([
              ...said.texts,
              ["assistant", "Booked the table."],
            ]);
            const [role, recap] = nudge.texts.at(-2)!;
            expect(role).toBe("user");
            const match = /<run_recap>\n(.*)\n<\/run_recap>/.exec(recap);
            expect(match).not.toBeNull();
            expect(JSON.parse(match![1]!)).toEqual({
              runId: expect.any(String),
              sessionId: expect.any(String),
              status: "completed",
              missingFacts: "absent",
            });
            expect(nudge.texts.at(-1)?.[1]).toContain("This task took many steps.");
          },
          response: { type: "text", text: "Nothing to keep." },
        },
      ],
      async ({ send, prisma }) => {
        const sent = await send("Book a table for two.");
        await sent.settled("completed");
        await expect
          .poll(
            async () =>
              (
                await prisma.event.findMany({
                  where: { runId: sent.runId, type: "agent.skill.nudge" },
                  orderBy: { seq: "asc" },
                })
              ).map((event) => (event.payload as { phase?: string }).phase),
            { timeout: 15_000, interval: 100 },
          )
          .toEqual(["decided", "ended"]);
      },
      { skillLearning: "on" },
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
      { agentRuntime: "scripted" },
    );
  }, 30_000);

  it("keeps a routine's steps out of the next person's history, which reads its start and its words", async () => {
    let routineTools: string[] = [];
    await journey(
      [
        { expect() {}, response: reply("Hello.", "journey-hello") },
        DONE,
        {
          expect(request) {
            routineTools = (request.tools ?? []).map((tool) => tool.function.name);
          },
          response: {
            type: "tool",
            id: "journey-routine-write",
            name: "write_file",
            arguments: { path: "notes/brief.txt", content: "brief" },
          },
        },
        { expect() {}, response: { type: "text", text: "Saved the brief." } },
        {
          expect(request) {
            const history = JSON.stringify(request.messages);
            expect(history).toContain('[context] The routine \\"Morning brief\\" started');
            expect(history).toContain("Saved the brief.");
            expect(history).not.toContain("journey-routine-write");
            expect(
              request.messages.flatMap((message) =>
                message.role === "tool" ? [message.tool_call_id] : [],
              ),
            ).toEqual([]);
            expect(history).toContain("Hello.");
          },
          response: reply("It is in notes/brief.txt.", "journey-where"),
        },
        DONE,
      ],
      async ({ app, cookie, bot, prisma, send, log }) => {
        await (await send("Hi.")).settled("completed");
        const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
          botId: bot.id,
          name: "Morning brief",
          prompt: "Save the brief.",
          webhookEnabled: true,
        });
        const { runId } = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
          routineId: routine.id,
        });
        await expect
          .poll(async () => (await prisma.run.findUnique({ where: { id: runId } }))?.status, {
            timeout: 15_000,
            interval: 100,
          })
          .toBe("completed");
        const asked = await send("Where is the brief?");
        await asked.settled("completed");

        const { sessionId: routineSessionId } = await prisma.run.findUniqueOrThrow({
          where: { id: runId },
        });
        const types = async (sessionId: string) =>
          (await log.readTail(sessionId as SessionId)).map((entry) => entry.type);
        expect(routineTools).toContain("write_file");
        expect(routineTools).not.toContain("message_user");
        const routineEntries = await log.readTail(routineSessionId as SessionId);
        expect(routineEntries.map((entry) => entry.type)).toEqual([
          "run.started",
          "tool.call",
          "tool.result",
          "assistant.text",
          "run.finished",
        ]);
        expect(
          routineEntries.flatMap((entry) =>
            entry.type === "tool.call" ? [payloadOf(entry).name] : [],
          ),
        ).toEqual(["write_file"]);
        expect(await types(asked.sessionId)).toEqual([
          "user.message",
          "assistant.text",
          "run.recap",
          "routine.started",
          "routine.finished",
          "user.message",
          "assistant.text",
          "run.recap",
        ]);
      },
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
        expect(cancelled.map((entry) => entry.type)).toEqual([
          "run.started",
          "run.recap",
          "run.finished",
        ]);
        expect(payloadOf(cancelled.find((entry) => entry.type === "run.finished"))).toMatchObject({
          status: "cancelled",
          by: userId,
        });
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

  it("stays silent on a peer's unsolicited result that holds nothing for the person", async () => {
    const closing = "The inbox check is empty, so there's nothing to send.";
    await peerJourney(
      {
        [PEER_INSTRUCTIONS]: [
          {
            type: "tool",
            id: "peer-result",
            name: "message_bot",
            arguments: {
              bot_id: "{bot}",
              intent: "result",
              message: "📬 Check inbox — Rien d'actionable ce matin.",
            },
          },
          reply("Sent."),
          { type: "text", text: "" },
        ],
        [BOT_INSTRUCTIONS]: [
          { type: "text", text: closing },
          { type: "text", text: closing },
        ],
      },
      async ({ askPeer, woken, wakePrompt }) => {
        await askPeer("Check the inbox.");
        expect(await woken()).toEqual([]);
        expect(await wakePrompt()).toContain(
          "This is a result Alfred sent on its own initiative, not an answer to something you asked.",
        );
      },
    );
  }, 30_000);

  it("relays a peer's unsolicited result once, without its closing remark", async () => {
    const relay = "Accor closed at 41.20 €, up 2.1% today.";
    await peerJourney(
      {
        [PEER_INSTRUCTIONS]: [
          {
            type: "tool",
            id: "peer-result",
            name: "message_bot",
            arguments: { bot_id: "{bot}", intent: "result", message: "Accor: 41.20 € (+2.1%)." },
          },
          reply("Sent."),
          { type: "text", text: "" },
        ],
        [BOT_INSTRUCTIONS]: [
          reply(relay),
          { type: "text", text: "The Accor update is already with Romain. Nothing else to send." },
        ],
      },
      async ({ askPeer, woken }) => {
        await askPeer("Watch Accor.");
        expect(await woken()).toEqual([relay]);
      },
    );
  }, 30_000);

  it("still relays the answer to its own request when the bot says nothing", async () => {
    await peerJourney(
      {
        [BOT_INSTRUCTIONS]: [
          {
            type: "tool",
            id: "bot-request",
            name: "message_bot",
            arguments: { bot_id: "{peer}", intent: "request", message: "Check the inbox." },
          },
          reply("Asked Alfred."),
          { type: "text", text: "" },
          { type: "text", text: "" },
        ],
        [PEER_INSTRUCTIONS]: [{ type: "text", text: "Two invoices are due Friday." }],
      },
      async ({ send, woken, wakePrompt }) => {
        await (await send("Ask Alfred to check the inbox.")).settled("completed");
        expect(await woken()).toEqual(["Update from Alfred: Two invoices are due Friday."]);
        expect(await wakePrompt()).toContain("This is a result for work you delegated.");
      },
    );
  }, 30_000);
});

const BOT_INSTRUCTIONS = "Complete the task.";
const PEER_INSTRUCTIONS = "You are Alfred. Watch the inbox.";

/**
 * The journey with a second bot, Alfred, beside the fixture bot. Their runs interleave, so each
 * model request is answered from the script of the bot whose instructions it carries; `{bot}` and
 * `{peer}` in a tool's arguments become the two bot ids. `woken` waits for the fixture bot's run
 * that a delivery from Alfred started and returns the text that run showed the person;
 * `wakePrompt` returns the task that delivery queued for it.
 */
async function peerJourney(
  scripts: Record<string, ModelEmulatorResponse[]>,
  drive: (fixture: {
    send: JourneyFixture["send"];
    askPeer: (text: string) => Promise<void>;
    woken: () => Promise<string[]>;
    wakePrompt: () => Promise<string>;
  }) => Promise<void>,
) {
  const ids: Record<string, string> = {};
  const withIds = (response: ModelEmulatorResponse): ModelEmulatorResponse =>
    response.type === "tool"
      ? {
          ...response,
          arguments: JSON.parse(
            JSON.stringify(response.arguments).replace(/\{(bot|peer)\}/g, (_, key) => ids[key]!),
          ),
        }
      : response;
  const steps = Object.values(scripts)
    .flat()
    .map(
      (): ModelEmulatorStep => ({
        expect() {},
        response(request) {
          const system = JSON.stringify(request.messages.find((m) => m.role === "system"));
          const script = Object.entries(scripts).find(([marker]) => system.includes(marker))?.[1];
          const next = script?.shift();
          if (!next) throw new Error("A model request no bot script answers");
          return withIds(next);
        },
      }),
    );
  await journey(steps, async ({ app, cookie, bot, prisma, log, send }) => {
    const peer = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Alfred",
      title: "",
      description: "",
      instructions: PEER_INSTRUCTIONS,
      notifyOnFinish: false,
    });
    const { modelProvider, modelId } = await prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
    });
    await rpc(app, cookie, "bots/update", { botId: peer.id, modelProvider, modelId });
    ids.bot = bot.id;
    ids.peer = peer.id;
    const settledRun = async (where: { botId: string; trigger: string }) => {
      await expect
        .poll(async () => (await prisma.run.findFirst({ where }))?.status, {
          timeout: 15_000,
          interval: 100,
        })
        .toBe("completed");
      return prisma.run.findFirstOrThrow({ where });
    };
    await drive({
      send,
      async askPeer(text) {
        await rpc(app, cookie, "threads/send", { botId: peer.id, text });
        await settledRun({ botId: peer.id, trigger: "user" });
      },
      async woken() {
        const run = await settledRun({ botId: bot.id, trigger: "bot_message" });
        return (await log.readRun(run.id)).flatMap((entry) =>
          entry.type === "assistant.text"
            ? entry.payload.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []))
            : [],
        );
      },
      async wakePrompt() {
        const { task } = await prisma.run.findFirstOrThrow({
          where: { botId: bot.id, trigger: "bot_message" },
          include: { task: true },
        });
        return task.prompt;
      },
    });
  });
  expect(Object.values(scripts).flat()).toEqual([]);
}

const EDITED_INSTRUCTIONS = "You are Scout. Focus on venues.";
const DELEGATE = {
  type: "tool",
  id: "journey-delegate",
  name: "run_subagent",
  arguments: { name: "checker", task: "Say checked." },
} as const;

/** What the model tells the person, which only message_user carries. */
function reply(message: string, id = "journey-reply") {
  return { type: "tool", id, name: "message_user", arguments: { message } } as const;
}

/** The model's turn after its message_user call, with nothing left to say. */
const DONE: ModelEmulatorStep = { expect() {}, response: { type: "text", text: "" } };

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
  const card = await latestCard(prisma, sent.runId);
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

function turnsOf(messages: ModelEmulatorRequest["messages"]) {
  const textOf = (content: unknown) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: { text?: string }) => part.text ?? "").join("")
        : "";
  const conversation = messages.filter((message) => message.role !== "system");
  return {
    texts: conversation.flatMap((message) =>
      message.role !== "tool" && textOf(message.content)
        ? [[message.role, textOf(message.content)]]
        : [],
    ),
    calls: conversation.flatMap((message) =>
      (message.tool_calls ?? []).map((call) => [
        call.id,
        call.function.name,
        call.function.arguments,
      ]),
    ),
    // A live result and a replayed one are the same JSON, printed differently.
    outputs: conversation.flatMap((message) =>
      message.role === "tool" ? [[message.tool_call_id, JSON.parse(textOf(message.content))]] : [],
    ),
  };
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
    options?: {
      replyToMessageId?: string;
      replyQuote?: string;
      clientNonce?: string;
      draft?: { messageId: string; text: string };
    },
  ) => Promise<{
    runId: string;
    sessionId: SessionId;
    executionSessionId: () => Promise<SessionId>;
    settled: (status: string) => Promise<void>;
  }>;
};

async function journey(
  steps: ModelEmulatorStep[],
  drive: (fixture: JourneyFixture) => Promise<void>,
  app: Pick<
    NonNullable<Parameters<typeof createApp>[0]>,
    "agentRuntime" | "skillLearning" | "composio"
  > = {},
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
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "offline-model-fixture-encryption-key",
      ...app,
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
          async executionSessionId() {
            const run = await handles.prisma.run.findUniqueOrThrow({
              where: { id: sent.runId },
              select: { sessionId: true },
            });
            return SessionIdSchema.parse(run.sessionId);
          },
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
