import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it } from "vitest";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function controllerRun(
  calls: (request: AgentRunRequest, prisma: PrismaClient) => Promise<void>,
) {
  const run = await startWorkerRun({
    steps: [],
    computerScope: "team",
    protocol: "anthropic",
    runtime: (prisma) => ({
      describe: () => ({
        ...new PiAgentRuntime().describe(),
        capabilities: { scripted: false, streaming: false },
      }),
      abort: async () => {},
      async *run(request) {
        await calls(request, prisma);
        yield { type: "done" };
      },
    }),
  });
  cleanups.push(() => run.close());
  return run;
}

const city = { question: "Which city?", options: ["Paris", "Lyon"] };

it.each([
  { name: "ask_user", args: { question: "Which day?", options: ["Monday", "Tuesday"] } },
  { name: "request_takeover", args: { reason: "Log in" } },
])("refuses a different pending request through $name", async (different) => {
  const replies: unknown[] = [];
  const run = await controllerRun(async (request) => {
    replies.push(await request.executeTool!("ask_user", city, "first"));
    replies.push(await request.executeTool!("ask_user", city, "same"));
    replies.push(await request.executeTool!(different.name, different.args, "different"));
  });
  const runId = await run.send("Plan my trip.");
  await run.continueRun(runId);

  const pending = {
    kind: "agent_tool_result",
    content: [{ type: "text", text: "Waiting for the user's choice." }],
    details: { ask: "paused" },
    terminate: true,
  };
  expect(replies).toEqual([pending, pending, { error: "Already waiting on the user." }]);
  expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
    status: "waiting_input",
  });
  const cards = (await run.runEntries(runId)).filter((entry) => entry.type === "assistant.ask");
  expect(cards).toHaveLength(1);
  expect(cards[0]!.payload).toMatchObject({ block: { text: "Which city?" } });
});

it("retries a takeover after its first pause loses the computer lease", async () => {
  const replies: unknown[] = [];
  const run = await controllerRun(async (request, prisma) => {
    await request.executeTool!("computer_observe", {}, "start");
    await prisma.computerExecutionLease.updateMany({ data: { expiresAt: new Date(0) } });
    replies.push(
      await request.executeTool!("request_takeover", { reason: "Log in" }, "expired").catch(
        (error: unknown) => (error instanceof Error ? error.message : error),
      ),
    );
    await prisma.computerExecutionLease.updateMany({
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    replies.push(
      await request.executeTool!("request_takeover", { reason: "Log in" }, "retry").catch(
        (error: unknown) => (error instanceof Error ? error.message : error),
      ),
    );
  });
  const runId = await run.send("Log in.");
  await run.continueRun(runId);

  expect(replies[0]).toBe("Computer lease expired before takeover");
  expect(replies[1]).toMatchObject({ details: { takeover: "paused" }, terminate: true });
  expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
    status: "waiting_takeover",
  });
  const cards = (await run.runEntries(runId)).flatMap((entry) =>
    entry.type === "assistant.text"
      ? entry.payload.blocks.filter((block) => block.kind === "computer")
      : [],
  );
  expect(cards).toEqual([{ kind: "computer", state: "Needs you", text: "Log in" }]);
});
