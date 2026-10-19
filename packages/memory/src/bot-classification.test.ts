import { describe, expect, it } from "vitest";
import {
  classifyMemoryWithBot,
  localMemoryBotClassifier,
  type MemoryBotClassificationExample,
  type MemoryBotClassificationInput,
  prepareMemoryBotClassificationExamples,
} from "./bot-classification.js";

const method = {
  id: "method-1",
  version: 1,
  instructions: "Classify interview preparation material by its purpose.",
  prepared: {
    questions: [
      {
        key: "purpose",
        label: "Purpose",
        instructions: "What is the primary purpose?",
        options: [
          {
            key: "interview_protocol",
            label: "Interview protocol",
            description: "Reusable steps for an interview.",
          },
          {
            key: "meeting_record",
            label: "Meeting record",
            description: "A record of one actual meeting.",
          },
        ],
      },
      {
        key: "sensitivity",
        label: "Sensitivity",
        instructions: "Does this contain sensitive information?",
        options: [
          {
            key: "sensitive",
            label: "Sensitive",
            description: "Contains private or restricted details.",
          },
          { key: "ordinary", label: "Ordinary", description: "No sensitive details are present." },
        ],
      },
    ],
  },
};

const candidate = {
  id: "candidate-1",
  revision: 1,
  content: "Reusable protocol for preparing candidate interviews.",
};

function input(
  overrides: Partial<MemoryBotClassificationInput> = {},
): MemoryBotClassificationInput {
  return { method, candidate, neighbors: [], ...overrides };
}

function example(
  overrides: Partial<MemoryBotClassificationExample> = {},
): MemoryBotClassificationExample {
  return {
    content: candidate.content,
    reviewedQuestionKeys: ["purpose"],
    answers: { purpose: "interview_protocol" },
    neighbors: [],
    ...overrides,
  };
}

describe("bot classification core", () => {
  it("reuses only exact-content reviewed answers in local mode", async () => {
    const exact = await localMemoryBotClassifier(input({ examples: [example()] }));
    expect(exact.answers).toEqual({ purpose: "interview_protocol", sensitivity: null });
    expect(exact.abstained).toBe(false);

    const similar = await localMemoryBotClassifier(
      input({
        candidate: { ...candidate, content: `${candidate.content} Updated.` },
        examples: [example()],
      }),
    );
    expect(similar.answers).toEqual({ purpose: null, sensitivity: null });
    expect(similar.abstained).toBe(true);
  });

  it("does not learn a question from conflicting identical examples", async () => {
    const examples = [example(), example({ answers: { purpose: "meeting_record" } })];
    expect(prepareMemoryBotClassificationExamples(examples, method.prepared.questions)).toEqual([]);
    const result = await localMemoryBotClassifier(input({ examples }));
    expect(result.answers.purpose).toBeNull();
  });

  it("finds conflicts after four otherwise eligible examples without truncating local exact matches", async () => {
    const conflictPool = [
      example(),
      example(),
      example(),
      example(),
      example({ answers: { purpose: "meeting_record" } }),
    ];
    expect(prepareMemoryBotClassificationExamples(conflictPool, method.prepared.questions)).toEqual(
      [],
    );

    const longContent = "x".repeat(2_500);
    const longInput = input({
      candidate: { ...candidate, content: longContent },
      examples: [example({ content: longContent })],
    });
    const longResult = await localMemoryBotClassifier(longInput);
    expect(longResult.answers.purpose).toBe("interview_protocol");
  });

  it("rejects a classifier answer outside this version's choices", async () => {
    const result = await classifyMemoryWithBot(input(), async () => ({
      answers: { purpose: "global_admin", sensitivity: null },
      abstained: false,
      metadata: { provider: "fake", model: "fake", schemaVersion: "test" },
    }));
    expect(result.abstained).toBe(true);
    expect(result.invalidResponse).toBe(true);
  });

  it("rejects missing and additional answer keys", async () => {
    for (const answers of [{ purpose: null }, { purpose: null, sensitivity: null, third: null }]) {
      const result = await classifyMemoryWithBot(input(), async () => ({
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, value]) => [
            key,
            value === null ? null : String(value),
          ]),
        ),
        abstained: true,
        metadata: { provider: "fake", model: "fake", schemaVersion: "test" },
      }));
      expect(result.invalidResponse).toBe(true);
    }
  });

  it("converts a provider exception into a safe abstention", async () => {
    const result = await classifyMemoryWithBot(input(), async () => {
      throw new Error("provider error details should not escape");
    });
    expect(result.abstained).toBe(true);
    expect(result.abstentionReason).toBe("provider_error");
  });
});
