import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { DRAFT_CARDS } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { prepareDraft } from "./draft-preparation.js";

const args = { channel: "C0GENERAL", text: "Hi" };
const model: AgentRunRequest["model"] = { provider: "openai-compatible", id: "run-model" };

function prepare(run: AgentRuntime["run"], signal = new AbortController().signal) {
  return prepareDraft({
    runtime: { describe: () => ({}) as never, abort: async () => {}, run },
    model,
    tool: { name: "post_note", app: "acme" },
    args,
    run: { id: "run", botId: "bot", threadId: "thread", spaceId: "space", userId: "user" },
    signal,
  });
}

describe("prepareDraft", () => {
  it("asks the run's own model for a card, with no tool it could run", async () => {
    const requests: AgentRunRequest[] = [];
    const binding = await prepare(async function* (request) {
      requests.push(request);
      yield {
        type: "done",
        answer: {
          name: DRAFT_CARDS.chat.name,
          value: {
            conversation: { path: ["channel"], value: "C0GENERAL" },
            body: { path: ["text"], value: "Hi" },
            unshown: [],
          },
        },
      };
    });
    expect(requests).toEqual([
      expect.objectContaining({
        model,
        tools: [],
        answer: { schemas: [DRAFT_CARDS.mail, DRAFT_CARDS.chat] },
      }),
    ]);
    expect(requests[0]!.executeTool).toBeUndefined();
    expect(binding).toEqual({ path: ["text"], proposed: "Hi", chat: { path: ["channel"] } });
  });

  it("gives up when the run is cancelled while the model prepares", async () => {
    const stop = new AbortController();
    const binding = prepare(async function* (_, context) {
      stop.abort();
      context?.signal?.throwIfAborted();
      yield { type: "done" };
    }, stop.signal);
    await expect(binding).resolves.toBe(undefined);
  });
});
