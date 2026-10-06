import { describe, expect, it } from "vitest";

import { RunTraceRecorder } from "./pi-run-trace.js";

describe("RunTraceRecorder", () => {
  it("records the thinking level and the first token time of each generation", () => {
    let clock = Date.UTC(2026, 9, 6, 12, 0, 0);
    const recorder = new RunTraceRecorder({
      runId: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      provider: "test",
      model: "agent-model",
      thinkingLevel: "high",
      now: () => clock,
      systemPrompt: "",
      history: [],
      prompt: "hello",
    });

    recorder.turnStart();
    clock += 1_250;
    recorder.firstToken();
    clock += 500;
    recorder.firstToken();
    recorder.assistantMessage({ role: "assistant", content: [] } as never);

    recorder.turnStart();
    recorder.assistantMessage({ role: "assistant", content: [] } as never);
    recorder.finish("done");

    const [root, first, second] = recorder.trace.getSpans();
    expect(root!.attributes["langfuse.trace.metadata.thinkingLevel"]).toBe("high");
    expect(first!.attributes["langfuse.observation.metadata.thinkingLevel"]).toBe("high");
    expect(first!.attributes["langfuse.observation.completion_start_time"]).toBe(
      "2026-10-06T12:00:01.250Z",
    );
    expect(second!.attributes["langfuse.observation.completion_start_time"]).toBeUndefined();
  });
});
