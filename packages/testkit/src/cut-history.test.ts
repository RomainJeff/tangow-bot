import { PostgresSessionLog } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { SessionId, toThreadEntry } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import { clearThread, rewindThread, sessionEntryFromRow } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { querySpaceSearch } from "../../../apps/api/src/search.ts";
import { loadChain } from "../../../apps/api/src/thread-message-pages.ts";
import { openThreadDb, type ThreadDb } from "./thread-db.js";

const actor = { spaceId: "space-1", userId: "user-1" };
const said = (text: string): MessageBlock[] => [{ kind: "text", text }];

describe("what a rewind or a clear cut, and what a hidden peer run said", () => {
  let db: ThreadDb;
  const found = async (query: string, kind: "message" | "file" = "message") =>
    (await querySpaceSearch(db.prisma, actor, query))
      .flatMap((hit) => (hit.kind === kind ? [hit.messageId ?? hit.artifactId] : []))
      .sort();
  const sessionOf = async (threadId: string) =>
    SessionId.parse(
      (await db.prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).sessionId,
    );
  const chainOf = async (threadId: string) =>
    (await loadChain(new PostgresSessionLog(db.prisma), await sessionOf(threadId), 1)).map(
      (entry) => (entry.type === "user.message" ? entry.id : entry.type),
    );
  /** The person's messages on each reading of the thread: the screen, the chain and search. */
  const readings = async (threadId: string, query: string) => {
    const rows = await db.prisma.sessionEntry.findMany({
      where: { sessionId: await sessionOf(threadId) },
      orderBy: { seq: "asc" },
    });
    const view = projectThreadView(rows.map((row) => toThreadEntry(sessionEntryFromRow(row))));
    return {
      view: view.rows
        .flatMap(({ item }) => (item.kind === "message" && item.role === "user" ? [item.id] : []))
        .sort(),
      chain: (await chainOf(threadId)).filter((id) => !["rewind", "clear"].includes(id)).sort(),
      search: await found(query),
    };
  };
  const rewind = (threadId: string, botId: string, messageId: string) =>
    rewindThread(db.prisma, { spaceId: actor.spaceId, threadId, botId, messageId });

  beforeAll(async () => {
    db = await openThreadDb();
    await db.seedThread({ id: "rewound" });
    await db.seedMessage({ id: "dock-kept", threadId: "rewound", blocks: said("Dock A is free.") });
    await db.seedMessage({ id: "dock-cut", threadId: "rewound", blocks: said("Dock B is free.") });
    await rewind("rewound", "bot-1", "dock-cut");
    await db.seedThread({ id: "cleared", botId: "bot-2" });
    await db.seedMessage({ id: "buoy-cut", threadId: "cleared", blocks: said("Buoy one.") });
    await clearThread(db.prisma, { spaceId: actor.spaceId, threadId: "cleared", botId: "bot-2" });
    await db.seedMessage({ id: "buoy-kept", threadId: "cleared", blocks: said("Buoy two.") });
  }, 60_000);
  afterAll(() => db.close());

  it("is out of search", async () => {
    expect(await found("Dock")).toEqual(["dock-kept"]);
    expect(await found("Buoy")).toEqual(["buoy-kept"]);
  });

  it("is out of a group's search and of a file's search", async () => {
    await db.seedThread({ id: "crew", group: { id: "group-1", memberBotIds: ["bot-3"] } });
    await db.seedMessage({ id: "rope-kept", threadId: "crew", blocks: said("Rope one.") });
    await db.seedMessage({ id: "rope-cut", threadId: "crew", blocks: said("Rope two.") });
    await rewindThread(db.prisma, {
      spaceId: actor.spaceId,
      threadId: "crew",
      botId: "bot-3",
      groupId: "group-1",
      messageId: "rope-cut",
    });
    await db.seedThread({ id: "filed", botId: "bot-4" });
    await db.prisma.artifact.create({
      data: {
        id: "chart-file",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-4",
        name: "harbour-chart.pdf",
        mimeType: "application/pdf",
        size: 1,
        hash: "h",
        storageKey: "k",
      },
    });
    const chart: MessageBlock = {
      kind: "file",
      artifactId: "chart-file",
      name: "harbour-chart.pdf",
      mimeType: "application/pdf",
      size: 1,
    };
    await db.seedMessage({ id: "chart-cut", threadId: "filed", blocks: [chart] });
    await rewind("filed", "bot-4", "chart-cut");

    expect(await found("Rope")).toEqual(["rope-kept"]);
    expect(await found("harbour-chart", "file")).toEqual([]);
  });

  it("is out of a bot's export", async () => {
    expect(await chainOf("rewound")).toEqual(["dock-kept", "rewind"]);
    expect(await chainOf("cleared")).toEqual(["clear", "buoy-kept"]);
  });

  it("refuses a rewind into what an earlier rewind cut, so the screen, the chain and search agree", async () => {
    await db.seedThread({ id: "stale", botId: "bot-5" });
    for (const [id, text] of [
      ["alpha", "Stale alpha."],
      ["beta", "Stale beta."],
      ["gamma", "Stale gamma."],
    ]) {
      await db.seedMessage({ id: id!, threadId: "stale", blocks: said(text!) });
    }
    await rewind("stale", "bot-5", "gamma");
    await db.seedMessage({ id: "epsilon", threadId: "stale", blocks: said("Stale epsilon.") });

    await expect(rewind("stale", "bot-5", "gamma")).resolves.toBeNull();
    const kept = ["alpha", "beta", "epsilon"];
    expect(await readings("stale", "Stale")).toEqual({ view: kept, chain: kept, search: kept });
  });

  it("refuses a rewind to a message a clear cut, so the screen, the chain and search agree", async () => {
    await db.seedThread({ id: "stale-clear", botId: "bot-6" });
    await db.seedMessage({ id: "ember-1", threadId: "stale-clear", blocks: said("Ember one.") });
    await clearThread(db.prisma, {
      spaceId: actor.spaceId,
      threadId: "stale-clear",
      botId: "bot-6",
    });
    await db.seedMessage({ id: "ember-2", threadId: "stale-clear", blocks: said("Ember two.") });

    await expect(rewind("stale-clear", "bot-6", "ember-1")).resolves.toBeNull();
    const kept = ["ember-2"];
    expect(await readings("stale-clear", "Ember")).toEqual({
      view: kept,
      chain: kept,
      search: kept,
    });
  });

  it("keeps a hidden peer run's words out of search, as the thread does", async () => {
    await db.seedThread({ id: "peer", botId: "bot-7" });
    await db.seedRun({
      id: "run-peer",
      threadId: "peer",
      trigger: "bot_message",
      messages: [{ id: "peer-said", blocks: said("Lantern stock is low.") }],
    });
    await db.seedRun({
      id: "run-own",
      threadId: "peer",
      messages: [{ id: "own-said", blocks: said("Lantern order placed.") }],
    });

    expect(await found("Lantern")).toEqual(["own-said"]);
  });
});
