import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { createBotMessageInTransaction } from "./messages.js";

function transaction() {
  const thread = { sessionId: "session-1", botId: "bot-1" };
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    thread: {
      update: vi.fn().mockResolvedValue(thread),
      findUniqueOrThrow: vi.fn().mockResolvedValue(thread),
    },
  };
}

describe("createBotMessageInTransaction", () => {
  it("lets an automated bot message opt out of unread without changing the default", async () => {
    const append = vi.fn();
    const silent = transaction();
    await createBotMessageInTransaction(
      silent as unknown as Prisma.TransactionClient,
      {
        threadId: "thread-1",
        botId: "bot-1",
        blocks: [{ kind: "text", text: "Checked status" }],
        markUnread: false,
      },
      append,
    );
    expect(silent.thread.update).not.toHaveBeenCalled();

    const visible = transaction();
    await createBotMessageInTransaction(
      visible as unknown as Prisma.TransactionClient,
      { threadId: "thread-1", botId: "bot-1", blocks: [{ kind: "text", text: "Report ready" }] },
      append,
    );
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { unread: true } }),
    );
    expect(append).toHaveBeenCalledWith(
      visible,
      expect.objectContaining({ type: "bot.text", sessionId: "session-1", botId: "bot-1" }),
    );
  });
});
