import { createWorkerAgentRuntime, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import { HARNESSES } from "@rakazo/agent-run-worker";
import type { HelperProfile } from "@rakazo/core";
import { afterEach, expect, it, vi } from "vitest";
import { stopThreadRuns } from "../../../apps/api/src/thread-target.js";
import {
  manualLauncher,
  rawGuest,
} from "../../adapters/src/runtime-worker/raw-guest.test-support.js";
import { afterPrivateText, startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function pausedHelper() {
  const launcher = manualLauncher({
    name: "pi-native",
    capabilities: ["native-loop", "subagents"],
  });
  const sleeps = new Map<number, () => void>();
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
    clock: { sleep: (ms) => new Promise<void>((resolve) => sleeps.set(ms, resolve)) },
  });
  const run = await startWorkerRun({
    steps: [],
    computerScope: "none",
    runtime: () => runtime,
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Plan my trip.");
  const continued = run.continueRun(runId);
  const launched = await launcher.launchedFor(runId);
  const guest = rawGuest(launched.connect(), launched.capability, {
    name: "pi-native",
    capabilities: ["native-loop", "subagents"],
  });
  await guest.hello();
  guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "helper" });
  guest.send(2, {
    type: "tool.call",
    agent: "root",
    callId: "helper",
    name: "run_subagent",
    args: { name: "Planner", task: "Choose a city" },
  });
  expect((await guest.replies(2, 1))[0]).toMatchObject({
    type: "subagent.start",
    agent: "helper:1",
  });
  guest.send(3, { type: "tool", name: "ask_user", args: {}, executionId: "question" });
  guest.send(4, {
    type: "tool.call",
    agent: "helper:1",
    callId: "question",
    name: "ask_user",
    args: { question: "Which city?", options: ["Paris", "Lyon"] },
  });
  expect(await guest.replies(4)).toMatchObject([
    { type: "tool.result", output: { details: { ask: "paused" }, terminate: true } },
  ]);
  expect((await guest.replies(2)).at(-1)).toEqual({
    type: "tool.result",
    output: "Stopped: the run is waiting for the user.",
  });
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "waiting_input",
  );
  const helper = await run.prisma.run.findFirstOrThrow({ where: { parentRunId: runId } });
  return { run, runId, helper, guest, runtime, continued, sleeps };
}

it("persists the helper's native call and result after its parent has paused and settled", async () => {
  const { run, runId, helper, guest, continued } = await pausedHelper();
  guest.send(5, {
    type: "model.request",
    agent: "helper:1",
    dialect: "pi-ai",
    call: { context: { messages: [] }, options: {} },
  });
  expect((await guest.replies(5)).at(-1)).toEqual({ type: "model.end" });
  guest.send(6, {
    type: "transcript",
    agent: "helper:1",
    dialect: "pi-ai",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } },
        ],
      },
      { role: "toolResult", toolCallId: "read-1", content: "Paris notes", isError: false },
    ],
  });
  expect(await guest.replies(6)).toEqual([{ type: "recorded" }]);
  guest.send(7, { type: "done" });
  await continued;
  expect(
    (await run.runEntries(helper.id)).filter(
      (entry) => entry.type === "tool.call" || entry.type === "tool.result",
    ),
  ).toMatchObject([
    { type: "tool.call", payload: { callId: "read-1", name: "read" } },
    { type: "tool.result", payload: { callId: "read-1", output: "Paris notes", isError: false } },
  ]);
  expect(
    (await run.runEntries(runId)).filter((entry) => entry.type === "assistant.ask"),
  ).toHaveLength(1);
  expect(
    await run.prisma.run.findUniqueOrThrow({
      where: { id: helper.id },
      select: { status: true, task: { select: { status: true } } },
    }),
  ).toEqual({ status: "completed", task: { status: "completed" } });
});

it.each(["done", "finish", "abandon", "grace", "cancel"] as const)(
  "closes a paused helper with no final transcript on %s",
  async (end) => {
    const { run, runId, helper, guest, runtime, continued, sleeps } = await pausedHelper();
    if (end === "done") guest.send(5, { type: "done" });
    else if (end === "finish" || end === "abandon") {
      guest.send(
        5,
        end === "finish"
          ? { type: "subagent.finish", agent: "helper:1", status: "completed", result: "Done." }
          : { type: "subagent.abandon", agent: "helper:1", result: "The guest stopped" },
      );
      expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);
      guest.send(6, { type: "done" });
    } else if (end === "grace") sleeps.get(WORKER_LIMITS.pausedGraceMs)!();
    else await runtime.abort(runId);
    await continued;
    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: helper.id },
        select: { status: true, task: { select: { status: true } } },
      }),
    ).toEqual({ status: "completed", task: { status: "completed" } });
    expect(
      (await run.runEntries(helper.id)).filter((entry) => entry.type === "run.finished"),
    ).toHaveLength(1);
  },
);

