import { afterEach, describe, expect, it } from "vitest";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

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

const recap = JSON.stringify({ version: 1, results: ["Wrote notes.txt"], references: [] });

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
});
