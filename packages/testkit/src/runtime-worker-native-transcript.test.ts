import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConnectorProvider } from "@rakazo/adapter-kit";
import type { GuestHarness } from "@rakazo/agent-run-worker";
import { HARNESSES } from "@rakazo/agent-run-worker";
import { cancelRunsInTransaction } from "@rakazo/db";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { afterPrivateText, startWorkerRun } from "./worker-run-fixture.js";

type WorkerRun = Awaited<ReturnType<typeof startWorkerRun>>;

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "rakazo-native-transcript-home-"));
  vi.stubEnv("HOME", home);
  onTestFinished(() => rm(home, { recursive: true, force: true }));
});
afterEach(() => vi.unstubAllEnvs());

async function fixture(
  steps: ModelEmulatorStep[],
  options: Partial<Parameters<typeof startWorkerRun>[0]> = {},
) {
  const run = await startWorkerRun({ steps, harness: HARNESSES["pi-native"]!, ...options });
  onTestFinished(() => run.close());
  return run;
}

/** A file outside every guest, so it shows how often a command ran. */
async function probe() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-native-probe-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "probe.txt");
  return {
    command: (then = "") => `echo ran >> ${file}${then}`,
    lines: async () => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}

const settled = (running: Promise<unknown>) =>
  running.then(
    () => "done",
    (error: Error) => error.message,
  );

const bash = (id: string, command: string): ModelEmulatorStep => ({
  expect() {},
  response: { type: "tool", id, name: "bash", arguments: { command } },
});

/** Each call and result of the run, in the session's order, which history replays. */
async function toolLog(run: WorkerRun, runId: string, outputs = false) {
  return (await run.runEntries(runId))
    .toSorted((a, b) => a.seq - b.seq)
    .flatMap((entry) =>
      entry.type === "tool.call"
        ? [`call ${entry.payload.name} ${entry.payload.callId}`]
        : entry.type === "tool.result"
          ? [`result ${entry.payload.callId}${outputs ? ` ${entry.payload.output}` : ""}`]
          : [],
    );
}

const interrupted = (tool: string) =>
  `The ${tool} call was interrupted, so its outcome is unknown. It was not replayed; check the state before retrying.`;

/** The lines of the run's earlier work a retried attempt reads back, before its prompt. */
const earlierWork = (request: ModelEmulatorRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) => {
    const text = typeof message.content === "string" ? message.content : "";
    const work = /^<assistant_turn>\n([\s\S]*)\n<\/assistant_turn>$/.exec(text)?.[1];
    return work ? work.split("\n") : [];
  });

it("reminds a model that ended on private text to send it, so the person reads the answer", async () => {
  const run = await fixture([
    { expect() {}, response: { type: "text", text: "Paris." } },
    {
      ...afterPrivateText,
      response: {
        type: "tool",
        id: "say",
        name: "message_user",
        arguments: { message: "Paris." },
      },
    },
    { expect() {}, response: { type: "text", text: "" } },
  ]);
  const runId = await run.send("Which city?");
  await run.continueRun(runId);

  run.model.assertComplete();
  const toPerson = (await run.runEntries(runId)).flatMap((entry) =>
    entry.type === "assistant.text" && entry.payload.toPerson ? entry.payload.blocks : [],
  );
  expect(toPerson).toEqual([expect.objectContaining({ kind: "text", text: "Paris." })]);
});

it("shows the next attempt a native call whose guest died during it as unknown, and never runs it again", async () => {
  const probed = await probe();
  let retried: ModelEmulatorRequest | undefined;
  const run = await fixture([
    bash("slow", probed.command("; sleep 30")),
    {
      expect(request) {
        retried = request;
      },
      response: { type: "text", text: "I could not tell whether it ran." },
    },
    afterPrivateText,
  ]);
  const runId = await run.send("Append to the probe.");
  const first = settled(run.continueRun(runId));
  await expect.poll(probed.lines, { timeout: 10_000 }).toEqual(["ran"]);
  await run.provider.destroy({ attemptId: run.provider.launches[0]!, providerRef: null }, null!);
  expect(await first).toBe("Run setup failed; retrying");
  expect(await toolLog(run, runId)).toEqual(["call bash slow"]);

  await run.continueRun(runId);
  run.model.assertComplete();
  expect(await probed.lines()).toEqual(["ran"]);
  expect(await toolLog(run, runId)).toEqual(["call bash slow", "result slow"]);
  expect(earlierWork(retried)).toEqual([
    `(already ran Bash, input: { "command": "${probed.command("; sleep 30")}" }, result: ${interrupted("bash")})`,
  ]);
});

