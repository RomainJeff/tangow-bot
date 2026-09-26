import { describe, expect, it, vi } from "vitest";
import {
  memoryClassifierProviders,
  verifyMemoryBotClassifierConnection,
} from "./memory-bot-classifier-factory.js";

describe("memory bot classifier connection", () => {
  it("verifies the configured provider with a synthetic dynamic method only", async () => {
    let sent: Record<string, any> | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(
        Object.entries(sent!.questions).map(([key, question]: [string, any]) => {
          const option = Object.keys(question.criteria)[0]!;
          return [
            key,
            {
              type: "choice",
              choice: option,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((item) => [item, item === option ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return new Response(
        JSON.stringify({
          model: "jev-test-model",
          answers,
          usage: { input_tokens: 20, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await verifyMemoryBotClassifierConnection({
      provider: "typesafe-jev",
      model: "jev-test-model",
      apiKey: "fake-test-key",
      fetch,
    });

    expect(memoryClassifierProviders.map(({ id }) => id)).toContain("typesafe-jev");
    expect(sent?.questions).toHaveProperty("probe");
    expect(sent?.state.candidate.content).toBe("Synthetic classification connection check.");
    expect(sent?.state.reviewedExamples).toEqual([]);
  });
});
