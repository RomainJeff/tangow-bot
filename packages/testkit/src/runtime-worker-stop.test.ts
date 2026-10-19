import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRunRequest, AgentRuntimeUnavailableError } from "@rakazo/adapter-kit";
import { createWorkerLifecycle } from "@rakazo/adapters";
import {
  createLifecycleLauncher,
  createStopJournal,
  createWorkerAgentRuntime,
  GUEST_TOOLS,
  WORKER_LIMITS,
  type WorkerClock,
} from "@rakazo/adapters/runtime-worker";
import { stopState } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LocalWorkerFaults, LocalWorkerProvider } from "./local-worker-provider.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Sleeps that end only when the test moves time. */
function manualClock() {
  let now = 0;
  const sleeping: Array<{ until: number; wake: () => void }> = [];
  const clock: WorkerClock = {
    sleep: (ms) => new Promise((wake) => sleeping.push({ until: now + ms, wake })),
  };
  return {
    clock,
    sleeping: () => sleeping.map((sleep) => sleep.until - now),
    advance(ms: number) {
      now += ms;
      for (const sleep of sleeping.filter((entry) => entry.until <= now)) {
        sleeping.splice(sleeping.indexOf(sleep), 1);
        sleep.wake();
      }
    },
  };
}

/** A running run whose bot sleeps in a guest bash call, driven through the runtime alone. */
async function sleepingRun(
  mode: "memory" | "child",
  faults: LocalWorkerFaults,
  clock?: WorkerClock,
) {
  const fixture = await startWorkerRun({
    steps: [
      {
        expect() {},
        response: { type: "tool", id: "nap", name: "bash", arguments: { command: "sleep 30" } },
      },
    ],
  });
  cleanups.push(() => fixture.close());
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-worker-stop-"));
  const provider = new LocalWorkerProvider({ mode, root, faults });
  cleanups.push(async () => {
    await provider.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const marks: string[] = [];
  const journal = createStopJournal(fixture.prisma);
  const runtime = createWorkerAgentRuntime({
    launcher: createLifecycleLauncher({
      prisma: fixture.prisma,
      lifecycle: createWorkerLifecycle({ prisma: fixture.prisma, provider }),
      connector: provider,
    }),
    stops: {
      mark: async (attemptId, phase) => {
        marks.push(phase);
        await journal.mark(attemptId, phase);
      },
    },
    clock,
  });
  const runId = await fixture.send("Take a nap.");
  const claim = async (fence: number) => {
    await fixture.prisma.run.update({
      where: { id: runId },
      data: { status: "running", leaseOwner: "stop-test", leaseFence: fence },
    });
    return fixture.prisma.attempt.create({ data: { runId, fence, status: "running" } });
  };
  const napping = Promise.withResolvers<void>();
  const runRequest = (attempt: { id: string; fence: number }): AgentRunRequest => ({
    botId: fixture.bot.id,
    threadId: fixture.thread.id,
    runId,
    prompt: "Take a nap.",
    instructions: "Use bash.",
    history: [],
    tools: [...GUEST_TOOLS],
    model: fixture.model.model,
    attempt,
    executeTool: async () => "unused",
    executeLocalTool: async (_name, _args, _id, start) => {
      napping.resolve();
      return start(new AbortController().signal);
    },
  });
  const attempt = await claim(1);
  const events = (async () => {
    for await (const _event of runtime.run(runRequest(attempt))) {
    }
  })().catch((error: unknown) => error);
  await napping.promise;
  const row = () =>
    fixture.prisma.attempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { workerState: true, stopPhase: true },
    });
  return { fixture, provider, runtime, runId, marks, events, row, claim, runRequest };
}

describe("stopping a guest", () => {
  it("destroys a guest that ignores its cancel within the stop budget", async () => {
    const run = await sleepingRun("child", { guestIgnoresCancel: true });
    const startedAt = Date.now();

    await run.runtime.abort(run.runId);

    expect(Date.now() - startedAt).toBeLessThan(WORKER_LIMITS.stopConfirmMs);
    expect(run.marks).toEqual(["requested", "process_ended"]);
    expect(stopState(await run.row())).toBe("destroyed");
    expect(await run.events).toEqual(new Error("The run was cancelled"));
  });

  it("records an unconfirmed stop, never a destroyed one, and starts no other guest", async () => {
    const time = manualClock();
    const run = await sleepingRun("memory", { destroyNeverConfirms: true }, time.clock);

    const aborted = run.runtime.abort(run.runId);
    const confirmWindow = WORKER_LIMITS.stopConfirmMs - WORKER_LIMITS.cancelGraceMs;
    await vi.waitFor(() => expect(time.sleeping()).toContain(confirmWindow));
    time.advance(confirmWindow);
    await aborted;

    expect(run.marks).toEqual(["requested", "process_ended", "unconfirmed"]);
    expect(await run.row()).toEqual({ workerState: "releasing", stopPhase: "unconfirmed" });
    expect(stopState(await run.row())).toBe("unconfirmed");

    const next = run.runtime.run(run.runRequest(await run.claim(2)));
    await expect(next[Symbol.asyncIterator]().next()).rejects.toThrow(AgentRuntimeUnavailableError);
    expect(run.provider.launches).toHaveLength(1);
  });
});
