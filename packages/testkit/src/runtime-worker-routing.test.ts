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

  it("fails the run of a bot whose computer moved before it had a volume", async () => {
    const run = await fixture([]);
    await run.prisma.volume.deleteMany({ where: { kind: "bot_private" } });
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, error: true },
      }),
    ).toEqual({
      status: "failed",
      error: "This bot has no private volume on its computer yet, so the run cannot start",
    });
    expect(run.provider.launches).toEqual([]);
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
