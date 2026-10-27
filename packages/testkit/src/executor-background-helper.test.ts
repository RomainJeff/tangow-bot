import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { HARNESSES } from "@rakazo/agent-run-worker";
import { createRepos } from "@rakazo/db";
import { afterEach, expect, it } from "vitest";
import { stopThreadRuns } from "../../../apps/api/src/thread-target.js";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const BRIEF = "Find a hotel in Alfama.";
const REPORT = "Hotel Alfama Patio, 120 EUR a night.";
const recap = JSON.stringify({ version: 1, results: ["Answered"], references: [] });
const say = (message: string) => ({
  type: "tool" as const,
  id: `say-${message.length}`,
  name: "message_user",
  arguments: { message },
});
const spawn: ModelEmulatorStep = {
  expect() {},
  response: {
    type: "tool",
    id: "spawn",
    name: "run_subagent",
    arguments: { name: "Scout", task: BRIEF, background: true },
  },
};
const text = (request: ModelEmulatorRequest) => JSON.stringify(request.messages);
const userTurns = (request: ModelEmulatorRequest) =>
  request.messages.filter((message) => message.role === "user").map((message) => message.content);

/** A connector tool every call of which needs the user's approval. */
function approvedNotes() {
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
        description: "Publish a note",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
        route: { connectorId: "notes", resourceId: "notes-server", toolName: "publish_note" },
      },
    ],
    async *execute(call) {
      published.push(call.args);
      yield { type: "result", data: { published: call.args.title } };
    },
  };
  return { tools, published };
}
const publish: ModelEmulatorStep = {
  expect() {},
  response: { type: "tool", id: "publish", name: "publish_note", arguments: { title: "Plan" } },
};

async function fixture(steps: ModelEmulatorStep[], tools?: ConnectorProvider) {
  const run = await startWorkerRun({
    harness: HARNESSES["pi-native"],
    computerScope: "none",
    steps,
    ...(tools ? { tools } : {}),
  });
  cleanups.push(() => run.close());
  if (tools) {
    await run.prisma.actionApprovalRule.create({
      data: {
        spaceId: run.spaceId,
        createdByUserId: run.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "publish_note",
      },
    });
  }
  const runs = () =>
    run.prisma.run.findMany({
      where: { threadId: run.thread.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, trigger: true, status: true, parentRunId: true, sourceMessageId: true },
    });
  const reports = async () =>
    (
      await run.prisma.sessionEntry.findMany({
        where: { type: "helper.report" },
        orderBy: { seq: "asc" },
        select: { payload: true, sessionId: true },
      })
    ).map((entry) => entry.payload);
  const childOf = (parentRunId: string) =>
    run.prisma.run.findFirstOrThrow({ where: { parentRunId } });
  const botStatus = async () => {
    const [bot] = await createRepos(run.prisma).listBots({
      userId: run.userId,
      spaceId: run.spaceId,
      email: "worker@rakazo.test",
      isDeploymentOwner: false,
    });
    return bot?.status;
  };
  return { run, runs, reports, childOf, botStatus };
}

