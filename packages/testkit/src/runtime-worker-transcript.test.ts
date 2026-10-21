import type { AgentRunRequest, GuestBody } from "@rakazo/adapter-kit";
import { createWorkerAgentRuntime } from "@rakazo/adapters/runtime-worker";
import { describe, expect, it } from "vitest";
import { consume, manualLauncher, rawGuest, stillClock } from "./worker-raw-guest.js";

const SECRET = "hunter2-secret";
const REMEMBER = {
  name: "remember",
  description: "Save one durable fact about the user.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function request(overrides: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run_native",
    prompt: "Tidy my notes.",
    instructions: "Be brief.",
    history: [],
    tools: [REMEMBER],
    model: { provider: "openai-compatible", id: "unused", apiKey: "controller-only-key" },
    attempt: { id: "run_native-attempt", fence: 1 },
    secrets: [SECRET],
    ...overrides,
  };
}

const transcript: GuestBody = {
  type: "transcript",
  dialect: "pi-ai",
  messages: [
    { role: "user", content: "Tidy my notes." },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "mcp__rakazo__remember", arguments: { text: "x" } },
        { type: "toolCall", id: "c2", name: "mcp__rakazo__remember", arguments: { text: "y" } },
        { type: "toolCall", id: "c3", name: "bash", arguments: { command: "cat notes.md" } },
      ],
    },
    { role: "toolResult", toolCallId: "c1", content: "Saved 40 facts and your password." },
    { role: "toolResult", toolCallId: "c2", content: "Saved again." },
    { role: "toolResult", toolCallId: "c3", content: `token ${SECRET}` },
    {
      role: "compactionSummary",
      summary: `${SECRET} ${"x".repeat(70_000)}`,
      tokensBefore: 70_000,
    },
  ],
};

describe("a native harness's transcript", () => {
  it("reaches the run as the harness's own work only, redacted and bounded", async () => {
    const launcher = manualLauncher();
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(
      runtime.run(
        request({
          executeTool: async () => ({
            kind: "agent_tool_result",
            content: [{ type: "text", text: "Saved." }],
          }),
        }),
      ),
    );
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability, {
      name: "pi-native",
      capabilities: ["native-loop"],
    });
    await guest.hello();

    guest.send(1, { type: "tool", name: "remember", args: { text: "x" }, executionId: "c1" });
    guest.send(2, { type: "tool.call", agent: "root", callId: "c1", name: "remember", args: {} });
    expect((await guest.replies(2)).at(-1)?.type).toBe("tool.result");
    guest.send(3, transcript);
    expect(await guest.replies(3)).toEqual([{ type: "recorded" }]);
    guest.send(4, { type: "done" });
    await run.done;

    const ingested = run.seen.find((event) => event.type === "transcript");
    const summary = ingested?.entries.find((entry) => entry.kind === "summary");
    expect({
      ...ingested,
      entries: ingested?.entries.filter((entry) => entry.kind === "call"),
    }).toEqual({
      type: "transcript",
      entries: [
        {
          kind: "call",
          callId: "c3",
          name: "bash",
          args: { command: "cat notes.md" },
          output: "token [redacted]",
        },
      ],
      unverifiedCalls: 1,
    });
    expect(
      summary?.kind === "summary" && {
        head: summary.summary.slice(0, 12),
        bytes: Buffer.byteLength(summary.summary),
        tail: summary.summary.slice(-38),
        tokensBefore: summary.tokensBefore,
      },
    ).toEqual({
      head: "[redacted] x",
      bytes: 65_536,
      tail: "[cut by the controller at 65536 bytes]",
      tokensBefore: 70_000,
    });
  });

  it("is refused from a harness that runs no loop of its own", async () => {
    const launcher = manualLauncher();
    const runtime = createWorkerAgentRuntime({
      launcher: launcher.launcher,
      stops: { mark: async () => undefined },
      clock: stillClock,
    });
    const run = consume(runtime.run(request({})));
    const launched = await launcher.launchedFor("run_native");
    const guest = rawGuest(launched.connect(), launched.capability);
    await guest.hello();

    guest.send(1, transcript);
    expect(await guest.replies(1)).toEqual([{ type: "refused", reason: "undeclared" }]);
    await expect(run.done).rejects.toThrow("The worker broke the run protocol: undeclared");
  });
});
