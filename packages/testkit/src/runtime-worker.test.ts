import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FrameSummary } from "@rakazo/adapters/runtime-worker";
import { bundleGuest } from "@rakazo/agent-run-worker/bundle";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { prepares } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

type WorkerRun = Awaited<ReturnType<typeof startWorkerRun>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(options: Parameters<typeof startWorkerRun>[0]) {
  const run = await startWorkerRun(options);
  cleanups.push(() => run.close());
  return run;
}

const toolResult = (request: ModelEmulatorRequest) =>
  String(request.messages.findLast((message) => message.role === "tool")?.content);

/** True for the first frame that matches, then never again. */
function once(matches: (frame: FrameSummary) => boolean) {
  let fired = false;
  return (frame: FrameSummary) => {
    if (fired || !matches(frame)) return false;
    fired = true;
    return true;
  };
}

async function effects(run: WorkerRun, runId: string) {
  return run.prisma.externalEffect.findMany({
    where: { runId },
    select: { kind: true, status: true },
    orderBy: { createdAt: "asc" },
  });
}

async function attempts(run: WorkerRun, runId: string) {
  return run.prisma.attempt.findMany({
    where: { runId },
    select: { workerState: true, stopPhase: true },
    orderBy: { fence: "asc" },
  });
}

let bundled: Promise<string> | undefined;
/** The guest bundle, in a directory with no node_modules above it. */
function guestBundle() {
  bundled ??= mkdtemp(path.join(tmpdir(), "rakazo-guest-bundle-")).then((dir) =>
    bundleGuest(path.join(dir, "agent-run-worker.mjs")),
  );
  return bundled;
}
afterAll(async () => {
  if (bundled) await rm(path.dirname(await bundled), { recursive: true, force: true });
});

const recap = JSON.stringify({ version: 1, results: ["Wrote notes.txt"], references: [] });

/** The bot tells the user it is done, then closes with its recap. */
const finishing: ModelEmulatorStep[] = [
  {
    expect() {},
    response: { type: "tool", id: "say", name: "message_user", arguments: { message: "Done." } },
  },
  { expect() {}, response: { type: "text", text: recap } },
];

/** A controller tool call with a visible effect. */
const note: ModelEmulatorStep = {
  expect() {},
  response: { type: "tool", id: "note", name: "scratchpad_add", arguments: { title: "Plan" } },
};