it("answers at once, keeps the helper running past the turn, and wakes the bot with its report", async () => {
  const parentWaits = Promise.withResolvers<void>();
  const childAsked = Promise.withResolvers<ModelEmulatorRequest>();
  const releaseChild = Promise.withResolvers<void>();
  const { run, runs, reports, childOf, botStatus } = await fixture([
    spawn,
    {
      async expect(request) {
        expect(text(request)).toContain("helperId");
        parentWaits.resolve();
        await childAsked.promise;
      },
      response: say("I've started that, I'll come back with it."),
    },
    {
      async expect(request) {
        childAsked.resolve(request);
        await releaseChild.promise;
      },
      response: { type: "text", text: REPORT },
    },
    { expect() {}, response: { type: "text", text: recap } },
    {
      expect(request) {
        expect(text(request)).toContain("<helper_report>");
        expect(text(request)).toContain(REPORT);
      },
      response: say(`Found it: ${REPORT}`),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  const parentDone = run.continueRun(parentId);
  await parentWaits.promise;
  expect(await botStatus()).toBe("running");
  const child = await childOf(parentId);
  const childDone = run.continueRun(child.id);
  const childRequest = await childAsked.promise;
  await parentDone;

  expect(await runs()).toMatchObject([
    { id: parentId, trigger: "user", status: "completed" },
    { id: child.id, trigger: "helper", status: "running", parentRunId: parentId },
  ]);
  expect(await botStatus()).toBe("idle");
  expect(userTurns(childRequest)).toEqual([[{ type: "text", text: BRIEF }]]);
  const childTools = childRequest.tools?.map((tool) => tool.function.name) ?? [];
  expect(childTools).not.toContain("mcp__rakazo__run_subagent");
  expect(childTools).not.toContain("mcp__rakazo__message_user");

  releaseChild.resolve();
  await childDone;
  expect(await reports()).toEqual([
    { helperId: child.id, profile: null, status: "completed", report: REPORT },
  ]);
  const [, , woken] = await runs();
  expect(woken).toMatchObject({ trigger: "follow_up", status: "queued", sourceMessageId: null });
  await run.continueRun(woken!.id);
  run.model.assertComplete();

  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "completed"],
    ["follow_up", "completed"],
  ]);
  const parentEntries = await run.runEntries(parentId);
  const call = parentEntries.find(
    (entry) => entry.type === "tool.call" && entry.payload.name === "run_subagent",
  );
  expect(
    parentEntries.find(
      (entry) =>
        entry.type === "tool.result" &&
        call?.type === "tool.call" &&
        entry.payload.callId === call.payload.callId,
    )?.payload,
  ).toMatchObject({ output: `{\n  "helperId": "${child.id}"\n}`, sessionId: child.sessionId });
  const childEntries = await run.runEntries(child.id);
  expect(childEntries.find((entry) => entry.type === "run.started")?.payload).toMatchObject({
    trigger: { kind: "subagent", entryId: call?.id },
  });
  expect(
    childEntries.flatMap((entry) =>
      entry.type === "assistant.text"
        ? [{ sessionId: entry.sessionId, blocks: entry.payload.blocks }]
        : [],
    ),
  ).toEqual([{ sessionId: child.sessionId, blocks: [{ kind: "text", text: REPORT }] }]);
  expect(
    (
      await run.prisma.event.findMany({
        where: { threadId: run.thread.id, type: { startsWith: "run." } },
        orderBy: { seq: "asc" },
      })
    ).map((event) => [event.runId, event.type]),
  ).toEqual([
    [parentId, "run.started"],
    [parentId, "run.completed"],
    [woken!.id, "run.started"],
    [woken!.id, "run.completed"],
  ]);
});

/** The bot starts a background helper, tells the user, and ends its turn. */
const startedTurn: ModelEmulatorStep[] = [
  spawn,
  { expect() {}, response: say("I've started that.") },
  { expect() {}, response: { type: "text", text: recap } },
];

it("wakes the bot once, after its turn, for a report that lands during it", async () => {
  const parentWaits = Promise.withResolvers<void>();
  const childEnded = Promise.withResolvers<void>();
  const { run, runs, childOf } = await fixture([
    spawn,
    {
      async expect() {
        parentWaits.resolve();
        await childEnded.promise;
      },
      response: say("I've started that."),
    },
    { expect() {}, response: { type: "text", text: REPORT } },
    { expect() {}, response: { type: "text", text: recap } },
    {
      expect(request) {
        expect(text(request)).toContain(REPORT);
      },
      response: say(`Found it: ${REPORT}`),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  const parentDone = run.continueRun(parentId);
  await parentWaits.promise;
  await run.continueRun((await childOf(parentId)).id);
  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "running"],
    ["helper", "completed"],
  ]);
  childEnded.resolve();
  await parentDone;
  const [, , woken, ...rest] = await runs();
  expect([woken?.trigger, woken?.status, rest]).toEqual(["follow_up", "queued", []]);
  await run.continueRun(woken!.id);
  run.model.assertComplete();
  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "completed"],
    ["follow_up", "completed"],
  ]);
});

