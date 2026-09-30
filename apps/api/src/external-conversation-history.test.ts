import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { externalConversationHistory } from "./external-conversation-history.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "",
  isDeploymentOwner: false,
} satisfies Actor;

describe("external conversation history", () => {
  it("refuses a foreign or missing conversation before reading any message", async () => {
    const findFirst = vi.fn(async () => null);
    const findMany = vi.fn();
    const prisma = {
      externalConversation: { findFirst },
      message: { findMany },
    } as unknown as PrismaClient;
    await expect(
      externalConversationHistory(prisma, actor, { externalConversationId: "foreign" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "foreign", userId: "owner", spaceId: "space" } }),
    );
    expect(findMany).not.toHaveBeenCalled();
  });
  it("loads the external thread with sender attribution and delivery state", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message",
        threadId: "external-thread",
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Request" }],
        botId: null,
        runId: null,
        replyToMessageId: null,
        clientNonce: null,
        createdAt: new Date(0),
      },
    ]);
    const prisma = {
      externalConversation: {
        findFirst: vi.fn(async () => ({
          id: "conversation",
          provider: "slack",
          workspaceId: "T-example",
          externalKey: "C-example",
          thread: { id: "external-thread" },
        })),
      },
      message: { findMany },
      externalMessage: {
        findMany: vi.fn(async () => [{ threadMessageId: "message", senderName: "Author" }]),
        findFirst: vi.fn(async () => ({ status: "delivered" })),
      },
    } as unknown as PrismaClient;
    const page = await externalConversationHistory(prisma, actor, {
      externalConversationId: "conversation",
    });
    expect(page).toMatchObject({
      threadId: "external-thread",
      authors: { message: "Author" },
      latestStatus: "delivered",
      sourceUrl: "https://app.slack.com/client/T-example/C-example",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "external-thread" } }),
    );
  });
});
