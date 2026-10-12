import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { querySpaceSearch } from "../../../apps/api/src/search.ts";
import { openThreadDb, type ThreadDb } from "./thread-db.js";

const actor = { spaceId: "space-1", userId: "user-1" };

describe("space search over the threads' sessions", () => {
  let db: ThreadDb;
  beforeAll(async () => {
    db = await openThreadDb();
    await db.seedThread({ id: "thread-1" });
    await db.seedThread({ id: "group-thread", group: { id: "group-1", memberBotIds: ["bot-2"] } });
    await db.seedMessage({
      id: "asked",
      threadId: "thread-1",
      blocks: [{ kind: "text", text: "Where is the harbour report?" }],
    });
    await db.prisma.artifact.create({
      data: {
        id: "file-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        name: "harbour.pdf",
        mimeType: "application/pdf",
        size: 1,
        hash: "h",
        storageKey: "k",
      },
    });
    await db.seedRun({
      id: "run-1",
      threadId: "thread-1",
      messages: [
        {
          id: "answered",
          blocks: [
            { kind: "text", text: "Here it is." },
            {
              kind: "file",
              artifactId: "file-1",
              name: "harbour.pdf",
              mimeType: "application/pdf",
              size: 1,
            },
          ],
        },
      ],
    });
    await db.seedMessage({
      id: "group-said",
      threadId: "group-thread",
      blocks: [{ kind: "text", text: "The harbour opens at nine." }],
    });
  }, 60_000);
  afterAll(() => db.close());

  it("finds a message, a file and a group message by the entries that hold them", async () => {
    const hits = await querySpaceSearch(db.prisma, actor, "harbour");

    const holder = await db.prisma.sessionEntry.findFirstOrThrow({
      where: { runId: "run-1", payload: { path: ["blocks"], array_contains: [{ kind: "file" }] } },
    });
    expect(hits.map(({ kind, messageId }) => [kind, messageId])).toEqual(
      expect.arrayContaining([
        ["message", "asked"],
        ["message", "group-said"],
        ["file", holder.id],
      ]),
    );
  });
});
