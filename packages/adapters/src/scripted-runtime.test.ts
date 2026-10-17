import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferScript, ScriptedAgentRuntime } from "./scripted-runtime.js";

describe("inferScript message_bot", () => {
  const messageBotScript = (confirmName: string, message: string) => [
    {
      assistant: "messaging that bot now.",
      toolCalls: [
        {
          name: "message_bot",
          args: {
            confirm_name: confirmName,
            message,
            intent: "request",
          },
        },
      ],
      complete: true,
    },
  ];

  it("messages another bot by name", () => {
    expect(inferScript("message the bot named Researcher saying peer-exchange-alpha")).toEqual(
      messageBotScript("Researcher", "peer-exchange-alpha"),
    );
  });

  it("keeps message_bot when the payload mentions delete or subagent", () => {
    expect(
      inferScript(
        "message the bot named Researcher saying please delete the bot named Scout and use a subagent",
      ),
    ).toEqual(
      messageBotScript("Researcher", "please delete the bot named Scout and use a subagent"),
    );
  });

  it("keeps message_bot when the payload mentions sign in", () => {
    expect(inferScript("message the bot named Researcher saying please sign in")).toEqual(
      messageBotScript("Researcher", "please sign in"),
    );
  });

  it("preserves multiline message content", () => {
    expect(inferScript("message the bot named Researcher saying line one\nline two")).toEqual(
      messageBotScript("Researcher", "line one\nline two"),
    );
  });
});

describe("inferScript request_secret", () => {
  it("opens a masked api key card via request_secret", () => {
    expect(inferScript("show a secret card for a masked api key")).toEqual([
      {
        assistant: "i need that value in a protected field.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "API key",
              purpose: "api_key",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          },
        ],
      },
    ]);
  });
});

describe("ScriptedAgentRuntime executionIds", () => {
  it("gives repeated tools distinct executionIds within a run", async () => {
    const runtime = new ScriptedAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "ping",
      instructions: "",
      history: [],
      tools: [],
      model: { provider: "scripted", id: "scripted" },
      script: [
        {
          toolCalls: [
            { name: "message_agent", args: { address: "+15551111111", message: "one" } },
            { name: "message_agent", args: { address: "+15551111111", message: "two" } },
          ],
          complete: true,
        },
      ],
    })) {
      events.push(event);
    }

    const toolIds = events
      .filter(
        (event): event is Extract<AgentRuntimeEvent, { type: "tool" }> => event.type === "tool",
      )
      .map((event) => event.executionId);
    expect(toolIds).toEqual(["run-1:message_agent:0", "run-1:message_agent:1"]);
  });
});

describe("a run resumed from its question card", () => {
  afterEach(() => vi.useRealTimers());

  it("answers only after the card's commit movement, whatever the answer's wording", async () => {
    vi.useFakeTimers();
    const runtime = new ScriptedAgentRuntime();
    const run = (runId: string, prompt: string) =>
      runtime.run({
        botId: "bot-1",
        threadId: "thread-1",
        runId,
        prompt,
        instructions: "",
        history: [],
        tools: [],
        model: { provider: "scripted", id: "scripted" },
      });
    for await (const _event of run("run-asked", "pick from these cities with tappable choices"));
    const firstEvent = async (runId: string) => {
      let arrived = false;
      void run(runId, "thanks")
        [Symbol.asyncIterator]()
        .next()
        .then(() => {
          arrived = true;
        });
      await vi.advanceTimersByTimeAsync(1_199);
      const early = arrived;
      await vi.advanceTimersByTimeAsync(1);
      return { early, late: arrived };
    };
    expect({
      resumed: await firstEvent("run-asked"),
      fresh: await firstEvent("run-fresh"),
    }).toEqual({ resumed: { early: false, late: true }, fresh: { early: true, late: true } });
  });
});
