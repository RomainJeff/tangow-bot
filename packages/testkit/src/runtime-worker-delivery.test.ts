import type { ReplyBody } from "@rakazo/adapter-kit";
import { parseControllerMessage, parseGuestMessage } from "@rakazo/adapter-kit";
import type { GuestConnector } from "@rakazo/adapters/runtime-worker";
import { messageHelper } from "@rakazo/db";
import { afterEach, expect, it } from "vitest";
import type { LocalWorkerProvider } from "./local-worker-provider.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("does not reconstruct a child that crashed while working before any saved pause", async () => {
  let executed = 0;
  const crash = crashOnReply(
    (body, toolName) => body.type === "tool.result" && toolName === "read_long",
  );
  const run = await startWorkerRun({
    mode: "child",
    connector: crash.connector,
    tools: {
      describe: () => ({
        id: "read-fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { discover: true, oauth: false, secretsBrokered: true },
      }),
      discoverTools: async () => [
        {
          name: "read_long",
          description: "Read",
          readOnly: true,
          inputSchema: { type: "object" },
          route: { connectorId: "read-fixture", toolName: "read_long" },
        },
      ],
      async *execute() {
        executed++;
        yield { type: "result", data: "read result" };
      },
    },
    steps: [
      {
        expect() {},
        response: { type: "tool", id: "read-native", name: "read_long", arguments: {} },
      },
    ],
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Read once.");
  await run.continueRun(runId).catch(() => undefined);
  expect(crash.crashed()).toBe(true);
  expect(await run.prisma.runSnapshot.count({ where: { runId } })).toBe(0);
  await run.restart().dispose();
  await run.continueRun(runId).catch(() => undefined);
  const finished = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
  expect(finished.status).toBe("failed");
  expect(finished.error).toContain("pause snapshot is missing");
  expect(executed).toBe(1);
  run.model.assertComplete();
});

it("resumes a background helper in its own native session with its parent's full answer", async () => {
  const answer = `Paris ${"p".repeat(6000)}`;
  let resumed: ModelEmulatorRequest | undefined;
  const run = await startWorkerRun({
    mode: "child",
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "spawn",
          name: "run_subagent",
          arguments: { name: "Scout", task: "Choose a city.", background: true },
        },
      },
      {
        expect() {},
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Research started." },
        },
      },
      { expect() {}, response: { type: "text", text: "" } },
      {
        expect() {},
        response: {
          type: "tool",
          id: "parent-native",
          name: "ask_parent",
          arguments: { question: "Which city?" },
        },
      },
      { expect() {}, response: { type: "text", text: "Waiting." } },
      {
        expect(request) {
          resumed = request;
        },
        response: { type: "text", text: "Paris selected." },
      },
    ],
  });
  cleanups.push(() => run.close());
  const parentId = await run.send("Research a city.");
  await run.continueRun(parentId);
  const helper = await run.prisma.run.findFirstOrThrow({
    where: { parentRunId: parentId, trigger: "helper" },
  });
  await run.continueRun(helper.id);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status).toBe(
    "waiting_input",
  );
  expect(
    await messageHelper(run.prisma, {
      threadId: run.thread.id,
      botId: run.bot.id,
      helperId: helper.id,
      text: answer,
    }),
  ).toBe("answered");
  await run.restart().dispose();
  await run.continueRun(helper.id);
  expect((await run.prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).error).toBe(null);
  run.model.assertComplete();
  expect(resumed?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "parent-native", content: answer }),
    ]),
  );
  expect(await run.prisma.run.count({ where: { parentRunId: parentId, trigger: "helper" } })).toBe(
    1,
  );
  expect(
    await run.prisma.runSnapshot.count({ where: { runId: { in: [parentId, helper.id] } } }),
  ).toBe(0);
});

function crashOnReply(matches: (body: ReplyBody, toolName: string | undefined) => boolean) {
  let crashed = false;
  const connector = (provider: LocalWorkerProvider): GuestConnector => ({
    connect(target, capability) {
      const guest = provider.connect(target, capability);
      return {
        ...guest,
        connections: (async function* () {
          for await (const channel of guest.connections) {
            const calls = new Map<number, string>();
            let cut = false;
            yield {
              ...channel,
              frames: (async function* () {
                for await (const frame of channel.frames) {
                  const parsed = parseGuestMessage(JSON.parse(Buffer.from(frame).toString()));
                  if (
                    parsed.ok &&
                    parsed.message.kind === "worker.event" &&
                    parsed.message.payload.body.type === "tool.call"
                  )
                    calls.set(parsed.message.payload.seq, parsed.message.payload.body.name);
                  if (!cut) yield frame;
                }
              })(),
              async send(frame: Uint8Array) {
                const parsed = parseControllerMessage(JSON.parse(Buffer.from(frame).toString()));
                if (
                  !crashed &&
                  parsed.ok &&
                  parsed.message.kind === "worker.reply" &&
                  matches(parsed.message.payload.body, calls.get(parsed.message.payload.re))
                ) {
                  crashed = true;
                  cut = true;
                  await provider.destroy(
                    { attemptId: parsed.message.worker.attemptId, providerRef: null },
                    {
                      operationId: "crash",
                      traceId: "crash",
                      spaceId: "fixture",
                      userId: "fixture",
                      signal: new AbortController().signal,
                    },
                  );
                  return;
                }
                await channel.send(frame);
              },
            };
          }
        })(),
      };
    },
  });
  return { connector, crashed: () => crashed };
}
