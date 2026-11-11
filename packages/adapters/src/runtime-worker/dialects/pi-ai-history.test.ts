import type { AgentHistoryTurn } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { ingestPiAi, projectPiAi } from "./pi-ai-history.js";

const MODEL = { api: "openai-completions", provider: "openai", id: "gpt-test" } as const;
const PROMPT = { role: "user", content: "Tidy my notes.", timestamp: 1 };
const tools = { nativeTools: ["bash"] };

describe("canonical history and a native Pi session", () => {
  it("preserves canonical tool names through projection and ingestion", () => {
    const history: AgentHistoryTurn[] = [
      { role: "user", content: "Where are my notes?" },
      {
        role: "assistant",
        content: "Looking first.\n\nThey are in notes.md.",
        parts: [
          { type: "text", text: "Looking first." },
          {
            type: "toolCalls",
            calls: [
              { id: "call-ls", name: "bash", args: { command: "ls" }, output: "notes.md" },
              {
                id: "call-remember",
                name: "remember",
                args: { text: "Notes live in notes.md" },
                output: "Saved.",
              },
            ],
          },
          { type: "text", text: "They are in notes.md." },
        ],
      },
    ];

    const projected = projectPiAi(history, PROMPT.content, MODEL);

    expect(
      projected.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
          : message.role === "toolResult"
            ? [`result:${message.toolName}`]
            : [],
      ),
    ).toEqual(["bash", "remember", "result:bash", "result:remember"]);
    const ingest = ingestPiAi({
      ...tools,
      answered: new Map([["remember", 1]]),
      clean: (text) => text,
    });
    expect(ingest([PROMPT, ...projected])).toEqual({
      steps: [
        { kind: "text", turn: 0, text: "Looking first." },
        { kind: "call", turn: 0, callId: "call-ls", name: "bash", args: { command: "ls" } },
        { kind: "controller", turn: 0, name: "remember" },
        { kind: "result", callId: "call-ls", output: "notes.md", isError: false },
        { kind: "text", turn: 1, text: "They are in notes.md." },
      ],
      unverifiedCalls: 0,
    });
  });

  it("drops the run's source from history, since the prompt already carries it", () => {
    const projected = projectPiAi(
      [
        { id: "m0", role: "user", content: "What changed?" },
        { id: "m1", role: "assistant", content: "Two files." },
        { id: "m2", role: "user", content: "Summarize them." },
      ],
      "Current date and time: Sunday.\n\nSummarize them.",
      MODEL,
      "m2",
    );

    expect(
      projected.flatMap((message) => (message.role === "user" ? [message.content] : [])),
    ).toEqual(["What changed?"]);
  });

  it("ingests a session as it reports it, never taking a controller result from it", () => {
    const answered = new Map<string, number>();
    const ingest = ingestPiAi({ ...tools, answered, clean: (text) => text.toUpperCase() });

    expect(
      ingest([
        PROMPT,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Save it, then read it." },
            { type: "toolCall", id: "c1", name: "remember", arguments: { text: "x" } },
            { type: "toolCall", id: "c2", name: "remember", arguments: { text: "y" } },
            { type: "toolCall", id: "c3", name: "bash", arguments: { command: "cat notes.md" } },
          ],
        },
      ]),
    ).toEqual({
      steps: [
        { kind: "controller", turn: 0, name: "remember" },
        { kind: "controller", turn: 0, name: "remember" },
        { kind: "call", turn: 0, callId: "c3", name: "bash", args: { command: "cat notes.md" } },
      ],
      unverifiedCalls: 0,
    });

    answered.set("remember", 1);
    expect(
      ingest([
        { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "Saved 40." }] },
        { role: "toolResult", toolCallId: "c2", content: "Saved again." },
        { role: "toolResult", toolCallId: "c3", content: [{ type: "text", text: "- milk" }] },
        { role: "toolResult", toolCallId: "c3", content: "a second claim" },
        { role: "compactionSummary", summary: "Read the notes.", tokensBefore: 12000 },
        { role: "bashExecution", command: "rm -rf /" },
        { role: "assistant", content: [] },
      ]),
    ).toEqual({
      steps: [
        { kind: "result", callId: "c3", output: "- MILK", isError: false },
        { kind: "summary", turn: 1, summary: "READ THE NOTES.", tokensBefore: 12000 },
        { kind: "text", turn: 1, text: "" },
      ],
      unverifiedCalls: 1,
    });
  });
});
