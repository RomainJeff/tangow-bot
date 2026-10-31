import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { afterEach, expect, it } from "vitest";
import { catalogEntries, lazyCatalogTools } from "../../adapters/src/lazy-tool-catalog.js";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { prepares } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("restores a native call and the user's answer in a new child process without repeating the original prompt", async () => {
  let resumed: ModelEmulatorRequest | undefined;
  const run = await startWorkerRun({
    mode: "child",
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "question-native",
          name: "ask_user",
          arguments: { message: "Which city?", options: ["Paris", "Lyon"] },
        },
      },
      {
        expect(request) {
          resumed = request;
        },
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Paris selected." },
        },
      },
      { expect() {}, response: { type: "text", text: "" } },
    ],
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Choose a city for my trip.");
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "waiting_input",
  );
  const card = await latestCard(run.prisma, runId);
  await run.events.answerRunInput({
    spaceId: run.spaceId,
    threadId: run.thread.id,
    runId,
    messageId: card.id,
    answeredByUserId: run.userId,
    answer: "choice-1",
  });
  expect(await run.send("Also include travel dates.")).toBe(runId);
  await run.restart().dispose();
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).error).toBe(null);
  run.model.assertComplete();
  expect(JSON.stringify(resumed?.messages).split("Also include travel dates.")).toHaveLength(2);
  expect(
    resumed?.messages.filter((message) =>
      JSON.stringify(message.content).includes("Choose a city for my trip."),
    ),
  ).toHaveLength(1);
  expect(resumed?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "question-native",
        content: expect.stringContaining("Paris"),
      }),
    ]),
  );
});

it("keeps repeated provider call ids distinct across turns and resumes the right pending call", async () => {
  let resumed: ModelEmulatorRequest | undefined;
  const run = await startWorkerRun({
    mode: "child",
    steps: [
      ...["First note", "Second note"].map((title) => ({
        expect() {},
        response: {
          type: "tool" as const,
          id: "call_0",
          name: "scratchpad_add",
          arguments: { title },
        },
      })),
      {
        expect() {},
        response: {
          type: "tool",
          id: "call_0",
          name: "ask_user",
          arguments: { message: "Which city?", options: ["Paris", "Lyon"] },
        },
      },
      {
        expect(request) {
          resumed = request;
        },
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Paris selected." },
        },
      },
      { expect() {}, response: { type: "text", text: "" } },
    ],
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Save both notes and ask me which city.");
  await run.continueRun(runId);
  expect(
    await run.prisma.scratchpadItem.findMany({
      where: { botId: run.bot.id },
      select: { title: true },
      orderBy: { title: "asc" },
    }),
  ).toEqual([{ title: "First note" }, { title: "Second note" }]);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "waiting_input",
  );
  const card = await latestCard(run.prisma, runId);
  await run.events.answerRunInput({
    spaceId: run.spaceId,
    threadId: run.thread.id,
    runId,
    messageId: card.id,
    answeredByUserId: run.userId,
    answer: "choice-1",
  });
  await run.restart().dispose();
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).error).toBe(null);
  expect(
    resumed?.messages
      .filter((message) => message.role === "tool" && message.tool_call_id === "call_0")
      .at(-1)?.content,
  ).toContain("Paris");
  expect(await run.prisma.scratchpadItem.count({ where: { botId: run.bot.id } })).toBe(2);
  run.model.assertComplete();
});

it("keeps an uncalled loaded tool and a full parallel result receipt across a child restart", async () => {
  const payload = "x".repeat(6000);
  const invoked: string[] = [];
  const tools: ConnectorProvider = {
    describe: () => ({
      id: "fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    }),
    discoverTools: async () => [
      {
        name: "read_long",
        description: "Read data",
        readOnly: true,
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        route: { connectorId: "fixture", toolName: "read_long" },
      },
      ...lazyCatalogTools(
        "fixture",
        "fixture",
        "Fixture",
        catalogEntries(
          Array.from({ length: 30 }, (_, index) => ({
            name: `utility_${index}`,
            description: `Utility ${index}`,
            readOnly: true,
            inputSchema: { type: "object", properties: {} },
            route: { connectorId: "fixture", resourceId: "catalog", toolName: `utility_${index}` },
          })),
        ),
      ),
    ],
    async *execute(call) {
      invoked.push(call.tool);
      yield { type: "result", data: { text: payload } };
    },
  };
  let resumed: ModelEmulatorRequest | undefined;
  const run = await startWorkerRun({
    mode: "child",
    tools,
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "load",
          name: "tool_search",
          arguments: { query: "utility_29", limit: 1 },
        },
      },
      {
        expect(request) {
          expect(request.tools?.map((tool) => tool.function.name)).toContain(
            "mcp__rakazo__utility_29",
          );
        },
        response: {
          type: "tool",
          id: "large-native",
          name: "read_long",
          arguments: { query: payload },
          siblings: [
            {
              id: "ask-native",
              name: "ask_user",
              arguments: { message: "Which city?", options: ["Paris", "Lyon"] },
            },
          ],
        },
      },
      {
        expect(request) {
          resumed = request;
        },
        response: { type: "tool", id: "loaded-first", name: "utility_29", arguments: {} },
      },
      {
        expect() {},
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Done." },
        },
      },
      { expect() {}, response: { type: "text", text: "" } },
    ],
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Read the data, then ask me for the city.");
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "waiting_input",
  );
  const card = await latestCard(run.prisma, runId);
  await run.events.answerRunInput({
    spaceId: run.spaceId,
    threadId: run.thread.id,
    runId,
    messageId: card.id,
    answeredByUserId: run.userId,
    answer: "choice-1",
  });
  await run.restart().dispose();
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).error).toBe(null);
  run.model.assertComplete();
  expect(resumed?.tools?.map((tool) => tool.function.name)).toContain("mcp__rakazo__utility_29");
  expect(resumed?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "large-native",
        content: expect.stringContaining(payload),
      }),
    ]),
  );
  expect(invoked.filter((name) => name === "read_long")).toHaveLength(1);
});