it("wakes the bot for each of two reports, never losing or doubling one", async () => {
  const parentWaits = Promise.withResolvers<void>();
  const firstEnded = Promise.withResolvers<void>();
  const secondAsked = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const wokenWaits = Promise.withResolvers<void>();
  const secondEnded = Promise.withResolvers<void>();
  const { run, runs } = await fixture([
    {
      expect() {},
      response: {
        type: "tool",
        id: "spawn-hotel",
        name: "run_subagent",
        arguments: { name: "Hotels", task: BRIEF, background: true },
        siblings: [
          {
            id: "spawn-train",
            name: "run_subagent",
            arguments: { name: "Trains", task: "Find a train to Porto.", background: true },
          },
        ],
      },
    },
    {
      async expect() {
        parentWaits.resolve();
        await firstEnded.promise;
      },
      response: say("I've started both."),
    },
    { expect() {}, response: { type: "text", text: REPORT } },
    {
      async expect() {
        secondAsked.resolve();
        await releaseSecond.promise;
      },
      response: { type: "text", text: "The 9:00 train, 30 EUR." },
    },
    { expect() {}, response: { type: "text", text: recap } },
    {
      async expect(request) {
        expect(text(request)).toContain(REPORT);
        expect(text(request)).not.toContain("The 9:00 train");
        wokenWaits.resolve();
        await secondEnded.promise;
      },
      response: say(`Hotel: ${REPORT}`),
    },
    { expect() {}, response: { type: "text", text: recap } },
    {
      expect(request) {
        expect(text(request)).toContain("The 9:00 train, 30 EUR.");
      },
      response: say("Train: the 9:00, 30 EUR."),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Plan my trip to Porto.");
  const parentDone = run.continueRun(parentId);
  await parentWaits.promise;
  const [hotels, trains] = await run.prisma.run.findMany({
    where: { parentRunId: parentId },
    orderBy: { task: { prompt: "asc" } },
  });
  await run.continueRun(hotels!.id);
  const trainsDone = run.continueRun(trains!.id);
  await secondAsked.promise;
  firstEnded.resolve();
  await parentDone;
  const [, , , firstWake] = await runs();
  expect([firstWake?.trigger, firstWake?.status]).toEqual(["follow_up", "queued"]);
  const firstWakeDone = run.continueRun(firstWake!.id);
  await wokenWaits.promise;
  releaseSecond.resolve();
  await trainsDone;
  expect(await run.prisma.run.count({ where: { trigger: "follow_up" } })).toBe(1);
  secondEnded.resolve();
  await firstWakeDone;
  const [, , , , secondWake, ...rest] = await runs();
  expect([secondWake?.trigger, secondWake?.status, rest]).toEqual(["follow_up", "queued", []]);
  await run.continueRun(secondWake!.id);
  run.model.assertComplete();
  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "completed"],
    ["helper", "completed"],
    ["follow_up", "completed"],
    ["follow_up", "completed"],
  ]);
});

