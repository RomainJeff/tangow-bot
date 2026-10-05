import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { querySpaceSearch } from "./search.js";

const actor: Actor = { spaceId: "space-test", userId: "user-test" };

function fixture(count: number) {
  const artifacts = Array.from({ length: count }, (_, index) => ({
    id: `artifact-${index}`,
    botId: `bot-${index}`,
    bot: { name: "Bot" },
    name: "report.txt",
    mimeType: "text/plain",
    size: 10,
  }));
  const groupArtifacts = artifacts.map((artifact) => ({
    ...artifact,
    id: `group-${artifact.id}`,
    botId: null,
    bot: null,
    groupId: "group-test",
    group: { name: "Group" },
  }));
  const prisma = {
    bot: { findMany: vi.fn().mockResolvedValue([]) },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: {
      findMany: vi.fn().mockResolvedValueOnce(artifacts).mockResolvedValueOnce(groupArtifacts),
    },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { prisma, artifacts, groupArtifacts };
}

describe("artifact search batching", () => {
  it.each([1, 25])("uses one lookup per destination for %i matching artifacts", async (count) => {
    const { prisma } = fixture(count);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    // Two artifact batches and the existing direct/group message searches.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    const direct = prisma.$queryRaw.mock.calls[0]?.[0];
    const group = prisma.$queryRaw.mock.calls[1]?.[0];
    expect(direct.text).toContain('t."botId" = candidate."targetId"');
    expect(group.text).toContain('t."groupId" = candidate."targetId"');
    for (const query of [direct, group]) {
      expect(query.values).toContain(actor.spaceId);
      expect(query.values).toContain(actor.userId);
      expect(query.text).toContain('ORDER BY m."createdAt" DESC');
    }
  });

  it("preserves artifact priority and skips missing messages regardless of batch row order", async () => {
    const { prisma } = fixture(3);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { artifactId: "artifact-2", id: "message-2", seq: 8 },
        { artifactId: "artifact-0", id: "message-0", seq: 6 },
      ])
      .mockResolvedValueOnce([{ artifactId: "group-artifact-1", id: "group-message", seq: 3 }]);
    const hits = await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    expect(hits.map(({ artifactId, messageId, seq }) => ({ artifactId, messageId, seq }))).toEqual([
      { artifactId: "artifact-0", messageId: "message-0", seq: 6 },
      { artifactId: "artifact-2", messageId: "message-2", seq: 8 },
      { artifactId: "group-artifact-1", messageId: "group-message", seq: 3 },
    ]);
  });

  it("does not issue artifact queries for empty batches", async () => {
    const { prisma } = fixture(0);
    expect(await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report")).toEqual([]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("link previews in search (CA 44, CA 46)", () => {
  it("leaves card images out of both file lookups", async () => {
    const { prisma } = fixture(0);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    const [direct, group] = prisma.artifact.findMany.mock.calls.map(([args]) => args.where);
    expect(direct).toMatchObject({ isLinkPreview: false, groupId: null });
    expect(group).toMatchObject({ isLinkPreview: false });
  });

  it("cuts preview cards out of the JSON the SQL pre-filter matches, so a title takes no result slot", async () => {
    const { prisma } = fixture(0);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    // No artifact matched, so both calls are the tagged-template message searches.
    const sql = prisma.$queryRaw.mock.calls.slice(0, 2).map(([strings]) => [...strings].join("?"));
    expect(sql).toHaveLength(2);
    for (const text of sql) {
      expect(text).toContain("jsonb_path_query_array(m.blocks");
      expect(text).toContain("link_preview");
      expect(text).not.toContain("m.blocks::text");
    }
  });

  it("never matches a page title kept in a preview card", async () => {
    const sentinel = "ZEBRA-SENTINEL-TITLE";
    const { prisma } = fixture(0);
    // No artifact matched, so the first query is the direct message search.
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: "message-1",
          threadId: "thread-1",
          seq: 3,
          botId: "bot-1",
          botName: "Bot",
          blocks: [
            { kind: "text", text: "see https://example.test/a" },
            {
              kind: "link_preview",
              url: "https://example.test/a",
              format: "compact",
              title: sentinel,
            },
          ],
        },
        {
          id: "message-2",
          threadId: "thread-1",
          seq: 4,
          botId: "bot-1",
          botName: "Bot",
          blocks: [{ kind: "text", text: `I wrote ${sentinel} myself` }],
        },
      ])
      .mockResolvedValueOnce([]);

    const hits = await querySpaceSearch(prisma as unknown as PrismaClient, actor, sentinel);

    // Only the message the person wrote matches; the card's title is not searchable.
    expect(hits.map((hit) => hit.messageId)).toEqual(["message-2"]);
  });
});
