import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type FrameSummary, GUEST_TOOLS } from "@rakazo/adapters/runtime-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
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

const recap = JSON.stringify({ version: 1, results: ["Wrote notes.txt"], references: [] });

/** A file outside every worker, so it shows what all of a run's guests did. */
async function probe() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-worker-probe-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "probe.txt");
  const step = (expectations: ModelEmulatorStep["expect"] = () => {}): ModelEmulatorStep => ({
    expect: expectations,
    response: {
      type: "tool",
      id: "probe",
      name: "bash",
      arguments: { command: `echo ran >> ${file}` },
    },
  });
  return {
    step,
    lines: async () => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}

/** The bot tells the user it is done, then closes with its recap. */
const finishing: ModelEmulatorStep[] = [
  {
    expect() {},
    response: { type: "tool", id: "say", name: "message_user", arguments: { message: "Done." } },
  },
  { expect() {}, response: { type: "text", text: recap } },
];

describe("a run whose bot runs in a guest", () => {
  it("runs text, a guest tool, a controller tool and the recap, and logs them once", async () => {
    const run = await fixture({
      steps: [
        {
          expect() {},
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
            id: "save",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hi" },
          },
        },
        {
          expect() {},
          response: {
            type: "tool",
            id: "say",
            name: "message_user",
            arguments: { message: "Saved." },
          },
        },
        {
          expect() {},
          response: { type: "text", text: recap, usage: { promptTokens: 30, completionTokens: 5 } },
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
    expect(
      entries
        .filter((entry) => entry.type === "tool.call" || entry.type === "tool.result")
        .map((entry) =>
          entry.type === "tool.call"
            ? `call ${entry.payload.name}`
            : `result ${entry.payload.callId} ${entry.payload.isError}`,
        ),
    ).toEqual([
      "call bash",
      "result sh false",
      "call write_file",
      "result save false",
      "call message_user",
      "result say false",
    ]);
    const written = [...run.sandbox.boxes.values()].flatMap((box) =>
      [...box.files].map(([file, { content }]) => [file, Buffer.from(content).toString()]),
    );
    expect(written.filter(([file]) => file.endsWith("notes.txt")).map(([, text]) => text)).toEqual([
      "hi",
    ]);
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
  });

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
            id: "save",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hi" },
          },
        },
        {
          expect(request) {
            expect(toolResult(request)).toContain("notes.txt");
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
    const writes = vi.spyOn(run.sandbox, "writeFile");
    const runId = await run.send("Save a note.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(writes).toHaveBeenCalledTimes(1);
    expect(
      (await run.runEntries(runId))
        .filter((entry) => entry.type === "tool.call" || entry.type === "tool.result")
        .map((entry) => entry.type),
    ).toEqual(["tool.call", "tool.result", "tool.call", "tool.result"]);
    expect(await effects(run, runId)).toEqual([
      { kind: "write_file", status: "completed" },
      { kind: "message_user", status: "completed" },
    ]);
    expect(lost).toBe(1);
    expect(run.provider.launches).toHaveLength(1);
  });

  it("starts no effect when the channel is cut before the tool call reaches the controller", async () => {
    const probed = await probe();
    const run = await fixture({
      faults: { cutBeforeGuestFrame: once((frame) => frame.type === "tool.call") },
      steps: [probed.step(), probed.step(), ...finishing],
    });
    const runId = await run.send("Append to the probe.");

    await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
    expect(await probed.lines()).toEqual([]);
    expect(await effects(run, runId)).toEqual([]);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "queued",
    );
    expect(await attempts(run, runId)).toEqual([
      { workerState: "released", stopPhase: "process_ended" },
    ]);

    await run.continueRun(runId);
    run.model.assertComplete();
    expect(await probed.lines()).toEqual(["ran"]);
    expect(await effects(run, runId)).toEqual([
      { kind: "bash", status: "completed" },
      { kind: "message_user", status: "completed" },
    ]);
  });

  it("keeps a guest effect whose result was lost uncertain and never runs it again", async () => {
    const probed = await probe();
    const run = await fixture({
      faults: { cutBeforeGuestFrame: once((frame) => frame.type === "tool.done") },
      steps: [
        probed.step(),
        probed.step(),
        {
          expect(request) {
            expect(toolResult(request)).toContain("its outcome is unknown");
          },
          response: {
            type: "tool",
            id: "say",
            name: "message_user",
            arguments: { message: "Unsure." },
          },
        },
        finishing[1]!,
      ],
    });
    const runId = await run.send("Append to the probe.");

    await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
    expect(await probed.lines()).toEqual(["ran"]);
    expect(await effects(run, runId)).toEqual([{ kind: "bash", status: "executing" }]);

    await run.continueRun(runId);
    run.model.assertComplete();
    expect(await probed.lines()).toEqual(["ran"]);
    expect(await effects(run, runId)).toEqual([
      { kind: "bash", status: "uncertain" },
      { kind: "message_user", status: "completed" },
    ]);
  });

  it("refuses a guest tool asked under a fence another claim replaced, and starts no second guest", async () => {
    const probed = await probe();
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
      steps: [probed.step(), ...finishing],
    });
    const runId = await run.send("Append to the probe.");
    const first = run.continueRun(runId).catch((error: unknown) => error);
    await reached.promise;

    await run.prisma.run.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
    expect(run.provider.launches).toHaveLength(1);
    held.resolve();
    await first;

    expect(await probed.lines()).toEqual([]);
    expect(await effects(run, runId)).toEqual([]);
  });

  it("never lets a runtime start a local tool once its attempt lost the run", async () => {
    let started = false;
    let refusal: unknown;
    const run = await fixture({
      steps: [],
      runtime: (prisma) => ({
        describe: () => ({
          id: "fenced",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: {
            streaming: true,
            compaction: false,
            tools: true,
            scripted: false,
            localTools: GUEST_TOOLS,
          },
        }),
        abort: async () => {},
        async *run(request) {
          yield { type: "tool", name: "bash", args: { command: "true" }, executionId: "late" };
          await prisma.$executeRaw`UPDATE runs SET "leaseFence" = "leaseFence" + 1 WHERE id = ${request.runId}`;
          refusal = await request.executeLocalTool!(
            "bash",
            { command: "true" },
            "late",
            async () => {
              started = true;
              return { text: "", isError: false, truncated: false, totalBytes: 0 };
            },
          ).catch((error: unknown) => (error as Error).message);
          yield { type: "done" };
        },
      }),
    });
    const runId = await run.send("Run true.");
    await run.continueRun(runId);

    expect(started).toBe(false);
    expect(refusal).toBe("This attempt no longer holds the run, so bash did not start.");
    expect(await effects(run, runId)).toEqual([{ kind: "bash", status: "intended" }]);
  });

  it("runs nothing a restarted controller finds waiting for approval until the answer is stored", async () => {
    const probed = await probe();
    const run = await fixture({
      steps: [probed.step(), probed.step(), probed.step(), ...finishing],
    });
    await run.prisma.actionApprovalRule.create({
      data: {
        spaceId: run.spaceId,
        createdByUserId: run.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "bash",
      },
    });
    const runId = await run.send("Append to the probe.");
    await run.continueRun(runId);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "waiting_input",
    );
    expect(await attempts(run, runId)).toEqual([
      { workerState: "released", stopPhase: "process_ended" },
    ]);
    const before = run.restart();

    // A continue before the answer may ask the model again; it only asks for approval again.
    await run.continueRun(runId);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "waiting_input",
    );
    expect(await probed.lines()).toEqual([]);
    expect(await effects(run, runId)).toEqual([{ kind: "bash", status: "intended" }]);

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
    expect(await probed.lines()).toEqual(["ran"]);
    expect(await effects(run, runId)).toEqual([
      { kind: "bash", status: "completed" },
      { kind: "message_user", status: "completed" },
    ]);
    expect(before.launches).toHaveLength(1);
  });
});
