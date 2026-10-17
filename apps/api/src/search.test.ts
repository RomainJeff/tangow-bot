import type { Actor } from "@rakazo/contracts";
import { LINK_BLOCK_KINDS } from "@rakazo/contracts";
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

/** A person's message as the search query returns it. */
function said(id: string, seq: number, blocks: unknown[]) {
  return {
    id,
    sessionId: "session-1",
    seq,
    parentId: seq === 0 ? null : `entry-${seq - 1}`,
    type: "user.message",
    payload: { blocks, source: "app" },
    entryBotId: null,
    runId: null,
    createdAt: new Date("2026-10-12T09:00:00.000Z"),
    threadId: "thread-1",
    botId: "bot-1",
    botName: "Bot",
  };
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
      expect(query.text).toContain("ORDER BY e.seq DESC");
    }
  });

  it("preserves artifact priority and skips missing messages regardless of batch row order", async () => {
    const { prisma } = fixture(3);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { artifactId: "artifact-2", ...said("message-2", 8, []) },
        { artifactId: "artifact-0", ...said("message-0", 6, []) },
      ])
      .mockResolvedValueOnce([{ artifactId: "group-artifact-1", ...said("group-message", 3, []) }]);
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

  it("cuts every link block kind out of the JSON the SQL pre-filter matches, so a title takes no result slot", async () => {
    const { prisma } = fixture(0);
    await querySpaceSearch(prisma as unknown as PrismaClient, actor, "report");
    // No artifact matched, so both calls are the tagged-template message searches.
    const calls = prisma.$queryRaw.mock.calls.slice(0, 2);
    expect(calls).toHaveLength(2);
    for (const [strings, ...values] of calls) {
      const text = [...strings].join("?");
      expect(text).toContain("jsonb_path_query_array(e.payload -> 'blocks', ?::jsonpath)");
      expect(text).not.toContain("e.payload::text");
      const path = values.find((value) => typeof value === "string" && value.startsWith("$[*]"));
      for (const kind of LINK_BLOCK_KINDS) expect(path).toContain(`@.kind != "${kind}"`);
    }
  });

  it("never matches a page title kept in a preview card or a mention", async () => {
    const sentinel = "ZEBRA-SENTINEL-TITLE";
    const { prisma } = fixture(0);
    // No artifact matched, so the first query is the direct message search.
    prisma.$queryRaw
      .mockResolvedValueOnce([
        said("message-1", 3, [
          { kind: "text", text: "see https://example.test/a" },
          {
            kind: "link_preview",
            url: "https://example.test/a",
            format: "compact",
            title: sentinel,
          },
          { kind: "link_mention", url: "https://example.test/a", title: sentinel },
        ]),
        said("message-2", 4, [{ kind: "text", text: `I wrote ${sentinel} myself` }]),
      ])
      .mockResolvedValueOnce([]);

    const hits = await querySpaceSearch(prisma as unknown as PrismaClient, actor, sentinel);

    // Only the message the person wrote matches; the card's title is not searchable.
    expect(hits.map((hit) => hit.messageId)).toEqual(["message-2"]);
  });
});
