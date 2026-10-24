import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AgentRunRequest, WorkerProvider } from "@rakazo/adapter-kit";
import { AgentRuntimeUnavailableError } from "@rakazo/adapter-kit";
import type { E2BWorkerSdk } from "@rakazo/adapters";
import { createWorkerLifecycle, E2BWorkerProvider } from "@rakazo/adapters";
import type { GuestConnector, WorkerClock } from "@rakazo/adapters/runtime-worker";
import {
  createLifecycleLauncher,
  createStopJournal,
  createWorkerAgentRuntime,
  encodeFrameLine,
  readFrameLines,
  WORKER_LIMITS,
  WORKER_NATIVE_TOOLS,
} from "@rakazo/adapters/runtime-worker";
import { HARNESSES, runGuest } from "@rakazo/agent-run-worker";
import type { StopPhase } from "@rakazo/core";
import { stopState } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalWorkerFaults } from "./local-worker-provider.js";
import { LocalWorkerProvider } from "./local-worker-provider.js";
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

type Worker<P> = { provider: P; dispose(): Promise<void> };

function local(mode: "memory" | "child", faults: LocalWorkerFaults) {
  return (root: string): Worker<LocalWorkerProvider> => {
    const provider = new LocalWorkerProvider({ mode, root, faults });
    return { provider, dispose: () => provider.dispose() };
  };
}

/**
 * E2B's command API in front of an in-process guest that ignores its cancel. Its stdio is text, and
 * killing the sandbox breaks the command's stream without an exit code, as a lost VM does.
 */
function e2bIgnoringCancel(root: string): Worker<E2BWorkerProvider> {
  const sandboxes = new Map<string, Record<string, string>>();
  const guests: Array<{ kill(): void; exited: Promise<unknown> }> = [];
  const sdk: E2BWorkerSdk = {
    listSandboxes: async (metadata) =>
      [...sandboxes]
        .filter(([, tags]) => Object.entries(metadata).every(([key, value]) => tags[key] === value))
        .map(([id]) => id),
    createSandbox: async (options) => {
      const id = `sbx_${sandboxes.size + 1}`;
      sandboxes.set(id, options.metadata ?? {});
      return id;
    },
    killSandbox: async (id) => {
      for (const guest of guests) guest.kill();
      return sandboxes.delete(id);
    },
    async startGuest(_id, _command, { envs, onStdout }) {
      const stdin = new PassThrough({ encoding: "utf8" });
      const terminated = new AbortController();
      const stream = Promise.withResolvers<number>();
      async function* channels() {
        yield {
          frames: readFrameLines(stdin, WORKER_LIMITS.controllerFrameBytes),
          send: (frame: Uint8Array) => onStdout(encodeFrameLine(frame)),
          close: () => stdin.end(),
        };
      }
      const exited = runGuest({
        channels: channels(),
        capability: envs.RAKAZO_WORKER_CAPABILITY!,
        harness: HARNESSES["pi-native"]!,
        spoolDir: path.join(root, "tmp", "tool-output"),
        root,
        home: path.join(root, "home/user"),
        signal: terminated.signal,
      });
      guests.push({
        exited,
        kill() {
          terminated.abort();
          stdin.end();
          stream.reject(new Error("stream reset"));
        },
      });
      return {
        sendStdin: async (line) => {
          if (stdin.writableEnded) throw new Error("stdin closed");
          const kind = JSON.parse(Buffer.from(line, "base64").toString()).kind;
          if (kind !== "worker.cancel") stdin.write(line);
        },
        closeStdin: async () => void stdin.end(),
        wait: () => stream.promise,
      };
    },
    listVolumes: async () => [],
    createVolume: async (name) => name,
  };
  return {
    provider: new E2BWorkerProvider(
      { apiKey: "e2b-test-key", template: "rakazo-worker-pi-native" },
      sdk,
    ),
    async dispose() {
      for (const guest of guests) guest.kill();
      await Promise.allSettled(guests.map((guest) => guest.exited));
    },
  };
}

