import { runPersistence } from "@rakazo/db";
import { afterEach, expect, it } from "vitest";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const snapshot = {
  version: 1 as const,
  harness: { name: "other-harness", format: "fixture-v1" },
  revision: 1,
  state: "{}",
  deliveredEvents: [],
  pendingCallIds: ["native-1"],
};

it("buffers results without writing a checkpoint, masks secrets and consumes a saved pause once", async () => {
  const run = await startWorkerRun({ steps: [] });
  cleanups.push(() => run.close());
  const runId = await run.send("Neutral pause fixture");
  await run.prisma.run.update({ where: { id: runId }, data: { status: "running", leaseFence: 1 } });
  const secrets = ["fixture-first-secret"];
  const store = await runPersistence(run.prisma, runId, 1, secrets, false);
  expect(store.start).toEqual({ mode: "fresh" });
  await store.begin();
  await store.receipt({
    callId: "native-1",
    name: "read",
    args: { query: "fixture-first-secret" },
    outcome: { kind: "paused", output: "waiting" },
  });
  await store.receipt({
    callId: "native-1",
    name: "read",
    args: { query: "fixture-first-secret" },
    outcome: {
      kind: "result",
      output: "fixture-first-secret fixture-later-secret",
      isError: false,
    },
  });
  await store.receipt({
    callId: "already-in-native-history",
    name: "read",
    args: {},
    outcome: { kind: "result", output: "old result", isError: false },
  });
  expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
  await store.save({ ...snapshot, state: '"fixture-first-secret fixture-later-secret"' });
  const row = await run.prisma.runSnapshot.findUniqueOrThrow({ where: { runId } });
  expect(JSON.stringify(row)).not.toContain("fixture-first-secret");
  expect(JSON.stringify(row.receipts)).not.toContain("already-in-native-history");
  secrets.push("fixture-later-secret");
  const restored = await runPersistence(run.prisma, runId, 1, secrets, false);
  expect(restored.start.mode).toBe("resume");
  expect(JSON.stringify(restored.start)).not.toContain("fixture-later-secret");
  await restored.begin();
  expect(await restored.resolve()).toEqual([
    {
      callId: "native-1",
      name: "read",
      args: { query: "[redacted]" },
      outcome: { kind: "result", output: "[redacted] [redacted]", isError: false },
    },
  ]);
  expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
  await expect(runPersistence(run.prisma, runId, 1, secrets, false)).rejects.toThrow(
    "pause snapshot is missing",
  );
});

it("rejects stale fences and overflow without changing a saved pause", async () => {
  const run = await startWorkerRun({ steps: [] });
  cleanups.push(() => run.close());
  const runId = await run.send("Pause fence fixture");
  await run.prisma.run.update({ where: { id: runId }, data: { status: "running", leaseFence: 1 } });
  const store = await runPersistence(run.prisma, runId, 1, [], false);
  await store.begin();
  await store.save(snapshot);
  const before = await run.prisma.runSnapshot.findUniqueOrThrow({ where: { runId } });
  await expect(
    store.save({ ...snapshot, revision: 2, state: "x".repeat(4 * 1024 * 1024) }),
  ).rejects.toThrow("transfer limit");
  await run.prisma.run.update({ where: { id: runId }, data: { leaseFence: 2 } });
  await expect(store.save({ ...snapshot, revision: 2 })).rejects.toThrow("fence");
  await expect(runPersistence(run.prisma, runId, 1, [], false)).rejects.toThrow("fence");
  expect(await run.prisma.runSnapshot.findUniqueOrThrow({ where: { runId } })).toEqual(before);
  await run.prisma.run.delete({ where: { id: runId } });
  expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
});

it.each(["completed", "failed", "cancelled"] as const)(
  "deletes a saved pause when a run becomes %s",
  async (status) => {
    const run = await startWorkerRun({ steps: [] });
    cleanups.push(() => run.close());
    const runId = await run.send("Pause retention fixture");
    await run.prisma.run.update({
      where: { id: runId },
      data: { status: "running", leaseFence: 1 },
    });
    const store = await runPersistence(run.prisma, runId, 1, [], false);
    await store.begin();
    await store.save(snapshot);
    await run.prisma.run.update({ where: { id: runId }, data: { status } });
    expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
    expect(await run.prisma.run.count({ where: { id: runId } })).toBe(1);
  },
);
