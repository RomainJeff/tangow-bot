import { runContinueJob } from "@rakazo/adapter-kit";
import { createJobReconciler } from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(steps: ModelEmulatorStep[]) {
  const run = await startWorkerRun({ steps });
  cleanups.push(() => run.close());
  return run;
}

const recap = JSON.stringify({ version: 1, results: ["Answered"], references: [] });
const toolNames = (request: ModelEmulatorRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const shellTools = (request: ModelEmulatorRequest) =>
  toolNames(request).filter((name) => ["shell", "bash", "grep", "write_file"].includes(name));

/** Notes which shell tools the first model call offered, then ends the run. */
function offeredShellTools(seen: string[][]): ModelEmulatorStep[] {
  return [
    {
      expect(request) {
        seen.push(shellTools(request));
      },
      response: { type: "tool", id: "say", name: "message_user", arguments: { message: "Hi." } },
    },
    { expect() {}, response: { type: "text", text: recap } },
  ];
}

async function attemptsOf(run: Awaited<ReturnType<typeof fixture>>, runId: string) {
  return run.prisma.attempt.findMany({ where: { runId }, select: { workerState: true } });
}

describe("where a product run executes", () => {
  it("runs a bot whose home is on volumes in its guest, with bash and grep in place of the computer shell", async () => {
    const seen: string[][] = [];
    const run = await fixture(offeredShellTools(seen));
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect(seen).toEqual([["write_file", "grep", "bash"]]);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
  });

  it("keeps a bot whose home is still a snapshot in process, with the computer shell", async () => {
    const seen: string[][] = [];
    const run = await fixture(offeredShellTools(seen));
    await run.prisma.computer.update({
      where: { id: run.bot.computerId! },
      data: { homeStorage: "snapshot" },
    });
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect(seen).toEqual([["write_file", "shell"]]);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: null }]);
    expect(run.provider.launches).toEqual([]);
  });

  it("creates the volume of a bot attached after its computer moved, on its first run", async () => {
    const seen: string[][] = [];
    const run = await fixture(offeredShellTools(seen));
    await run.prisma.volume.deleteMany({ where: { kind: "bot_private" } });
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect(seen).toEqual([["write_file", "grep", "bash"]]);
    expect(
      await run.prisma.volume.findMany({
        where: { kind: "bot_private" },
        select: { botId: true, providerRef: true },
      }),
    ).toEqual([{ botId: run.bot.id, providerRef: expect.stringMatching(/^rakazo-/) }]);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
  });

  it("fails the run of a team bot whose space has no volume", async () => {
    const run = await startWorkerRun({ steps: [], computerScope: "team" });
    cleanups.push(() => run.close());
    await run.prisma.volume.deleteMany({ where: { kind: "space_shared" } });
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, error: true },
      }),
    ).toEqual({
      status: "failed",
      error: "This bot has no shared volume on its computer yet, so the run cannot start",
    });
    expect(run.provider.launches).toEqual([]);
  });

  it("stops quietly when a newer attempt took the run before it was routed", async () => {
    let fencedRunId = "";
    const run = await startWorkerRun({
      steps: [],
      workers: (workers) => ({
        ...workers,
        async plan(input) {
          await run.prisma.run.update({
            where: { id: fencedRunId },
            data: { leaseFence: { increment: 1 } },
          });
          return workers.plan(input);
        },
      }),
    });
    cleanups.push(() => run.close());
    fencedRunId = await run.send("Hello.");

    await run.continueRun(fencedRunId);

    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: fencedRunId },
        select: { status: true, error: true },
      }),
    ).toEqual({ status: "running", error: null });
    expect(run.provider.launches).toEqual([]);
  });

  it.each(["volumes", "ensure", "prepare"] as const)(
    "exhausts a run's setup budget across reconciliation and a restart after %s fails",
    async (step) => {
      const run = await startWorkerRun({ steps: [] });
      cleanups.push(() => run.close());
      const fail = async () => {
        throw new Error("The provider is unavailable");
      };
      const failProvider = () => {
        if (step === "volumes") run.provider.ensureVolume = fail;
        else run.provider[step] = fail;
      };
      if (step === "volumes") await run.prisma.volume.deleteMany();
      failProvider();
      const runId = await run.send("Hello.");
      const enqueue = vi.fn(async () => undefined);
      const reconciler = createJobReconciler({
        prisma: run.prisma,
        jobs: { enqueue, cancel: async () => undefined, close: async () => undefined },
      });

      for (let attempt = 1; attempt <= 3; attempt++) {
        enqueue.mockClear();
        await reconciler.reconcileOnce();
        expect(enqueue).toHaveBeenCalledWith(runContinueJob(runId));
        if (attempt < 3) {
          await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
          expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
            "queued",
          );
          if (step === "ensure" && attempt === 1) {
            expect(await attemptsOf(run, runId)).toEqual([{ workerState: "releasing" }]);
            for (let wait = 0; wait < 4; wait++) {
              await run.continueRun(runId);
              expect(
                (await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status,
              ).toBe("queued");
            }
          }
          // A failed ensure keeps its writer lease until its create deadline has passed.
          await run.prisma.attempt.updateMany({
            where: { runId, workerState: { not: null } },
            data: { workerEnsureAt: new Date(0) },
          });
          const context = {
            operationId: "retry-test",
            traceId: "retry-test",
            spaceId: run.spaceId,
            userId: run.userId,
            signal: new AbortController().signal,
          };
          await run.lifecycle.reconcile({ limit: 10 }, context);
          await run.restart().dispose();
          failProvider();
        } else {
          await run.continueRun(runId);
        }
      }

      expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Run setup failed after 3 attempts"),
      });
      enqueue.mockClear();
      await reconciler.reconcileOnce();
      expect(enqueue).not.toHaveBeenCalledWith(runContinueJob(runId));
      await run.continueRun(runId);
      expect(await run.prisma.attempt.count({ where: { runId } })).toBe(step === "ensure" ? 7 : 3);
    },
  );

  it("never claims a run of a bot that is being deleted", async () => {
    const run = await fixture([]);
    const runId = await run.send("Hello.");
    await run.prisma.bot.update({ where: { id: run.bot.id }, data: { archivedAt: new Date() } });
    const claim = { select: { status: true, leaseFence: true } } as const;
    const queued = await run.prisma.run.findUniqueOrThrow({ where: { id: runId }, ...claim });

    await run.continueRun(runId);

    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId }, ...claim })).toEqual(
      queued,
    );
    expect(await attemptsOf(run, runId)).toEqual([]);
  });

  it("asks the auto-review judge of a worker run in process", async () => {
    const run = await fixture([
      {
        expect() {},
        response: { type: "tool", id: "forget", name: "forget_secret", arguments: { name: "X" } },
      },
      {
        expect(request) {
          expect(JSON.stringify(request.messages.at(-1))).toContain("tool: forget_secret");
        },
        response: { type: "text", text: '{"decision":"pass","reason":"Harmless."}' },
      },
      ...offeredShellTools([]),
    ]);
    vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", run.model.model.provider);
    vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", run.model.model.id);
    await run.prisma.actionAutoReviewPreference.create({
      data: { spaceId: run.spaceId, userId: run.userId, enabled: true },
    });
    const runId = await run.send("Forget X.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(
      await run.prisma.externalEffect.findMany({
        where: { runId, kind: "forget_secret" },
        select: { kind: true, reviewDecision: true },
      }),
    ).toEqual([{ kind: "forget_secret", reviewDecision: "pass" }]);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
  });
});