const delegate = {
  expect() {},
  response: {
    type: "tool",
    id: "helper",
    name: "run_subagent",
    arguments: { name: "Checker", task: "Check it." },
  },
} as const;

it("closes a helper stopped mid-turn with its parent as cancelled by the stopper", async () => {
  const helperAsked = Promise.withResolvers<void>();
  const answerHelper = Promise.withResolvers<void>();
  const run = await startWorkerRun({
    steps: [
      delegate,
      {
        async expect() {
          helperAsked.resolve();
          await answerHelper.promise;
        },
        response: { type: "text", text: "checked" },
      },
    ],
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Have a helper check it.");
  const continued = run.continueRun(runId);
  await helperAsked.promise;
  const helper = await run.prisma.run.findFirstOrThrow({ where: { parentRunId: runId } });

  await stopThreadRuns(
    run,
    { spaceId: run.spaceId, userId: run.userId },
    { kind: "bot", botId: run.bot.id, threadId: run.thread.id, bot: run.bot },
  );
  answerHelper.resolve();
  await continued;

  expect(
    (await run.runEntries(helper.id)).flatMap((entry) =>
      entry.type === "run.finished" ? [entry.payload] : [],
    ),
  ).toEqual([expect.objectContaining({ status: "cancelled", by: run.userId })]);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status).toBe(
    "cancelled",
  );
});

it.skipIf(process.env.VERIFY_DATABASE !== "1" || !process.env.DATABASE_URL)(
  "closes a helper behind its parent's thread lock, holding nothing a stop needs first",
  async () => {
    const helperAsked = Promise.withResolvers<void>();
    const answerHelper = Promise.withResolvers<void>();
    const run = await startWorkerRun({
      databaseUrl: process.env.DATABASE_URL,
      steps: [
        delegate,
        {
          async expect() {
            helperAsked.resolve();
            await answerHelper.promise;
          },
          // An empty reply logs no entry first, so closing the helper is what waits on the thread.
          response: { type: "text", text: "" },
        },
        { expect() {}, response: { type: "text", text: "Checked." } },
        afterPrivateText,
      ],
    });
    cleanups.push(() => run.close());
    const runId = await run.send("Have a helper check it.");
    const continued = run.continueRun(runId);
    await helperAsked.promise;
    const helper = await run.prisma.run.findFirstOrThrow({ where: { parentRunId: runId } });

    // A stop takes the thread first; the closing helper must queue behind it holding nothing.
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stopLike = run.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.thread.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { timeout: 20_000 },
    );
    await locked.promise;
    answerHelper.resolve();
    await expect
      .poll(
        async () => {
          const [row] = await run.prisma.$queryRaw<Array<{ waiting: number }>>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%FROM threads%FOR UPDATE%'`;
          return row!.waiting;
        },
        { timeout: 10_000, interval: 20 },
      )
      .toBe(1);
    const probe = await run.prisma.$queryRaw`
      SELECT id FROM runs WHERE id = ${helper.id} FOR NO KEY UPDATE NOWAIT`.then(
      () => "free",
      (error: unknown) => String(error),
    );
    release.resolve();
    await stopLike;
    await continued;

    expect(probe).toBe("free");
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status).toBe(
      "completed",
    );
  },
  30_000,
);