it("starts a user turn for a message sent during the helper, which the helper never reads", async () => {
  const childAsked = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const { run, runs, childOf } = await fixture([
    ...startedTurn,
    {
      async expect() {
        childAsked.resolve();
        await releaseChild.promise;
      },
      response: { type: "tool", id: "look", name: "search_runs", arguments: { query: "hotel" } },
    },
    {
      expect(request) {
        expect(text(request)).not.toContain("Also check trains.");
      },
      response: { type: "text", text: REPORT },
    },
    {
      expect(request) {
        expect(text(request)).toContain("Also check trains.");
        expect(text(request)).toContain(REPORT);
      },
      response: say("Trains run every hour."),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  await run.continueRun(parentId);
  const child = await childOf(parentId);
  const childDone = run.continueRun(child.id);
  await childAsked.promise;
  const userRunId = await run.send("Also check trains.");
  expect(await run.prisma.steeringMessage.count()).toBe(0);
  releaseChild.resolve();
  await childDone;
  await run.continueRun(userRunId);
  run.model.assertComplete();

  expect((await runs()).map(({ id, trigger, status }) => [id, trigger, status])).toEqual([
    [parentId, "user", "completed"],
    [child.id, "helper", "completed"],
    [userRunId, "user", "completed"],
  ]);
});

it("writes no report and wakes no one for a helper the user stopped", async () => {
  const childAsked = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const { run, runs, reports, childOf } = await fixture([
    ...startedTurn,
    {
      async expect() {
        childAsked.resolve();
        await releaseChild.promise;
      },
      response: { type: "text", text: REPORT },
    },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  await run.continueRun(parentId);
  const childDone = run.continueRun((await childOf(parentId)).id);
  await childAsked.promise;
  await stopThreadRuns(
    run,
    { spaceId: run.spaceId, userId: run.userId },
    { kind: "bot", botId: run.bot.id, threadId: run.thread.id, bot: run.bot },
  );
  releaseChild.resolve();
  await childDone;

  expect(await reports()).toEqual([]);
  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "cancelled"],
  ]);
});

it("fails a helper whose profile is gone and wakes the bot with why", async () => {
  const { run, runs, reports, childOf } = await fixture([
    ...startedTurn,
    {
      expect(request) {
        expect(text(request)).toContain(
          'Unknown helper \\\\\\"ghost\\\\\\". Available helpers: none',
        );
      },
      response: say("The helper could not start."),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  await run.continueRun(parentId);
  const child = await childOf(parentId);
  await run.prisma.run.update({ where: { id: child.id }, data: { helper: "ghost" } });
  await run.continueRun(child.id);

  expect(await reports()).toEqual([
    {
      helperId: child.id,
      profile: "ghost",
      status: "failed",
      report: 'Unknown helper "ghost". Available helpers: none',
    },
  ]);
  const [, , woken] = await runs();
  await run.continueRun(woken!.id);
  run.model.assertComplete();
  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "failed"],
    ["follow_up", "completed"],
  ]);
});

it("runs the helper on its call's whole instructions, and on the default brief without a task", async () => {
  const rule = `Answer in French. ${"Keep it short. ".repeat(300)}Sign as Scout.`;
  const childAsked = Promise.withResolvers<ModelEmulatorRequest>();
  const { run, childOf } = await fixture([
    {
      expect() {},
      response: {
        type: "tool",
        id: "spawn",
        name: "run_subagent",
        arguments: { name: "Scout", task: "", instructions: rule, background: true },
      },
    },
    { expect() {}, response: say("I've started that.") },
    { expect() {}, response: { type: "text", text: recap } },
    {
      expect(request) {
        childAsked.resolve(request);
      },
      response: { type: "text", text: REPORT },
    },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  await run.continueRun(parentId);
  await run.continueRun((await childOf(parentId)).id);

  const request = await childAsked.promise;
  expect(userTurns(request)).toEqual([[{ type: "text", text: "Complete the delegated task." }]]);
  const instructions = JSON.stringify(
    request.messages.filter((message) => message.role !== "user"),
  );
  expect(instructions).toContain('You are a Rakazo subagent named \\"Scout\\".');
  expect(instructions).toContain("Sign as Scout.");
});

it("never hands the user's steering to a helper running beside the bot's turn", async () => {
  const childAsked = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const childEnded = Promise.withResolvers<void>();
  const { run, runs, childOf } = await fixture([
    spawn,
    {
      async expect() {
        childAsked.resolve();
        await childEnded.promise;
      },
      response: say("I've started that."),
    },
    {
      async expect() {
        await releaseChild.promise;
      },
      response: { type: "tool", id: "look", name: "search_runs", arguments: { query: "hotel" } },
    },
    {
      expect(request) {
        expect(text(request)).not.toContain("Also check trains.");
      },
      response: { type: "text", text: REPORT },
    },
    {
      expect(request) {
        expect(text(request)).toContain("Also check trains.");
      },
      response: say("I'll check trains too."),
    },
    { expect() {}, response: { type: "text", text: recap } },
    {
      expect(request) {
        expect(text(request)).toContain(REPORT);
      },
      response: say(`Found it: ${REPORT}`),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  const parentDone = run.continueRun(parentId);
  await childAsked.promise;
  const child = await childOf(parentId);
  const childDone = run.continueRun(child.id);
  expect(await run.send("Also check trains.")).toBe(parentId);
  releaseChild.resolve();
  await childDone;
  childEnded.resolve();
  await parentDone;
  const [, , woken] = await runs();
  await run.continueRun(woken!.id);
  run.model.assertComplete();

  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "completed"],
    ["follow_up", "completed"],
  ]);
});

it("wakes the bot at once for a report that lands while a webhook run works, and only once", async () => {
  const { run, runs, childOf } = await fixture([
    ...startedTurn,
    { expect() {}, response: { type: "text", text: REPORT } },
    {
      expect(request) {
        expect(text(request)).toContain(REPORT);
      },
      response: say(`Found it: ${REPORT}`),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  await run.continueRun(parentId);
  const routine = await run.prisma.routine.create({
    data: {
      spaceId: run.spaceId,
      botId: run.bot.id,
      userId: run.userId,
      threadId: run.thread.id,
      name: "Deploys",
      prompt: "Summarize the deploy.",
      crons: [],
      webhookEnabled: true,
    },
  });
  const {
    runIds: [webhookId],
  } = await run.events.startInboundRoutineRuns({
    spaceId: run.spaceId,
    threadId: run.thread.id,
    botId: run.bot.id,
    userId: run.userId,
    runs: [{ routineId: routine.id, prompt: "Summarize the deploy.", requireToolApproval: true }],
  });
  const child = await childOf(parentId);
  await run.continueRun(child.id);
  const woken = await run.prisma.run.findFirstOrThrow({ where: { trigger: "follow_up" } });
  await run.continueRun(woken.id);
  run.model.assertComplete();

  expect((await runs()).map(({ id, trigger, status }) => [id, trigger, status])).toEqual([
    [parentId, "user", "completed"],
    [child.id, "helper", "completed"],
    [webhookId, "webhook", "queued"],
    [woken.id, "follow_up", "completed"],
  ]);
});

it("wakes the bot for a report that commits after its turn read the conversation", async () => {
  const turnAsked = Promise.withResolvers<void>();
  const childEnded = Promise.withResolvers<void>();
  const { run, runs, childOf } = await fixture([
    ...startedTurn,
    {
      async expect(request) {
        expect(text(request)).not.toContain(REPORT);
        turnAsked.resolve();
        await childEnded.promise;
      },
      response: say("Still on it."),
    },
    { expect() {}, response: { type: "text", text: REPORT } },
    { expect() {}, response: { type: "text", text: recap } },
    {
      expect(request) {
        expect(text(request)).toContain(REPORT);
      },
      response: say(`Found it: ${REPORT}`),
    },
    { expect() {}, response: { type: "text", text: recap } },
  ]);
  const parentId = await run.send("Book me a hotel in Lisbon.");
  await run.continueRun(parentId);
  const turnId = await run.send("Anything yet?");
  const turnDone = run.continueRun(turnId);
  await turnAsked.promise;
  await run.continueRun((await childOf(parentId)).id);
  // A turn claimed while the report's transaction was still open stamps a later start.
  const report = await run.prisma.sessionEntry.findFirstOrThrow({
    where: { type: "helper.report" },
  });
  await run.prisma.run.update({
    where: { id: turnId },
    data: { startedAt: new Date(report.createdAt.getTime() + 1_000) },
  });
  childEnded.resolve();
  await turnDone;
  const [, , , woken] = await runs();
  await run.continueRun(woken!.id);
  run.model.assertComplete();

  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "completed"],
    ["user", "completed"],
    ["follow_up", "completed"],
  ]);
});

it("does not wake the bot again for a report its resumed turn already read", async () => {
  const notes = approvedNotes();
  const { run, runs, reports, childOf } = await fixture(
    [
      spawn,
      publish,
      { expect() {}, response: { type: "text", text: "Waiting." } },
      { expect() {}, response: { type: "text", text: REPORT } },
      {
        expect(request) {
          expect(text(request)).toContain(REPORT);
        },
        response: say(`Published, and found ${REPORT}`),
      },
      { expect() {}, response: { type: "text", text: recap } },
    ],
    notes.tools,
  );
  const parentId = await run.send("Publish the plan and book a hotel.");
  await run.continueRun(parentId);
  const child = await childOf(parentId);
  await run.continueRun(child.id);
  expect(await reports()).toEqual([
    { helperId: child.id, profile: null, status: "completed", report: REPORT },
  ]);
  const card = await latestCard(run.prisma, parentId);
  expect(
    await run.events.answerRunInput({
      spaceId: run.spaceId,
      threadId: run.thread.id,
      runId: parentId,
      messageId: card.id,
      answeredByUserId: run.userId,
      answer: "allow",
    }),
  ).toBe(true);
  await run.continueRun(parentId);
  run.model.assertComplete();

  expect(notes.published).toEqual([{ title: "Plan" }]);
  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "completed"],
  ]);
});

it("keeps a background helper from waiting on the user: what needs them goes in its report", async () => {
  const notes = approvedNotes();
  const askTools = ["ask_user", "request_takeover", "request_secret"].map(
    (name) => `mcp__rakazo__${name}`,
  );
  const offered = (request: ModelEmulatorRequest) =>
    askTools.filter((name) => request.tools?.some((tool) => tool.function.name === name));
  const toolsOf: Record<string, string[]> = {};
  const { run, runs, reports, childOf } = await fixture(
    [
      {
        expect(request) {
          toolsOf.parent = offered(request);
        },
        response: spawn.response,
      },
      { expect() {}, response: say("I've started that.") },
      { expect() {}, response: { type: "text", text: recap } },
      {
        expect(request) {
          toolsOf.helper = offered(request);
        },
        response: publish.response,
      },
      {
        expect(request) {
          expect(JSON.stringify(request.messages.at(-1))).toContain(
            "publish_note needs the user's approval, which a background helper cannot ask for.",
          );
        },
        response: { type: "text", text: "Publishing needs the user's approval." },
      },
    ],
    notes.tools,
  );
  const parentId = await run.send("Publish the plan in the background.");
  await run.continueRun(parentId);
  const child = await childOf(parentId);
  await run.continueRun(child.id);

  expect(toolsOf).toEqual({
    parent: ["mcp__rakazo__ask_user", "mcp__rakazo__request_secret"],
    helper: [],
  });
  expect(notes.published).toEqual([]);
  await expect(latestCard(run.prisma, child.id)).rejects.toThrow();
  expect(await reports()).toEqual([
    {
      helperId: child.id,
      profile: null,
      status: "completed",
      report: "Publishing needs the user's approval.",
    },
  ]);
  expect((await runs()).map(({ trigger, status }) => [trigger, status])).toEqual([
    ["user", "completed"],
    ["helper", "completed"],
    ["follow_up", "queued"],
  ]);
});