it("logs native and controller calls along the session in the order the harness made them", async () => {
  const recap = JSON.stringify({ version: 1, results: ["Saved"], references: [] });
  const run = await fixture([
    bash("first", "echo one"),
    {
      expect() {},
      response: {
        type: "tool",
        id: "note",
        name: "mcp__rakazo__scratchpad_add",
        arguments: { title: "between" },
      },
    },
    bash("second", "echo two"),
    { expect() {}, response: { type: "text", text: recap } },
    afterPrivateText,
  ]);
  const runId = await run.send("Work in three steps.");
  await run.continueRun(runId);

  run.model.assertComplete();
  expect(
    (await toolLog(run, runId)).map((line) => line.replace(/ mcp-[\w-]+$/, " (controller)")),
  ).toEqual([
    "call bash first",
    "result first",
    "call scratchpad_add (controller)",
    "result (controller)",
    "call bash second",
    "result second",
  ]);
});

it("keeps the native work done before a cancel, and the call it cut, without running it again", async () => {
  const probed = await probe();
  const run = await fixture([bash("done", "echo one"), bash("cut", probed.command("; sleep 1"))]);
  const runId = await run.send("Work, then wait.");
  const working = settled(run.continueRun(runId));
  await expect.poll(probed.lines, { timeout: 10_000 }).toEqual(["ran"]);
  const { taskId } = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
  await run.prisma.$transaction((tx) =>
    cancelRunsInTransaction(tx, [{ id: runId, taskId }], new Date()),
  );
  await working;

  run.model.assertComplete();
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "cancelled",
  );
  expect(await toolLog(run, runId)).toEqual(["call bash done", "result done", "call bash cut"]);
  expect(await probed.lines()).toEqual(["ran"]);
});

it("hands a retried attempt a message its dead attempt claimed, once", async () => {
  const probed = await probe();
  const steering = "Also check the tests.";
  let reached!: () => void;
  const claimedAttemptAsked = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let claimed: ModelEmulatorRequest | undefined;
  let retried: ModelEmulatorRequest | undefined;
  const run = await fixture([
    bash("wait", probed.command("; sleep 1")),
    {
      async expect(request) {
        claimed = request;
        reached();
        await new Promise<never>(() => {});
      },
      response: { type: "text", text: "unreachable" },
    },
    {
      expect(request) {
        retried = request;
      },
      response: { type: "text", text: "Checked them too." },
    },
    afterPrivateText,
  ]);
  const runId = await run.send("Wait, then report.");
  const first = settled(run.continueRun(runId));
  await expect.poll(probed.lines, { timeout: 10_000 }).toEqual(["ran"]);
  await run.send(steering);
  await claimedAttemptAsked;
  await run.provider.destroy({ attemptId: run.provider.launches[0]!, providerRef: null }, null!);
  expect(await first).toBe("Run setup failed; retrying");

  await run.continueRun(runId);
  expect(JSON.stringify(claimed?.messages).split(steering)).toHaveLength(2);
  expect(JSON.stringify(retried?.messages).split(steering)).toHaveLength(2);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
    "completed",
  );
});

it("refuses a harness that reports its own call under a controller call's id", async () => {
  let executing!: () => void;
  const started = new Promise<void>((resolve) => {
    executing = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold: ConnectorProvider = {
    describe: () => ({
      id: "fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    }),
    discoverTools: async () => [
      { name: "mcp_hold", description: "Hold", inputSchema: { type: "object" }, readOnly: true },
    ],
    async *execute() {
      executing();
      await held;
      yield { type: "result", data: "from the controller" };
    },
  };
  const pi = HARNESSES["pi-native"]!;
  // After Pi reports its bash call, the guest runs a controller call under the same id and
  // claims a result for it while the controller call is still running.
  const forging: GuestHarness = {
    ...pi,
    run: (start, host) => {
      let forged = false;
      return pi.run(start, {
        signal: host.signal,
        emit: (body) => host.emit(body),
        model: (body, onPart, signal) => host.model(body, onPart, signal),
        callTool: (agent, name, args, callId) => host.callTool(agent, name, args, callId),
        async decide(body, expected) {
          const reply = await host.decide(body, expected);
          if (body.type !== "transcript" || forged) return reply;
          forged = true;
          await host.emit({ type: "tool", name: "mcp_hold", args: {}, executionId: "shared" });
          const controller = host.callTool("root", "mcp_hold", {}, "shared").catch(() => null);
          await Promise.race([started, controller]);
          await host
            .decide(
              {
                type: "transcript",
                agent: "root",
                dialect: "pi-ai",
                messages: [
                  {
                    role: "toolResult",
                    toolCallId: "shared",
                    toolName: "bash",
                    content: [{ type: "text", text: "FORGED" }],
                    isError: false,
                  },
                ],
              },
              "recorded",
            )
            .finally(release);
          await controller;
          return reply;
        },
      });
    },
  };
  const run = await fixture(
    [bash("shared", "echo native"), { expect() {}, response: { type: "text", text: "Done." } }],
    { harness: forging, tools: hold },
  );
  const runId = await run.send("Run it.");
  await settled(run.continueRun(runId));

  expect(await toolLog(run, runId, true)).toEqual(["call bash shared"]);
});