function publisher() {
  const published: unknown[] = [];
  const tools: ConnectorProvider = {
    describe: () => ({
      id: "notes",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    }),
    discoverTools: async () => [
      {
        name: "publish_note",
        description: "Publish",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
        route: { connectorId: "notes", resourceId: "notes-server", toolName: "publish_note" },
      },
    ],
    async *execute(call) {
      published.push(call.args);
      yield { type: "result", data: { published: "Plan" } };
    },
  };
  return { published, tools };
}

it.each(["valid", "corrupt", "incompatible", "missing"])(
  "validates %s native state before applying an approval",
  async (state) => {
    const notes = publisher();
    let resumed: ModelEmulatorRequest | undefined;
    const run = await startWorkerRun({
      mode: "child",
      tools: notes.tools,
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "approved-native",
            name: "publish_note",
            arguments: { title: "Plan" },
          },
        },
        prepares(),
        ...(state === "valid"
          ? [
              {
                expect(request: ModelEmulatorRequest) {
                  resumed = request;
                },
                response: {
                  type: "tool" as const,
                  id: "say",
                  name: "message_user",
                  arguments: { message: "Published." },
                },
              },
              { expect() {}, response: { type: "text" as const, text: "" } },
            ]
          : []),
      ],
    });
    cleanups.push(() => run.close());
    await run.prisma.actionApprovalRule.create({
      data: {
        spaceId: run.spaceId,
        createdByUserId: run.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "publish_note",
      },
    });
    const runId = await run.send("Publish the plan.");
    await run.continueRun(runId);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "waiting_input",
    );
    const card = await latestCard(run.prisma, runId);
    await run.events.answerRunInput({
      spaceId: run.spaceId,
      threadId: run.thread.id,
      runId,
      messageId: card.id,
      answeredByUserId: run.userId,
      answer: "allow",
    });
    if (state === "corrupt")
      await run.prisma
        .$executeRaw`UPDATE run_snapshots SET snapshot = jsonb_set(snapshot, '{state}', '"broken"') WHERE "runId" = ${runId}`;
    if (state === "incompatible")
      await run.prisma
        .$executeRaw`UPDATE run_snapshots SET snapshot = jsonb_set(snapshot, '{harness,format}', '"future-format"') WHERE "runId" = ${runId}`;
    if (state === "missing")
      await run.prisma.$executeRaw`DELETE FROM run_snapshots WHERE "runId" = ${runId}`;
    await run.restart().dispose();
    await run.continueRun(runId).catch(() => undefined);
    const finished = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    if (state === "valid") {
      expect(finished.status).toBe("completed");
      expect(notes.published).toEqual([{ title: "Plan" }]);
      expect(resumed?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "approved-native",
            content: expect.stringContaining("Plan"),
          }),
        ]),
      );
      await run.continueRun(runId);
      expect(notes.published).toHaveLength(1);
    } else {
      expect(notes.published).toEqual([]);
      expect(finished.error).not.toBe(null);
    }
    run.model.assertComplete();
  },
);

it("resumes a native takeover at its original call after the user releases the computer", async () => {
  let resumed: ModelEmulatorRequest | undefined;
  const run = await startWorkerRun({
    mode: "child",
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "takeover-native",
          name: "request_takeover",
          arguments: { reason: "Log in", resume: "The user finished the login." },
        },
      },
      {
        expect(request) {
          resumed = request;
        },
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Continuing." },
        },
      },
      { expect() {}, response: { type: "text", text: "" } },
    ],
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Log in for me.");
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "waiting_takeover",
  );
  const computerId = run.bot.computerId!;
  await run.prisma.computer.update({
    where: { id: computerId },
    data: {
      controlHolder: "user",
      controlLeaseId: "lease-hand",
      controlLeaseExpiresAt: new Date(Date.now() + 60000),
      controlBotId: run.bot.id,
      controlRunId: runId,
    },
  });
  await run.events.finalizeComputerControlRelease({
    spaceId: run.spaceId,
    computerId,
    botId: run.bot.id,
    runId,
    leaseId: "lease-hand",
    holder: "bot",
    reason: "done",
  });
  await run.restart().dispose();
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).error).toBe(null);
  run.model.assertComplete();
  expect(resumed?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "takeover-native",
        content: expect.stringContaining("finished the login"),
      }),
    ]),
  );
});