describe("a run whose bot runs in a guest", () => {
  it.each([
    ["in memory", async () => ({})],
    ["from its bundle", async () => ({ mode: "child" as const, guestEntry: await guestBundle() })],
  ])(
    "runs text, a guest tool, a controller tool and the recap, and logs them once, %s",
    async (_guest, guest) => {
      const run = await fixture({
        ...(await guest()),
        steps: [
          {
            expect(request) {
              const system = String(
                request.messages.find((message) => message.role === "system")?.content,
              );
              expect(system).toContain("After all work and any mcp__rakazo__message_user calls");
              expect(system).not.toContain("After all work and any message_user calls");
            },
            response: {
              type: "tool",
              id: "sh",
              name: "bash",
              arguments: { command: "echo from-guest" },
            },
          },
          {
            expect(request) {
              expect(toolResult(request)).toContain("from-guest");
            },
            response: {
              type: "tool",
              id: "controller",
              name: "scratchpad_add",
              arguments: { title: "from-controller" },
            },
          },
          {
            expect(request) {
              expect(toolResult(request)).toContain("from-controller");
            },
            response: {
              type: "tool",
              id: "say",
              name: "message_user",
              arguments: { message: "Saved." },
            },
          },
          {
            expect() {},
            response: {
              type: "text",
              text: recap,
              usage: { promptTokens: 30, completionTokens: 5 },
            },
          },
        ],
      });
      const runId = await run.send("Save a note.");
      await run.continueRun(runId);

      run.model.assertComplete();
      expect(
        await run.prisma.run.findUniqueOrThrow({
          where: { id: runId },
          select: { status: true, error: true },
        }),
      ).toEqual({ status: "completed", error: null });
      const entries = await run.runEntries(runId);
      const calls = entries.filter((entry) => entry.type === "tool.call");
      const results = entries.filter((entry) => entry.type === "tool.result");
      expect(calls.map((entry) => entry.payload.name)).toEqual([
        "bash",
        "scratchpad_add",
        "message_user",
      ]);
      expect(results.map((entry) => entry.payload.callId)).toEqual(
        calls.map((entry) => entry.payload.callId),
      );
      expect(results.map((entry) => entry.payload.isError)).toEqual([false, false, false]);
      expect(
        await run.prisma.attempt.findMany({
          where: { runId },
          select: { workerState: true, stopPhase: true },
        }),
      ).toEqual([{ workerState: "released", stopPhase: "process_ended" }]);
      expect(
        await run.prisma.usageRecord.aggregate({
          where: { runId },
          _sum: { inputTokens: true, outputTokens: true },
        }),
      ).toEqual({ _sum: { inputTokens: 30, outputTokens: 5 } });
    },
  );

  it("answers a request resent after a lost reply from its first decision, writing once", async () => {
    let lost = 0;
    const run = await fixture({
      faults: {
        reconnects: 1,
        cutBeforeControllerFrame: once((frame) => {
          const match = frame.kind === "worker.reply" && frame.type === "tool.result";
          if (match) lost += 1;
          return match;
        }),
      },
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "controller",
            name: "scratchpad_add",
            arguments: { title: "from-controller" },
          },
        },
        {
          expect(request) {
            expect(toolResult(request)).toContain("from-controller");
          },
          response: {
            type: "tool",
            id: "say",
            name: "message_user",
            arguments: { message: "Done." },
          },
        },
        finishing[1]!,
      ],
    });
    const runId = await run.send("Save a note.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(await run.prisma.scratchpadItem.count()).toBe(1);
    expect(
      (await run.runEntries(runId))
        .filter((entry) => entry.type === "tool.call" || entry.type === "tool.result")
        .map((entry) => entry.type),
    ).toEqual(["tool.call", "tool.result", "tool.call", "tool.result"]);
    expect(await effects(run, runId)).toEqual([
      { kind: "scratchpad_add", status: "completed" },
      { kind: "message_user", status: "completed" },
    ]);
    expect(lost).toBe(1);
    expect(run.provider.launches).toHaveLength(1);
  });

  it("starts no effect when the channel is cut before the tool call reaches the controller", async () => {
    const run = await fixture({
      faults: { cutBeforeGuestFrame: once((frame) => frame.type === "tool.call") },
      steps: [note],
    });
    const runId = await run.send("Save a note.");

    await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
    expect(await run.prisma.scratchpadItem.count()).toBe(0);
    expect(await effects(run, runId)).toEqual([]);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "queued",
    );
    expect(await attempts(run, runId)).toEqual([
      { workerState: "released", stopPhase: "process_ended" },
    ]);

    await run.continueRun(runId);
    run.model.assertComplete();
    expect(await run.prisma.scratchpadItem.count()).toBe(0);
    expect(await effects(run, runId)).toEqual([]);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "failed",
    );
  });

  it("refuses a controller tool asked under a fence another claim replaced, and starts no second guest", async () => {
    const held = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const run = await fixture({
      faults: {
        holdGuestFrame: (frame) => {
          if (frame.type !== "tool.call") return undefined;
          reached.resolve();
          return held.promise;
        },
      },
      steps: [note, ...finishing],
    });
    const runId = await run.send("Save a note.");
    const first = run.continueRun(runId).catch((error: unknown) => error);
    await reached.promise;

    await run.prisma.run.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await run.continueRun(runId);
    expect(run.provider.launches).toHaveLength(1);
    held.resolve();
    await first;

    expect(await run.prisma.scratchpadItem.count()).toBe(0);
    expect(await effects(run, runId)).toEqual([]);
  });

  it("runs nothing a restarted controller finds waiting for approval until the answer is stored", async () => {
    const run = await fixture({
      steps: [note, ...finishing],
    });
    await run.prisma.actionApprovalRule.create({
      data: {
        spaceId: run.spaceId,
        createdByUserId: run.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "scratchpad_add",
      },
    });
    const runId = await run.send("Save a note.");
    await run.continueRun(runId);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "waiting_input",
    );
    expect(await attempts(run, runId)).toEqual([
      { workerState: "released", stopPhase: "process_ended" },
    ]);
    const before = run.restart();

    const requestsBeforeAnswer = run.model.requests.length;
    await run.continueRun(runId);
    expect(run.model.requests).toHaveLength(requestsBeforeAnswer);
    expect(run.provider.launches).toHaveLength(0);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "waiting_input",
    );
    expect(await run.prisma.scratchpadItem.count()).toBe(0);
    expect(await effects(run, runId)).toEqual([{ kind: "scratchpad_add", status: "intended" }]);

    const card = await latestCard(run.prisma, runId);
    expect(
      await run.events.answerRunInput({
        spaceId: run.spaceId,
        threadId: run.thread.id,
        runId,
        messageId: card.id,
        answeredByUserId: run.userId,
        answer: "allow",
      }),
    ).toBe(true);
    await run.continueRun(runId);

    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(await run.prisma.scratchpadItem.count()).toBe(1);
    expect(await effects(run, runId)).toEqual([
      { kind: "scratchpad_add", status: "completed" },
      { kind: "message_user", status: "completed" },
    ]);
    expect(before.launches).toHaveLength(1);
  });

  it("hands a throwing controller tool's failure to the model and finishes the run", async () => {
    const run = await fixture({
      tools: {
        describe: () => ({
          id: "fixture",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { discover: true, oauth: false, secretsBrokered: true },
        }),
        discoverTools: async () => [
          { name: "publish_note", description: "Publish a note", inputSchema: { type: "object" } },
        ],
        execute() {
          throw new Error("Fixture publish denied");
        },
      },
      steps: [
        {
          expect() {},
          response: { type: "tool", id: "publish", name: "publish_note", arguments: {} },
        },
        {
          expect(request) {
            expect(toolResult(request)).toContain("Fixture publish denied");
          },
          response: finishing[0]!.response,
        },
        finishing[1]!,
      ],
    });
    const runId = await run.send("Publish the plan.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(
      (await run.runEntries(runId)).flatMap((entry) =>
        entry.type === "tool.result" ? [entry.payload.isError] : [],
      ),
    ).toEqual([true, false]);
  });

  it("fails the run when the provider rejects the relayed call", async () => {
    const run = await fixture({
      steps: [
        {
          expect() {},
          response: { type: "error", status: 400, message: "Fixture request rejected" },
        },
      ],
    });
    const runId = await run.send("Save a note.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, error: true },
      }),
    ).toEqual({ status: "failed", error: expect.stringContaining("Fixture request rejected") });
    expect((await run.runEntries(runId)).filter((entry) => entry.type === "tool.call")).toEqual([]);
  });

  it("wakes a message sent during the run's last turn as a steering run", async () => {
    const finalAsked = Promise.withResolvers<void>();
    const answerFinal = Promise.withResolvers<void>();
    const run = await fixture({
      steps: [
        finishing[0]!,
        {
          async expect() {
            finalAsked.resolve();
            await answerFinal.promise;
          },
          response: finishing[1]!.response,
        },
        ...finishing,
      ],
    });
    const runId = await run.send("Write the plan.");
    const first = run.continueRun(runId);
    await finalAsked.promise;
    expect(await run.send("Also add the budget.")).toBe(runId);
    answerFinal.resolve();
    await first;

    const followUp = await run.prisma.run.findFirstOrThrow({ where: { trigger: "follow_up" } });
    await run.continueRun(followUp.id);
    run.model.assertComplete();
    const started = (await run.runEntries(followUp.id)).find(
      (entry) => entry.type === "run.started",
    );
    expect(started?.payload).toMatchObject({
      trigger: { kind: "steering", entryId: followUp.sourceMessageId },
    });
  });

  it("pauses a guest's parallel tool batch at a connector approval, runs its sibling once, then runs the approved call at the controller", async () => {
    const published: string[] = [];
    const publish = { id: "publish", name: "publish_note", arguments: { title: "Plan" } };
    const sibling = { id: "note", name: "scratchpad_add", arguments: { title: "Plan" } };
    let resumed: ModelEmulatorRequest["messages"] = [];
    const run = await fixture({
      tools: {
        describe: () => ({
          id: "fixture",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { discover: true, oauth: false, secretsBrokered: true },
        }),
        discoverTools: async () => [
          {
            name: "publish_note",
            description: "Publish a note",
            inputSchema: { type: "object", properties: { title: { type: "string" } } },
          },
        ],
        async *execute(call) {
          published.push(call.tool);
          yield { type: "result", data: { published: true } };
        },
      },
      steps: [
        { expect() {}, response: { type: "tool", ...publish, siblings: [sibling] } },
        prepares(),
        {
          expect(request) {
            resumed = request.messages;
          },
          response: finishing[0]!.response,
        },
        finishing[1]!,
      ],
    });
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
    expect(published).toEqual([]);
    // Pi runs a turn's calls in parallel: the sibling reaches the controller before the pause.
    expect(await run.prisma.scratchpadItem.count()).toBe(1);

    const card = await latestCard(run.prisma, runId);
    await run.events.answerRunInput({
      spaceId: run.spaceId,
      threadId: run.thread.id,
      runId,
      messageId: card.id,
      answeredByUserId: run.userId,
      answer: "allow",
    });
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(published).toEqual(["publish_note"]);
    expect(await run.prisma.scratchpadItem.count()).toBe(1);
    expect(resumed.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "publish", content: '{"published":true}' },
      { role: "tool", tool_call_id: "note", content: expect.stringContaining('"title":"Plan"') },
    ]);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
  });
});
