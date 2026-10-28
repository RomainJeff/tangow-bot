import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { IsolationError, type PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  getOwnedArtifact,
  getSpaceArtifact,
  resolveGroupSendAttachments,
  resolveSendAttachments,
} from "./artifacts.js";
import { createRouter, type RouterDeps } from "./router.js";

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
const stranger = { spaceId: "space-2", userId: "user-9" } as Actor;
const row = {
  id: "preview-1",
  botId: "bot-1",
  groupId: null as string | null,
  runId: null,
  storageKey: "blob-1",
  name: "link-preview.webp",
  mimeType: "image/webp",
  size: 3,
  createdAt: new Date("2026-10-05T10:00:00.000Z"),
  isLinkPreview: true,
  isWidget: false,
};

/** A table that answers only for the rows the where clause really matches. */
function artifactTable(rows: Array<typeof row & { spaceId: string; userId: string }>) {
  const matches = (candidate: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR")
        return (value as Array<Record<string, unknown>>).some((w) => matches(candidate, w));
      if (value && typeof value === "object" && "in" in value) {
        return (value as { in: unknown[] }).in.includes(candidate[key]);
      }
      return candidate[key] === value;
    });
  return {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((candidate) => matches(candidate, where)),
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((candidate) => matches(candidate, where)) ?? null,
    ),
  };
}

const stored = [{ ...row, spaceId: "space-1", userId: "user-1" }];
const files = {
  get: vi.fn(async () => new Uint8Array([1, 2, 3])),
};

describe("card images are not files (CA 44)", () => {
  it("cannot be attached to a message in a bot thread", async () => {
    const artifact = artifactTable(stored);
    await expect(
      resolveSendAttachments({ prisma: { artifact } as never }, actor, "bot-1", ["preview-1"]),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(artifact.findMany.mock.calls[0]?.[0].where).toMatchObject({ isLinkPreview: false });
  });

  it("cannot be attached to a message in a group thread", async () => {
    const artifact = artifactTable([{ ...stored[0]!, groupId: "group-1" }]);
    await expect(
      resolveGroupSendAttachments(
        { prisma: { artifact } as never },
        actor,
        "group-1",
        ["bot-1"],
        ["preview-1"],
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(artifact.findMany.mock.calls[0]?.[0].where).toMatchObject({ isLinkPreview: false });
  });

  it("still lets an ordinary file through both", async () => {
    const file = {
      ...stored[0]!,
      id: "file-1",
      isLinkPreview: false,
      name: "report.txt",
      mimeType: "text/plain",
    };
    await expect(
      resolveSendAttachments(
        { prisma: { artifact: artifactTable([file]) } as never },
        actor,
        "bot-1",
        ["file-1"],
      ),
    ).resolves.toMatchObject({ artifacts: [{ id: "file-1" }] });
  });

  it("is left out of the file list", async () => {
    const artifact = artifactTable([
      ...stored,
      {
        ...stored[0]!,
        id: "widget-1",
        isLinkPreview: false,
        isWidget: true,
        mimeType: "text/html",
        name: "report.html",
      },
      { ...stored[0]!, id: "file-1", isLinkPreview: false, name: "report.txt" },
    ]);
    const prisma = {
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
      artifact,
    } as unknown as PrismaClient;
    const handler = new RPCHandler(createRouter({ prisma } as unknown as RouterDeps));

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/artifacts/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    const body = (await response!.json()) as { json: Array<{ id: string }> };
    expect(body.json.map((file) => file.id)).toEqual(["file-1"]);
  });
});

describe("card images are readable by the thread's reader, and only by them (CA 20)", () => {
  it("serves a bot thread's image to its owner and refuses everyone else", async () => {
    const deps = {
      prisma: { artifact: artifactTable(stored) } as never,
      artifacts: files as never,
    };
    await expect(
      getOwnedArtifact(deps, actor, { botId: "bot-1", artifactId: "preview-1" }),
    ).resolves.toMatchObject({ id: "preview-1", mimeType: "image/webp" });
    await expect(
      getOwnedArtifact(deps, stranger, { botId: "bot-1", artifactId: "preview-1" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      getOwnedArtifact(
        deps,
        { ...actor, userId: "user-2" },
        { botId: "bot-1", artifactId: "preview-1" },
      ),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("serves a group thread's image to its owner and refuses everyone else", async () => {
    const deps = {
      prisma: { artifact: artifactTable([{ ...stored[0]!, groupId: "group-1" }]) } as never,
      artifacts: files as never,
    };
    const input = { artifactId: "preview-1", groupId: "group-1", contextBotId: "bot-1" };
    await expect(getSpaceArtifact(deps, actor, input)).resolves.toMatchObject({ id: "preview-1" });
    await expect(getSpaceArtifact(deps, stranger, input)).rejects.toBeInstanceOf(IsolationError);
    await expect(
      getSpaceArtifact(deps, actor, { ...input, groupId: "group-2" }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});
