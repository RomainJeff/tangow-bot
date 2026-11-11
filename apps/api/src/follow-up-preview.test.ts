import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;

function followUp(input: { linkPreview?: false; text?: string }) {
  const sendUserMessage = vi.fn(async () => ({
    messageId: "message-1",
    seq: 1,
    taskId: "task-1",
    runId: "run-1",
  }));
  const enqueue = vi.fn(async () => undefined);
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
    taughtSkill: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    events: { sendUserMessage },
    jobs: { enqueue },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const call = () =>
    handler.handle(
      new Request("http://127.0.0.1/rpc/threads/followUp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { botId: "bot-1", text: "and https://example.test/a", ...input },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
  return { call, sendUserMessage, enqueue };
}

describe("threads.followUp and link previews", () => {
  it("queues the preview for the new message, by id only", async () => {
    const { call, sendUserMessage, enqueue } = followUp({});

    const { response } = await call();

    expect(response?.status).toBe(200);
    expect(sendUserMessage.mock.calls[0]![0].blocks).toEqual([
      { kind: "text", text: "and https://example.test/a" },
    ]);
    const jobs = enqueue.mock.calls.map(([job]) => job as { name: string; payload: unknown });
    expect(jobs.at(-1)).toMatchObject({
      name: "link.preview",
      payload: { messageId: "message-1" },
    });
  });

  it("writes the removal marker and queues no preview for linkPreview: false", async () => {
    const { call, sendUserMessage, enqueue } = followUp({ linkPreview: false });

    const { response } = await call();

    expect(response?.status).toBe(200);
    expect(sendUserMessage.mock.calls[0]![0].blocks).toEqual([
      { kind: "text", text: "and https://example.test/a" },
      { kind: "link_preview", removed: true },
    ]);
    expect(enqueue.mock.calls.map(([job]) => (job as { name: string }).name)).toEqual([
      "run.continue",
    ]);
  });

  it("keeps the text exactly as sent, even when it is only whitespace (never a message with no block)", async () => {
    const { call, sendUserMessage } = followUp({ text: "  \n " });

    const { response } = await call();

    expect(response?.status).toBe(200);
    expect(sendUserMessage.mock.calls[0]![0].blocks).toEqual([{ kind: "text", text: "  \n " }]);
  });
});
