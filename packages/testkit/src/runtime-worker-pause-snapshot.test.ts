import { isToolPauseResult, readControllerFrame } from "@rakazo/adapters/runtime-worker/wire";
import { afterEach, expect, it } from "vitest";
import { latestCard } from "./index.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("checkpoints each settled tool batch at a pause without another model request", async () => {
  let expectedWrites = 0;
  const checkWrites = async () => {
    expect(
      await run.prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM pause_snapshot_audit`,
    ).toEqual([{ count: expectedWrites }]);
  };
  const question = (id: string) => ({
    type: "tool" as const,
    id,
    name: "ask_user",
    arguments: { message: "Which city?", options: ["Paris", "Lyon"] },
  });
  const run = await startWorkerRun({
    mode: "child",
    steps: [
      {
        expect: checkWrites,
        response: {
          type: "tool",
          id: "note",
          name: "scratchpad_add",
          arguments: { title: "Plan" },
        },
      },
      {
        expect: checkWrites,
        response: {
          ...question("first-question"),
          siblings: [
            {
              id: "native-result",
              name: "bash",
              arguments: { command: "printf 'Native pause result'" },
            },
          ],
        },
      },
      {
        expect(request) {
          return checkWrites().then(() =>
            expect(request.messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "tool",
                  tool_call_id: "native-result",
                  content: expect.stringContaining("Native pause result"),
                }),
              ]),
            ),
          );
        },
        response: question("second-question"),
      },
      {
        expect: checkWrites,
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Done." },
        },
      },
      { expect: checkWrites, response: { type: "text", text: "" } },
    ],
  });
  cleanups.push(() => run.close());
  await run.prisma
    .$executeRaw`CREATE TABLE pause_snapshot_audit (revision int NOT NULL, phase text NOT NULL)`;
  await run.prisma
    .$executeRaw`CREATE FUNCTION audit_pause_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO pause_snapshot_audit SELECT (NEW.snapshot->>'revision')::int, status FROM runs WHERE id = NEW."runId"; RETURN NEW; END; $$`;
  await run.prisma
    .$executeRaw`CREATE TRIGGER audit_pause_snapshot AFTER INSERT OR UPDATE ON run_snapshots FOR EACH ROW EXECUTE FUNCTION audit_pause_snapshot()`;
  const runId = await run.send("Prepare a note, then ask twice.");
  for (const revision of [1, 2]) {
    await run.continueRun(runId);
    expect(run.model.requests).toHaveLength(revision + 1);
    expectedWrites = revision;
    await checkWrites();
    expect(
      await run.prisma
        .$queryRaw`SELECT phase FROM pause_snapshot_audit WHERE revision = ${revision}`,
    ).toEqual([{ phase: "waiting_input" }]);
    const row = await run.prisma.runSnapshot.findUniqueOrThrow({ where: { runId } });
    expect(row.snapshot).toMatchObject({ revision });
    expect(row.receipts).toEqual([
      expect.objectContaining({
        name: "ask_user",
        outcome: expect.objectContaining({ kind: "paused" }),
      }),
    ]);
    expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(1);
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
  }
  await run.continueRun(runId);
  run.model.assertComplete();
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "completed",
  );
  expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
  await checkWrites();
});

it("fails explicitly on a checkpoint write error without compacting the paused session", async () => {
  const run = await startWorkerRun({
    mode: "child",
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "question",
          name: "ask_user",
          arguments: { message: "Which city?", options: ["Paris", "Lyon"] },
          usage: { promptTokens: 1_000_000, completionTokens: 1 },
        },
      },
    ],
  });
  cleanups.push(() => run.close());
  await run.prisma
    .$executeRaw`CREATE FUNCTION reject_pause_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'fixture checkpoint write failed'; END; $$`;
  await run.prisma
    .$executeRaw`CREATE TRIGGER reject_pause_snapshot BEFORE INSERT ON run_snapshots FOR EACH ROW EXECUTE FUNCTION reject_pause_snapshot()`;
  const runId = await run.send("Ask me a question.");
  await run.continueRun(runId);
  const ended = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
  expect(ended.status).toBe("failed");
  expect(ended.error).toContain("fixture checkpoint write failed");
  expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
  expect(run.model.requests).toHaveLength(1);
  run.model.assertComplete();
});

it("waits for the pause checkpoint when an answer arrives before the worker closes", async () => {
  let runId = "";
  const run = await startWorkerRun({
    mode: "child",
    connector(provider) {
      return {
        connect(target, capability) {
          const guest = provider.connect(target, capability);
          return {
            ...guest,
            connections: (async function* () {
              for await (const channel of guest.connections) {
                yield {
                  ...channel,
                  async send(frame: Uint8Array) {
                    const read = readControllerFrame(frame);
                    if (read.ok && read.message.kind === "worker.reply") {
                      const { body } = read.message.payload;
                      if (body.type === "tool.result" && isToolPauseResult(body.output)) {
                        await answerBeforeClose();
                      }
                    }
                    await channel.send(frame);
                  },
                };
              }
            })(),
          };
        },
      };
    },
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "question",
          name: "ask_user",
          arguments: { message: "Which city?", options: ["Paris", "Lyon"] },
        },
      },
      {
        expect(request) {
          expect(JSON.stringify(request.messages).split("Also include travel dates.")).toHaveLength(
            2,
          );
          expect(request.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "tool",
                tool_call_id: "question",
                content: expect.stringContaining("Paris"),
              }),
            ]),
          );
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
  const answerBeforeClose = async () => {
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
    await expect(run.continueRun(runId)).rejects.toThrow("has not finished its pause");
    await run.lifecycle.reconcile(
      { limit: 10 },
      {
        operationId: "pause-test",
        traceId: runId,
        spaceId: run.spaceId,
        userId: run.userId,
        signal: new AbortController().signal,
      },
    );
    const attempt = await run.prisma.attempt.findFirstOrThrow({ where: { runId } });
    expect(attempt.workerState).toBe("ready");
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).leaseFence).toBe(1);
  };
  runId = await run.send("Choose a city.");
  await run.continueRun(runId);
  expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(1);
  await run.restart().dispose();
  await run.continueRun(runId);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "completed",
  );
  run.model.assertComplete();
});
