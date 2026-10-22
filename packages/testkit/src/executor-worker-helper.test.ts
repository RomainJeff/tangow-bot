import { createWorkerAgentRuntime, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import { afterEach, expect, it } from "vitest";
import {
  manualLauncher,
  rawGuest,
} from "../../adapters/src/runtime-worker/raw-guest.test-support.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function pausedHelper() {
  const launcher = manualLauncher();
  const sleeps = new Map<number, () => void>();
  const runtime = createWorkerAgentRuntime({
    launcher: launcher.launcher,
    stops: { mark: async () => undefined },
    clock: { sleep: (ms) => new Promise<void>((resolve) => sleeps.set(ms, resolve)) },
  });
  const run = await startWorkerRun({
    steps: [],
    computerScope: "none",
    runtime: () => runtime,
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Plan my trip.");
  const continued = run.continueRun(runId);
  const launched = await launcher.launchedFor(runId);
  const guest = rawGuest(launched.connect(), launched.capability, {
    name: "pi-native",
    capabilities: ["native-loop", "subagents"],
  });
  await guest.hello();
  guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "helper" });
  guest.send(2, {
    type: "tool.call",
    agent: "root",
    callId: "helper",
    name: "run_subagent",
    args: { name: "Planner", task: "Choose a city" },
  });
  expect((await guest.replies(2, 1))[0]).toMatchObject({
    type: "subagent.start",
    agent: "helper:1",
  });
  guest.send(3, { type: "tool", name: "ask_user", args: {}, executionId: "question" });
  guest.send(4, {
    type: "tool.call",
    agent: "helper:1",
    callId: "question",
    name: "ask_user",
    args: { question: "Which city?", options: ["Paris", "Lyon"] },
  });
  expect(await guest.replies(4)).toMatchObject([
    { type: "tool.result", output: { details: { ask: "paused" }, terminate: true } },
  ]);
  expect((await guest.replies(2)).at(-1)).toEqual({
    type: "tool.result",
    output: "Stopped: the run is waiting for the user.",
  });
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "waiting_input",
  );
  const helper = await run.prisma.run.findFirstOrThrow({ where: { parentRunId: runId } });
  return { run, runId, helper, guest, runtime, continued, sleeps };
}

it("persists the helper's native call and result after its parent has paused and settled", async () => {
  const { run, runId, helper, guest, continued } = await pausedHelper();
  guest.send(5, {
    type: "transcript",
    agent: "helper:1",
    dialect: "pi-ai",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } },
        ],
      },
      { role: "toolResult", toolCallId: "read-1", content: "Paris notes", isError: false },
    ],
  });
  expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);
  guest.send(6, { type: "done" });
  await continued;
  expect(
    (await run.runEntries(helper.id)).filter(
      (entry) => entry.type === "tool.call" || entry.type === "tool.result",
    ),
  ).toMatchObject([
    { type: "tool.call", payload: { callId: "read-1", name: "read" } },
    { type: "tool.result", payload: { callId: "read-1", output: "Paris notes", isError: false } },
  ]);
  expect(
    (await run.runEntries(runId)).filter((entry) => entry.type === "assistant.ask"),
  ).toHaveLength(1);
  expect(
    await run.prisma.run.findUniqueOrThrow({
      where: { id: helper.id },
      select: { status: true, task: { select: { status: true } } },
    }),
  ).toEqual({ status: "completed", task: { status: "completed" } });
});

it.each(["done", "finish", "abandon", "grace", "cancel"] as const)(
  "closes a paused helper with no final transcript on %s",
  async (end) => {
    const { run, runId, helper, guest, runtime, continued, sleeps } = await pausedHelper();
    if (end === "done") guest.send(5, { type: "done" });
    else if (end === "finish" || end === "abandon") {
      guest.send(
        5,
        end === "finish"
          ? { type: "subagent.finish", agent: "helper:1", status: "completed", result: "Done." }
          : { type: "subagent.abandon", agent: "helper:1", result: "The guest stopped" },
      );
      expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);
      guest.send(6, { type: "done" });
    } else if (end === "grace") sleeps.get(WORKER_LIMITS.pausedGraceMs)!();
    else await runtime.abort(runId);
    await continued;
    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: helper.id },
        select: { status: true, task: { select: { status: true } } },
      }),
    ).toEqual({ status: "completed", task: { status: "completed" } });
    expect(
      (await run.runEntries(helper.id)).filter((entry) => entry.type === "run.finished"),
    ).toHaveLength(1);
  },
);
