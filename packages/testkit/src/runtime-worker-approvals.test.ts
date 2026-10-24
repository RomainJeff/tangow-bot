import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

type WorkerRun = Awaited<ReturnType<typeof startWorkerRun>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const recap = JSON.stringify({ version: 1, results: ["Published the plan"], references: [] });
const finishing: ModelEmulatorStep[] = [
  {
    expect() {},
    response: { type: "tool", id: "say", name: "message_user", arguments: { message: "Done." } },
  },
  { expect() {}, response: { type: "text", text: recap } },
];

const ROUTE = { connectorId: "notes", resourceId: "notes-server", toolName: "publish_note" };

/** One connector tool on a bound resource, which disappears once its connection is revoked. */
function notesConnector() {
  const published: unknown[] = [];
  const state = { connected: true };
  const tools: ConnectorProvider = {
    describe: () => ({
      id: "notes",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    }),
    discoverTools: async () =>
      state.connected
        ? [
            {
              name: "publish_note",
              description: "Publish a note",
              inputSchema: { type: "object", properties: { title: { type: "string" } } },
              route: ROUTE,
            },
          ]
        : [],
    async *execute(call) {
      published.push(call.args);
      yield { type: "result", data: { published: call.args.title } };
    },
  };
  return { tools, published, state };
}

const publish = (title: string, id = "publish"): ModelEmulatorStep => ({
  expect() {},
  response: { type: "tool", id, name: "publish_note", arguments: { title } },
});

/** The steps of its paused attempt the resumed model reads back. */
const ranBefore = (request: ModelEmulatorRequest | undefined) =>
  String(request?.messages.at(-2)?.content);

/** Pi closes its turn with one more model call once a pausing call answers that the run waits. */
function closingTurns(steps: ModelEmulatorStep[]): ModelEmulatorStep[] {
  return steps.flatMap((step) => {
    const response = step.response;
    return typeof response !== "function" &&
      response.type === "tool" &&
      ["publish_note", "request_secret"].includes(response.name)
      ? [step, { expect() {}, response: { type: "text", text: "Waiting." } }]
      : [step];
  });
}

async function fixture(steps: ModelEmulatorStep[], tools: ConnectorProvider) {
  const run = await startWorkerRun({ steps: closingTurns(steps), tools });
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
  return run;
}

async function answer(run: WorkerRun, runId: string, reply: string) {
  const card = await latestCard(run.prisma, runId);
  expect(
    await run.events.answerRunInput({
      spaceId: run.spaceId,
      threadId: run.thread.id,
      runId,
      messageId: card.id,
      answeredByUserId: run.userId,
      answer: reply,
    }),
  ).toBe(true);
}