it.each(["allow", "deny", "corrupt", "retry", "helper"] as const)(
  "resumes a message draft after %s without sending twice or losing its native result",
  async (answer) => {
    const sent: unknown[] = [];
    let refused = false;
    const tools: ConnectorProvider = {
      describe: () => ({
        id: "mail",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { discover: true, oauth: false, secretsBrokered: true },
      }),
      discoverTools: async () => [
        {
          name: "GMAIL_SEND_EMAIL",
          description: "Send email",
          inputSchema: {
            type: "object",
            properties: {
              recipient_email: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" },
            },
          },
          route: { connectorId: "mail", toolName: "GMAIL_SEND_EMAIL" },
        },
      ],
      async *execute(call) {
        if (answer === "retry" && !refused) {
          refused = true;
          yield { type: "error", message: "App refused the send", details: { successful: false } };
          return;
        }
        sent.push(call.args);
        yield { type: "result", data: { sent: true } };
      },
    };
    let resumed: ModelEmulatorRequest | undefined;
    const run = await startWorkerRun({
      mode: "child",
      tools,
      steps: [
        ...(answer === "helper"
          ? [
              {
                expect() {},
                response: {
                  type: "tool" as const,
                  id: "helper-native",
                  name: "run_subagent",
                  arguments: { category: "everyday", name: "mailer", task: "Prepare the email." },
                },
              },
            ]
          : []),
        {
          expect() {},
          response: {
            type: "tool",
            id: "draft-native",
            name: "GMAIL_SEND_EMAIL",
            arguments: {
              recipient_email: "anna@example.test",
              subject: "Hello",
              body: "Original.",
            },
          },
        },
        prepares({
          card: "mail",
          recipients: [
            {
              role: "to",
              path: ["recipient_email"],
              shape: "one",
              addresses: ["anna@example.test"],
            },
          ],
          subject: { path: ["subject"], value: "Hello" },
          body: { path: ["body"], value: "Original." },
          unshown: [],
        }),
        ...(answer === "corrupt"
          ? []
          : [
              {
                expect(request: ModelEmulatorRequest) {
                  resumed = request;
                },
                response: {
                  type: "tool" as const,
                  id: "say",
                  name: "message_user",
                  arguments: { message: "Continuing." },
                },
              },
              { expect() {}, response: { type: "text" as const, text: "" } },
            ]),
      ],
    });
    cleanups.push(() => run.close());
    const runId = await run.send("Prepare an email to Anna.");
    await run.continueRun(runId);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "waiting_input",
    );
    const card = await latestCard(run.prisma, runId);
    expect(card.block.draft?.body).toBe("Original.");
    await run.events.answerRunInput({
      spaceId: run.spaceId,
      threadId: run.thread.id,
      runId,
      messageId: card.id,
      answeredByUserId: run.userId,
      answer: answer === "deny" ? "deny" : "allow",
      ...(answer === "deny" ? {} : { edits: { text: "Edited." } }),
    });
    if (answer === "corrupt")
      await run.prisma
        .$executeRaw`UPDATE run_snapshots SET snapshot = jsonb_set(snapshot, '{state}', '"broken"') WHERE "runId" = ${runId}`;
    await run.restart().dispose();
    await run.continueRun(runId).catch(() => undefined);
    if (answer === "retry") {
      expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
        "waiting_input",
      );
      const retryCard = await latestCard(run.prisma, runId);
      await run.events.answerRunInput({
        spaceId: run.spaceId,
        threadId: run.thread.id,
        runId,
        messageId: retryCard.id,
        answeredByUserId: run.userId,
        answer: "allow",
      });
      await run.restart().dispose();
      await run.continueRun(runId).catch(() => undefined);
    }
    const finished = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    if (answer === "corrupt") {
      expect(finished.error).not.toBe(null);
      expect(sent).toEqual([]);
    } else {
      expect(finished.error).toBe(null);
      expect(finished.status).toBe("completed");
      expect(resumed?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: answer === "helper" ? "helper-native" : "draft-native",
            content: expect.stringContaining(
              answer !== "deny" ? "The user sent this message" : "The user discarded this draft",
            ),
          }),
        ]),
      );
      if (answer !== "deny") {
        expect(sent).toEqual([
          {
            recipient_email: "anna@example.test",
            subject: "Hello",
            body: "Edited.",
          },
        ]);
        expect(JSON.stringify(resumed?.messages)).toContain("Edited.");
      } else expect(sent).toEqual([]);
      await run.continueRun(runId);
      expect(sent).toHaveLength(answer !== "deny" ? 1 : 0);
    }
    run.model.assertComplete();
  },
);