/** A running run whose bot sleeps in a guest bash call, driven through the runtime alone. */
async function sleepingRun<P extends WorkerProvider & GuestConnector>(
  worker: (root: string) => Worker<P>,
  clock?: WorkerClock,
  failingPhase?: StopPhase,
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
  const { provider, dispose } = worker(root);
  cleanups.push(async () => {
    await dispose();
    await rm(root, { recursive: true, force: true });
  });
  const marks: string[] = [];
  const journal = createStopJournal(fixture.prisma);
  const lifecycle = createWorkerLifecycle({ prisma: fixture.prisma, provider });
  /** The runtime the executor would bind to this attempt's plan: no files, no computer. */
  const runtimeFor = async (attempt: { id: string }) => {
    const launch = await lifecycle.plan({
      attemptId: attempt.id,
      needs: { files: { private: null, shared: null }, computer: "none" },
    });
    if (launch.mode !== "worker") throw new Error(`No worker plan: ${launch.mode}`);
    return createWorkerAgentRuntime({
      launcher: createLifecycleLauncher({
        prisma: fixture.prisma,
        lifecycle,
        connector: provider,
        launch,
      }),
      stops: {
        mark: async (attemptId, phase) => {
          marks.push(phase);
          if (phase === failingPhase) throw new Error("The journal is unreachable");
          await journal.mark(attemptId, phase);
        },
      },
      clock,
    });
  };
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
    tools: [...WORKER_NATIVE_TOOLS],
    model: fixture.model.model,
    attempt,
    executeTool: async () => "unused",
  });
  const attempt = await claim(1);
  const runtime = await runtimeFor(attempt);
  const events = (async () => {
    for await (const event of runtime.run(runRequest(attempt))) {
      if (event.type === "progress" && event.text.startsWith("bash ")) napping.resolve();
    }
  })().catch((error: unknown) => error);
  await napping.promise;
  const row = () =>
    fixture.prisma.attempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { workerState: true, stopPhase: true },
    });
  return { fixture, provider, runtime, runtimeFor, runId, marks, events, row, claim, runRequest };
}

describe("stopping a guest", () => {
  it("destroys a guest that ignores its cancel within the stop budget", async () => {
    const run = await sleepingRun(local("child", { guestIgnoresCancel: true }));
    const startedAt = Date.now();

    await run.runtime.abort(run.runId);

    expect(Date.now() - startedAt).toBeLessThan(WORKER_LIMITS.stopConfirmMs);
    expect(run.marks).toEqual(["requested", "process_ended"]);
    expect(stopState(await run.row())).toBe("destroyed");
    expect(await run.events).toEqual(new Error("The run was cancelled"));
  });

  it("confirms the stop of an E2B guest whose stream breaks before it is seen exiting", async () => {
    const time = manualClock();
    const run = await sleepingRun(e2bIgnoringCancel, time.clock);

    const aborted = run.runtime.abort(run.runId);
    await vi.waitFor(() => expect(time.sleeping()).toContain(WORKER_LIMITS.cancelGraceMs));
    expect(run.marks).toEqual(["requested"]);
    time.advance(WORKER_LIMITS.cancelGraceMs);
    await aborted;

    expect(run.marks).toEqual(["requested", "process_ended"]);
    expect(stopState(await run.row())).toBe("destroyed");
    expect(await run.events).toEqual(new Error("The run was cancelled"));
  });

  it("records an unconfirmed stop, never a destroyed one, and starts no other guest", async () => {
    const time = manualClock();
    const run = await sleepingRun(local("memory", { destroyNeverConfirms: true }), time.clock);

    const aborted = run.runtime.abort(run.runId);
    const confirmWindow = WORKER_LIMITS.stopConfirmMs - WORKER_LIMITS.cancelGraceMs;
    await vi.waitFor(() => expect(time.sleeping()).toContain(confirmWindow));
    time.advance(confirmWindow);
    await aborted;

    expect(run.marks).toEqual(["requested", "process_ended", "unconfirmed"]);
    expect(await run.row()).toEqual({ workerState: "releasing", stopPhase: "unconfirmed" });
    expect(stopState(await run.row())).toBe("unconfirmed");

    const second = await run.claim(2);
    const next = (await run.runtimeFor(second)).run(run.runRequest(second));
    await expect(next[Symbol.asyncIterator]().next()).rejects.toThrow(AgentRuntimeUnavailableError);
    expect(run.provider.launches).toHaveLength(1);
  });

  it("survives a stop journal write that fails after the stop went unconfirmed", async () => {
    const time = manualClock();
    const run = await sleepingRun(
      local("memory", { destroyNeverConfirms: true }),
      time.clock,
      "process_ended",
    );

    const aborted = run.runtime.abort(run.runId);
    const confirmWindow = WORKER_LIMITS.stopConfirmMs - WORKER_LIMITS.cancelGraceMs;
    await vi.waitFor(() => expect(time.sleeping()).toContain(confirmWindow));
    time.advance(confirmWindow);
    await aborted;

    expect(run.marks).toEqual(["requested", "process_ended", "unconfirmed"]);
    expect(stopState(await run.row())).toBe("unconfirmed");
  });
});