const statusOf = async (run: WorkerRun, runId: string) =>
  (await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;

async function resultsOf(run: WorkerRun, runId: string, callId: string) {
  return (await run.runEntries(runId)).flatMap((entry) =>
    entry.type === "tool.result" && entry.payload.callId === callId ? [entry.payload.output] : [],
  );
}

describe("an approval answered for a run in a guest", () => {
  it.each([
    ["right away", false, false],
    ["after the controller restarted", true, false],
    ["from a helper after the controller restarted", true, true],
  ])(
    "runs the approved call once at the controller and hands its result to the model, resumed %s",
    async (_delay, restart, helper) => {
      const notes = notesConnector();
      let resumed: ModelEmulatorRequest | undefined;
      const run = await fixture(
        [
          ...(helper
            ? [
                {
                  expect() {},
                  response: {
                    type: "tool" as const,
                    id: "delegate",
                    name: "run_subagent",
                    arguments: { name: "Publisher", task: "Publish the plan." },
                  },
                },
              ]
            : []),
          publish("Plan"),
          {
            expect(request) {
              resumed = request;
            },
            response: finishing[0]!.response,
          },
          finishing[1]!,
        ],
        notes.tools,
      );
      const runId = await run.send("Publish the plan.");
      await run.continueRun(runId);
      expect(await statusOf(run, runId)).toBe("waiting_input");
      expect(notes.published).toEqual([]);
      if (helper) {
        expect(
          await run.prisma.run.findMany({
            where: { parentRunId: runId },
            select: { status: true },
          }),
        ).toEqual([{ status: "completed" }]);
      }

      await answer(run, runId, "allow");
      if (restart) run.restart();
      await Promise.all([run.continueRun(runId), run.continueRun(runId)]);
      await run.continueRun(runId);

      run.model.assertComplete();
      expect(await statusOf(run, runId)).toBe("completed");
      expect(notes.published).toEqual([{ title: "Plan" }]);
      if (helper) expect(await run.prisma.run.count({ where: { parentRunId: runId } })).toBe(1);
      const effect = await run.prisma.externalEffect.findFirstOrThrow({
        where: { runId, kind: "publish_note" },
      });
      expect(effect.status).toBe("completed");
      expect(await resultsOf(run, runId, effect.id)).toEqual(['{\n  "published": "Plan"\n}']);
      expect(ranBefore(resumed)).toContain(
        '(already ran Publish note, input: { "title": "Plan" }, result: { "published": "Plan" })',
      );
    },
  );

  it("does not run the approved call again when the controller died while running it", async () => {
    const notes = notesConnector();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    notes.tools.execute = async function* (call) {
      notes.published.push(call.args);
      started();
      yield* await new Promise<never>(() => {});
    };
    let resumed: ModelEmulatorRequest | undefined;
    const run = await fixture(
      [
        publish("Plan"),
        {
          expect(request) {
            resumed = request;
          },
          response: finishing[0]!.response,
        },
        finishing[1]!,
      ],
      notes.tools,
    );
    const runId = await run.send("Publish the plan.");
    await run.continueRun(runId);
    await answer(run, runId, "allow");
    void run.continueRun(runId);
    await running;

    run.restart();
    await run.prisma.run.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(await statusOf(run, runId)).toBe("completed");
    expect(notes.published).toEqual([{ title: "Plan" }]);
    expect(ranBefore(resumed)).toContain('"uncertain": true');
    expect(ranBefore(resumed)).toContain("It was not replayed to avoid a duplicate side effect.");
  });

  it.each(["cancelled", "superseded"])(
    "does not execute an approval after the attempt is %s",
    async (lost) => {
      const notes = notesConnector();
      const run = await fixture([publish("Plan")], notes.tools);
      const runId = await run.send("Publish the plan.");
      await run.continueRun(runId);
      await answer(run, runId, "allow");
      const append = run.events.append.bind(run.events);
      const reconciliation = vi.spyOn(run.events, "append").mockImplementation(async (input) => {
        const result = await append(input);
        if (input.type === "effect.reconciled") {
          reconciliation.mockRestore();
          await run.prisma.run.update({
            where: { id: runId },
            data:
              lost === "cancelled"
                ? { status: "cancelled" }
                : { leaseFence: { increment: 1 }, leaseOwner: "replacement-worker" },
          });
        }
        return result;
      });
      await run.continueRun(runId).catch(() => undefined);
      expect(notes.published).toEqual([]);
      expect(
        await run.prisma.externalEffect.findFirstOrThrow({
          where: { runId, kind: "publish_note" },
        }),
      ).toMatchObject({ status: "approved" });
    },
  );

  it("recovers a saved outcome when the controller stopped before writing the tool result", async () => {
    const notes = notesConnector();
    let resumed: ModelEmulatorRequest | undefined;
    const run = await fixture(
      [
        publish("Plan"),
        {
          expect(request) {
            resumed = request;
          },
          response: finishing[0]!.response,
        },
        finishing[1]!,
      ],
      notes.tools,
    );
    const runId = await run.send("Publish the plan.");
    await run.continueRun(runId);
    await answer(run, runId, "allow");
    let saved!: () => void;
    const completed = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const update = run.prisma.externalEffect.updateMany.bind(run.prisma.externalEffect);
    const crash = vi
      .spyOn(run.prisma.externalEffect, "updateMany")
      .mockImplementation(async (args) => {
        const result = await update(args);
        if (args.data.status === "completed") {
          saved();
          return new Promise<never>(() => {});
        }
        return result;
      });
    void run.continueRun(runId);
    await completed;
    crash.mockRestore();
    const effect = await run.prisma.externalEffect.findFirstOrThrow({
      where: { runId, kind: "publish_note" },
    });
    expect(effect.status).toBe("completed");
    expect(await resultsOf(run, runId, effect.id)).toEqual([]);
    run.restart();
    await run.prisma.run.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    await run.continueRun(runId);
    run.model.assertComplete();
    expect(notes.published).toEqual([{ title: "Plan" }]);
    expect(ranBefore(resumed)).toContain('result: { "published": "Plan" }');
    expect(await resultsOf(run, runId, effect.id)).toEqual(['{\n  "published": "Plan"\n}']);
  });

  it("runs nothing for a denied call and gives the model the refusal once", async () => {
    const notes = notesConnector();
    const resumes: ModelEmulatorRequest[] = [];
    const resumed = (step: ModelEmulatorStep): ModelEmulatorStep => ({
      expect(request) {
        resumes.push(request);
      },
      response: step.response,
    });
    const run = await fixture(
      [
        publish("Plan"),
        resumed(publish("Plan v2", "publish-again")),
        resumed(finishing[0]!),
        finishing[1]!,
      ],
      notes.tools,
    );
    const runId = await run.send("Publish the plan.");
    await run.continueRun(runId);
    await answer(run, runId, "deny");
    await run.continueRun(runId);
    expect(await statusOf(run, runId)).toBe("waiting_input");
    await answer(run, runId, "allow");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(notes.published).toEqual([{ title: "Plan v2" }]);
    const denied = await run.prisma.externalEffect.findFirstOrThrow({
      where: { runId, status: "denied" },
    });
    expect(await resultsOf(run, runId, denied.id)).toEqual([
      '{\n  "error": "User denied this action."\n}',
    ]);
    expect(resumes.map(ranBefore)).toEqual([
      expect.stringContaining(
        '(already ran Publish note, input: { "title": "Plan" }, result: { "error": "User denied this action." })',
      ),
      expect.stringContaining(
        '(already ran Publish note, input: { "title": "Plan v2" }, result: { "published": "Plan v2" })',
      ),
    ]);
  });

  it("runs nothing when the connection was revoked before resume", async () => {
    const notes = notesConnector();
    let resumed: ModelEmulatorRequest | undefined;
    const run = await fixture(
      [
        publish("Plan"),
        {
          expect(request) {
            resumed = request;
          },
          response: finishing[0]!.response,
        },
        finishing[1]!,
      ],
      notes.tools,
    );
    const runId = await run.send("Publish the plan.");
    await run.continueRun(runId);
    await answer(run, runId, "allow");
    notes.state.connected = false;
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(await statusOf(run, runId)).toBe("completed");
    expect(notes.published).toEqual([]);
    const effect = await run.prisma.externalEffect.findFirstOrThrow({
      where: { runId, kind: "publish_note" },
    });
    expect({ status: effect.status, result: effect.result }).toEqual({
      status: "completed",
      result: { error: "Approved request publish_note was for a different connector resource." },
    });
    expect(ranBefore(resumed)).toContain(
      'result: { "error": "Approved request publish_note was for a different connector resource." }',
    );
  });

  it("saves a secret at the controller without exposing it", async () => {
    const secret = "fixture-reusable-key";
    const requested = {
      label: "API key",
      purpose: "api_key",
      credential: {
        name: "example_api",
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      },
    };
    let resumed: ModelEmulatorRequest | undefined;
    const run = await startWorkerRun({
      steps: closingTurns([
        {
          expect() {},
          response: { type: "tool", id: "ask", name: "request_secret", arguments: requested },
        },
        {
          expect(request) {
            resumed = request;
          },
          response: finishing[0]!.response,
        },
        finishing[1]!,
      ]),
    });
    cleanups.push(() => run.close());
    const runId = await run.send("Save my API key.");
    await run.continueRun(runId);
    expect(await statusOf(run, runId)).toBe("waiting_input");
    await answer(run, runId, secret);
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(await statusOf(run, runId)).toBe("completed");
    const effect = await run.prisma.externalEffect.findFirstOrThrow({
      where: { runId, kind: "request_secret" },
    });
    expect(effect.status).toBe("completed");
    expect(ranBefore(resumed)).toContain('"saved": true');
    expect(JSON.stringify(run.model.requests)).not.toContain(secret);
  });
});