it("runs native Pi helpers in separate persisted sessions and resumes the parent without replaying them", async () => {
  const run = await startWorkerRun({
    harness: HARNESSES["pi-native"],
    computerScope: "team",
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "helper",
          name: "mcp__rakazo__run_subagent",
          arguments: { name: "Planner", task: "Choose a city" },
        },
      },
      {
        expect(request) {
          const tools = request.tools?.map((tool) => tool.function.name) ?? [];
          expect(tools).not.toContain("mcp__rakazo__run_subagent");
          expect(tools).not.toContain("mcp__rakazo__message_user");
        },
        response: {
          type: "tool",
          id: "question",
          name: "mcp__rakazo__ask_user",
          arguments: { question: "Which city?", options: ["Paris", "Lyon"] },
        },
      },
      { expect() {}, response: { type: "text", text: "Waiting privately." } },
      {
        expect(request) {
          expect(JSON.stringify(request.messages)).toContain("Paris");
        },
        response: { type: "text", text: "Resumed privately." },
      },
      afterPrivateText,
    ],
  });
  cleanups.push(() => run.close());
  const provision = vi.spyOn(run.sandbox, "provision");
  const runId = await run.send("Plan my trip.");
  await run.continueRun(runId);
  const parent = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
  expect(parent.status).toBe("waiting_input");
  const [helper] = await run.prisma.run.findMany({
    where: { parentRunId: runId },
    include: { session: true, task: true },
  });
  expect(helper).toMatchObject({
    status: "completed",
    task: { status: "completed" },
    session: { kind: "subagent", parentSessionId: parent.sessionId },
  });
  expect(helper?.sessionId).not.toBe(parent.sessionId);
  const entries = await run.runEntries(runId);
  const cards = entries.filter((entry) => entry.type === "assistant.ask");
  expect(cards).toHaveLength(1);
  expect(entries.filter((entry) => entry.type === "subagent")).toMatchObject([
    { payload: { sessionId: helper?.sessionId, status: "completed" } },
  ]);
  expect(
    (await run.runEntries(helper!.id)).filter((entry) => entry.type === "run.finished"),
  ).toHaveLength(1);
  expect(
    await run.events.answerRunInput({
      spaceId: run.spaceId,
      threadId: run.thread.id,
      runId,
      messageId: cards[0]!.id,
      answeredByUserId: run.userId,
      answer: "choice-1",
    }),
  ).toBe(true);
  await run.continueRun(runId);
  run.model.assertComplete();
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "completed",
  );
  expect(await run.prisma.run.count({ where: { parentRunId: runId } })).toBe(1);
  expect(
    (await run.runEntries(runId)).filter((entry) => entry.type === "assistant.ask"),
  ).toHaveLength(1);
  expect(provision).not.toHaveBeenCalled();
});

it("lends a bot's computer to one exclusive helper at a time", async () => {
  const launcher = manualLauncher({
    name: "pi-native",
    capabilities: ["native-loop", "subagents"],
  });
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
  });
  const helperProfiles: HelperProfile[] = [
    {
      name: "operator",
      description: "Uses the computer.",
      exclusive: "computer",
      instructions: "",
    },
    { name: "writer", description: "Writes.", instructions: "" },
  ];
  const run = await startWorkerRun({
    steps: [],
    computerScope: "none",
    runtime: () => ({
      describe: () => runtime.describe(),
      run: (request, context) => runtime.run({ ...request, helperProfiles }, context),
      abort: (runId) => runtime.abort(runId),
    }),
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Book it.");
  const continued = run.continueRun(runId);
  const launched = await launcher.launchedFor(runId);
  const guest = rawGuest(launched.connect(), launched.capability, {
    name: "pi-native",
    capabilities: ["native-loop", "subagents"],
  });
  await guest.hello();
  let seq = 0;
  const delegate = async (helper: string) => {
    const callId = `call-${seq}`;
    guest.send(++seq, { type: "tool", name: "run_subagent", args: {}, executionId: callId });
    guest.send(++seq, {
      type: "tool.call",
      agent: "root",
      callId,
      name: "run_subagent",
      args: { name: helper, task: "Do it.", helper },
    });
    return { seq, reply: (await guest.replies(seq, 1))[0] };
  };
  const finish = async (agent: string) => {
    guest.send(++seq, { type: "subagent.finish", agent, status: "completed", result: "Done." });
    expect(await guest.replies(seq)).toEqual([{ type: "recorded" }]);
  };

  const first = await delegate("operator");
  expect(first.reply).toMatchObject({ type: "subagent.start", agent: "helper:1" });
  const holder = await run.prisma.run.findFirstOrThrow({
    where: { parentRunId: runId, helper: "operator" },
  });
  expect(await delegate("writer")).toMatchObject({
    reply: { type: "subagent.start", agent: "helper:2" },
  });
  expect((await delegate("operator")).reply).toEqual({
    type: "error",
    message: `computer is held by helper ${holder.id} (operator)`,
  });

  await finish("helper:1");
  expect((await guest.replies(first.seq)).at(-1)).toEqual({ type: "tool.result", output: "Done." });
  expect(await delegate("operator")).toMatchObject({
    reply: { type: "subagent.start", agent: "helper:3" },
  });
  await finish("helper:2");
  await finish("helper:3");
  guest.send(++seq, { type: "done" });
  await continued;

  expect(
    await run.prisma.run.findMany({
      where: { parentRunId: runId },
      orderBy: { createdAt: "asc" },
      select: { helper: true, exclusive: true, status: true },
    }),
  ).toEqual([
    { helper: "operator", exclusive: "computer", status: "completed" },
    { helper: "writer", exclusive: null, status: "completed" },
    { helper: "operator", exclusive: "computer", status: "completed" },
  ]);
});
