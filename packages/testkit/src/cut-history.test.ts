import { PostgresSessionLog } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { SessionId } from "@rakazo/contracts";
import { clearThread, rewindThread } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { querySpaceSearch } from "../../../apps/api/src/search.ts";
import { loadChain } from "../../../apps/api/src/thread-message-pages.ts";
import { openThreadDb, type ThreadDb } from "./thread-db.js";

const actor = { spaceId: "space-1", userId: "user-1" };
const said = (text: string): MessageBlock[] => [{ kind: "text", text }];

describe("what a rewind or a clear cut", () => {
  let db: ThreadDb;
  beforeAll(async () => {
    db = await openThreadDb();
    await db.seedThread({ id: "rewound" });
    await db.seedMessage({ id: "dock-kept", threadId: "rewound", blocks: said("Dock A is free.") });
    await db.seedMessage({ id: "dock-cut", threadId: "rewound", blocks: said("Dock B is free.") });
    await rewindThread(db.prisma, {
      spaceId: actor.spaceId,
      threadId: "rewound",
      botId: "bot-1",
      messageId: "dock-cut",
    });
    await db.seedThread({ id: "cleared", botId: "bot-2" });
    await db.seedMessage({ id: "buoy-cut", threadId: "cleared", blocks: said("Buoy one.") });
    await clearThread(db.prisma, { spaceId: actor.spaceId, threadId: "cleared", botId: "bot-2" });
    await db.seedMessage({ id: "buoy-kept", threadId: "cleared", blocks: said("Buoy two.") });
  }, 60_000);
  afterAll(() => db.close());

  it("is out of search", async () => {
    const found = async (query: string) =>
      (await querySpaceSearch(db.prisma, actor, query)).flatMap((hit) =>
        hit.kind === "message" ? [hit.messageId] : [],
      );
    expect(await found("Dock")).toEqual(["dock-kept"]);
    expect(await found("Buoy")).toEqual(["buoy-kept"]);
  });

  it("is out of a bot's export", async () => {
    const log = new PostgresSessionLog(db.prisma);
    const chainOf = async (threadId: string) => {
      const { sessionId } = await db.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
      const chain = await loadChain(log, SessionId.parse(sessionId), 1);
      return chain.map((entry) => (entry.type === "user.message" ? entry.id : entry.type));
    };
    expect(await chainOf("rewound")).toEqual(["dock-kept", "rewind"]);
    expect(await chainOf("cleared")).toEqual(["clear", "buoy-kept"]);
  });
});
