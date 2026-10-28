import { runPersistence } from "@rakazo/db";
import { afterEach, expect, it } from "vitest";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("rejects stale fences and oversized snapshots without replacing the last committed state, and deletes state with its run", async () => {
  const run = await startWorkerRun({ steps: [] });
  cleanups.push(() => run.close());
  const runId = await run.send("Neutral snapshot fixture");
  await run.prisma.run.update({ where: { id: runId }, data: { status: "running", leaseFence: 1 } });
  const initial = await runPersistence(run.prisma, runId, 1, [], false);
  await initial.save({
    version: 1,
    harness: { name: "other-harness", format: "fixture-v1" },
    revision: 1,
    state: "{}",
    deliveredEvents: [],
  });
  const current = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const store = await runPersistence(run.prisma, runId, current.leaseFence, [], false);
  if (store.start.mode !== "resume") throw new Error("Missing native state");
  const snapshot = store.start.snapshot;
  const stale = await runPersistence(run.prisma, runId, current.leaseFence - 1, [], false);
  await expect(stale.save({ ...snapshot, revision: snapshot.revision + 1 })).rejects.toThrow(
    "fence",
  );
  await expect(
    store.save({
      ...snapshot,
      revision: snapshot.revision + 1,
      state: "x".repeat(4 * 1024 * 1024),
    }),
  ).rejects.toThrow("transfer limit");
  expect((await runPersistence(run.prisma, runId, current.leaseFence, [], false)).start).toEqual(
    store.start,
  );
  await run.prisma.run.delete({ where: { id: runId } });
  expect(await run.prisma.$queryRaw`SELECT * FROM run_snapshots WHERE "runId" = ${runId}`).toEqual(
    [],
  );
});

it.each(["completed", "failed", "cancelled"] as const)(
  "deletes snapshots and receipts when a run becomes %s without deleting the run",
  async (status) => {
    const run = await startWorkerRun({ steps: [] });
    cleanups.push(() => run.close());
    const runId = await run.send("Resume retention fixture");
    await run.prisma.run.update({
      where: { id: runId },
      data: { status: "running", leaseFence: 1 },
    });
    const store = await runPersistence(run.prisma, runId, 1, [], false);
    await store.save({
      version: 1,
      harness: { name: "other-harness", format: "fixture-v1" },
      revision: 1,
      state: "{}",
      deliveredEvents: [],
    });
    await store.receipt({
      callId: "retained-call",
      name: "read",
      args: {},
      outcome: { kind: "result", output: "retained result", isError: false },
    });
    await run.prisma.run.update({ where: { id: runId }, data: { status } });
    expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
    expect(await run.prisma.run.count({ where: { id: runId } })).toBe(1);
  },
);

it("stores another harness's opaque state and masks snapshot and receipt secrets against the live policy on both write and read", async () => {
  const run = await startWorkerRun({ steps: [] });
  cleanups.push(() => run.close());
  const runId = await run.send("Neutral harness fixture");
  await run.prisma.run.update({ where: { id: runId }, data: { status: "running", leaseFence: 1 } });
  const secrets = ["fixture-first-secret"];
  const store = await runPersistence(run.prisma, runId, 1, secrets, false);
  expect(store.start).toEqual({ mode: "fresh" });
  secrets.push("fixture-second-secret");
  await store.save({
    version: 1,
    harness: { name: "other-harness", format: "fixture-v1" },
    deliveredEvents: [],
    revision: 1,
    state: JSON.stringify({
      branch: "left",
      text: "fixture-first-secret fixture-second-secret fixture-later-secret",
    }),
  });
  await store.receipt({
    callId: "native-1",
    name: "read",
    args: { query: "fixture-second-secret" },
    outcome: { kind: "started" },
  });
  await store.receipt({
    callId: "native-1",
    name: "read",
    args: { query: "fixture-second-secret" },
    outcome: {
      kind: "result",
      output: { text: `fixture-second-secret ${"z".repeat(6000)}` },
      isError: true,
    },
  });
  const [row] = await run.prisma.$queryRaw<
    { snapshot: unknown; receipts: unknown }[]
  >`SELECT snapshot, receipts FROM run_snapshots WHERE "runId" = ${runId}`;
  expect(JSON.stringify(row)).not.toContain("fixture-first-secret");
  expect(JSON.stringify(row)).not.toContain("fixture-second-secret");
  secrets.push("fixture-later-secret");
  const restored = await runPersistence(run.prisma, runId, 1, secrets, false);
  expect(restored.start.mode).toBe("resume");
  expect(JSON.stringify(restored.start)).not.toContain("fixture-later-secret");
  expect(await restored.resolve()).toEqual([
    expect.objectContaining({
      callId: "native-1",
      outcome: {
        kind: "result",
        output: { text: `[redacted] ${"z".repeat(6000)}` },
        isError: true,
      },
    }),
  ]);
  await run.prisma.runSnapshot.delete({ where: { runId } });
  await expect(
    store.save({
      version: 1,
      harness: { name: "other-harness", format: "fixture-v1" },
      revision: 2,
      state: "{}",
      deliveredEvents: [],
    }),
  ).rejects.toThrow("snapshot is missing");
  await expect(store.resolve()).rejects.toThrow("snapshot is missing");
});
