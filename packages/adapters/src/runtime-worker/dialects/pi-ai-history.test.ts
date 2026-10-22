import type { AgentHistoryTurn } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { ingestPiAi, projectPiAi } from "./pi-ai-history.js";

const MODEL = { api: "openai-completions", provider: "openai", id: "gpt-test" } as const;
const PROMPT = { role: "user", content: "Tidy my notes.", timestamp: 1 };
const tools = { controllerTools: ["remember"], nativeTools: ["bash"] };

describe("canonical history and a native Pi session", () => {
  it("projects controller tools under their MCP names and ingests back to the same turns", () => {
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

    const projected = projectPiAi(history, PROMPT.content, MODEL, ["remember"]);

    expect(
      projected.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
          : message.role === "toolResult"
            ? [`result:${message.toolName}`]
            : [],
      ),
    ).toEqual(["bash", "mcp__rakazo__remember", "result:bash", "result:mcp__rakazo__remember"]);
    expect(
      ingestPiAi([PROMPT, ...projected], {
        ...tools,
        answers: [{ callId: "controller-1", name: "remember", output: "Saved." }],
        clean: (text) => text,
      }).entries,
    ).toEqual(history.map((turn) => ({ kind: "turn", turn })));
  });

  it("keeps the controller's answer over the transcript's and counts calls it never answered", () => {
    const transcript = [
      PROMPT,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Save it, then mail it." },
          { type: "toolCall", id: "c1", name: "mcp__rakazo__remember", arguments: { text: "x" } },
          { type: "toolCall", id: "c2", name: "remember", arguments: { text: "y" } },
          { type: "toolCall", id: "c3", name: "bash", arguments: { command: "cat notes.md" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        content: [{ type: "text", text: "Saved 40 facts." }],
      },
      { role: "toolResult", toolCallId: "c2", content: "Saved again." },
      { role: "toolResult", toolCallId: "c3", content: [{ type: "text", text: "- milk" }] },
      { role: "compactionSummary", summary: "Read the notes.", tokensBefore: 12000 },
      { role: "bashExecution", command: "rm -rf /" },
    ];

    expect(
      ingestPiAi(transcript, {
        ...tools,
        answers: [{ callId: "controller-1", name: "remember", output: "Saved." }],
        clean: (text) => text.toUpperCase(),
      }),
    ).toEqual({
      entries: [
        {
          kind: "turn",
          turn: {
            role: "assistant",
            content: "",
            parts: [
              {
                type: "toolCalls",
                calls: [
                  { id: "c1", name: "remember", args: { text: "x" }, output: "Saved." },
                  { id: "c2", name: "remember", args: { text: "y" }, output: "" },
                  { id: "c3", name: "bash", args: { command: "cat notes.md" }, output: "- MILK" },
                ],
              },
            ],
          },
        },
        { kind: "summary", summary: "READ THE NOTES.", tokensBefore: 12000 },
      ],
      steps: [
        { kind: "controller", turn: 0, callId: "controller-1", name: "remember" },
        {
          kind: "call",
          turn: 0,
          callId: "c3",
          name: "bash",
          args: { command: "cat notes.md" },
          output: "- MILK",
          isError: false,
        },
        { kind: "summary", turn: 1, summary: "READ THE NOTES.", tokensBefore: 12000 },
      ],
      unverifiedCalls: 1,
    });
  });
});
