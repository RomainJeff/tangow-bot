import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { IsolationError, type PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSER_PREVIEW_DEADLINE_MS,
  createInFlightGuard,
  type LinkPreviewApiDeps,
  previewLinkForComposer,
  removeMessageLinkPreview,
} from "./link-preview.js";
import { createRouter, type RouterDeps } from "./router.js";

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
const URL_TO_PREVIEW = "https://example.test/page?x=1";
// A 1 x 1 lossless WebP: enough for the thumbnail step to decode and re-encode.
const TINY_WEBP = new Uint8Array(
  Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
);

afterEach(() => vi.restoreAllMocks());

function composer(
  options: {
    thread?: object | null;
    cached?: object | null;
    reads?: { space: number; actor: number };
    read?: NonNullable<LinkPreviewApiDeps["linkPreview"]>["read"];
    inFlight?: NonNullable<LinkPreviewApiDeps["linkPreview"]>["inFlight"];
    bytes?: Uint8Array;
  } = {},
) {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    linkPreviewRead: {
      count: vi
        .fn()
        .mockResolvedValueOnce(options.reads?.space ?? 0)
        .mockResolvedValueOnce(options.reads?.actor ?? 0),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    linkPreviewCache: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(),
    },
  };
  const prisma = {
    thread: {
      findFirst: vi.fn(async () =>
        options.thread === undefined ? { id: "thread-1" } : options.thread,
      ),
    },
    linkPreviewCache: {
      findUnique: vi.fn(async () => options.cached ?? null),
    },
    artifact: { create: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const artifacts = {
    get: vi.fn(async () => options.bytes ?? new Uint8Array()),
    put: vi.fn(async () => ({ id: "blob-new", hash: "1" })),
    remove: vi.fn(async () => undefined),
  };
  const read = vi.fn(
    options.read ??
      (async () => ({ ok: true as const, format: "compact" as const, title: "A page" })),
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    artifacts: artifacts as never,
    events: { notify: vi.fn() },
    linkPreview: { read, ...(options.inFlight ? { inFlight: options.inFlight } : {}) },
  } satisfies LinkPreviewApiDeps;
  return { deps, prisma, tx, artifacts, read };
}

const fresh = { expiresAt: new Date(Date.now() + 3_600_000), status: "ok", imageBytes: 0 };

describe("links.preview: access first (CA 19, CA 54)", () => {
  it("refuses a thread the actor cannot write to, before any cache, quota or network", async () => {
    const { deps, prisma, read } = composer({ thread: null });

    await expect(
      previewLinkForComposer(
        deps,
        actor,
        { threadId: "thread-x", url: URL_TO_PREVIEW },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(IsolationError);

    expect(prisma.linkPreviewCache.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("looks the thread up by the actor's own space and user, on a live bot or group", async () => {
    const { deps, prisma } = composer();

    await previewLinkForComposer(
      deps,
      actor,
      { threadId: "thread-1", url: URL_TO_PREVIEW },
      new AbortController().signal,
    );

    expect(prisma.thread.findFirst).toHaveBeenCalledWith({
      where: {
        id: "thread-1",
        spaceId: "space-1",
        userId: "user-1",
        OR: [{ bot: { archivedAt: null } }, { group: { archivedAt: null } }],
      },
      select: { id: true },
    });
  });

  it("answers an anonymous caller with the authentication error, for both procedures", async () => {
    const handler = new RPCHandler(createRouter({ ...composer().deps } as unknown as RouterDeps));
    for (const [path, body] of [
      ["links/preview", { threadId: "thread-1", url: URL_TO_PREVIEW }],
      ["messages/removeLinkPreview", { messageId: "message-1" }],
    ] as const) {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: { actor: null } },
      );
      expect(response?.status, path).toBe(401);
    }
  });
});

describe("links.preview: what it answers", () => {
  it("returns the format, the title and an inline WebP thumbnail, and creates no artifact", async () => {
    const { deps, prisma, artifacts } = composer({
      cached: {
        ...fresh,
        format: "large",
        title: "Big",
        imageKey: "blob-1",
        imageWidth: 800,
        imageHeight: 400,
        imageBytes: TINY_WEBP.length,
      },
      bytes: TINY_WEBP,
    });

    const draft = await previewLinkForComposer(
      deps,
      actor,
      { threadId: "thread-1", url: URL_TO_PREVIEW },
      new AbortController().signal,
    );

    expect(draft).toMatchObject({ format: "large", title: "Big" });
    expect(draft?.thumbnail?.startsWith("data:image/webp;base64,")).toBe(true);
    expect(draft!.thumbnail!.length).toBeLessThanOrEqual(50 * 1024);
    expect(prisma.artifact.create).not.toHaveBeenCalled();
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("gives a photo no title", async () => {
    const { deps } = composer({
      cached: {
        ...fresh,
        format: "photo",
        title: "should not show",
        imageKey: "blob-1",
        imageWidth: 40,
        imageHeight: 40,
        imageBytes: 5,
      },
      bytes: TINY_WEBP,
    });
    const draft = await previewLinkForComposer(
      deps,
      actor,
      { threadId: "thread-1", url: URL_TO_PREVIEW },
      new AbortController().signal,
    );
    expect(draft).not.toHaveProperty("title");
    expect(draft).toMatchObject({ format: "photo" });
  });

  it("answers null, the same null, for every reason a link cannot be previewed", async () => {
    const reasons = [
      "blocked_address",
      "unsafe_url",
      "no_title",
      "timeout",
      "http_error",
      "unsupported_type",
      "rate_limited",
    ] as const;
    const answers = [];
    for (const reason of reasons) {
      const { deps } = composer({
        read: async () => ({ ok: false, reason, transient: reason === "timeout" }),
      });
      answers.push(
        await previewLinkForComposer(
          deps,
          actor,
          { threadId: "thread-1", url: URL_TO_PREVIEW },
          new AbortController().signal,
        ),
      );
    }
    expect(answers).toEqual(reasons.map(() => null));
    // A cached definitive failure looks the same.
    const { deps } = composer({ cached: { ...fresh, status: "failed" } });
    await expect(
      previewLinkForComposer(
        deps,
        actor,
        { threadId: "thread-1", url: URL_TO_PREVIEW },
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
  });

  it("serves the second ask from the cache without reading again", async () => {
    const { deps, read } = composer({ cached: { ...fresh, format: "compact", title: "Cached" } });
    await expect(
      previewLinkForComposer(
        deps,
        actor,
        { threadId: "thread-1", url: URL_TO_PREVIEW },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ format: "compact", title: "Cached" });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("links.preview: quotas (CA 38, CA 55)", () => {
  it("stops a person at 10 reads a minute and the space at 30, with no preview and no cache", async () => {
    for (const reads of [
      { space: 5, actor: 10 },
      { space: 30, actor: 0 },
    ]) {
      const { deps, read, tx } = composer({ reads });
      await expect(
        previewLinkForComposer(
          deps,
          actor,
          { threadId: "thread-1", url: URL_TO_PREVIEW },
          new AbortController().signal,
        ),
      ).resolves.toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(tx.linkPreviewRead.create).not.toHaveBeenCalled();
      expect(tx.linkPreviewCache.upsert).not.toHaveBeenCalled();
    }
  });

  it("allows 3 reads in flight per person and answers null to a fourth", async () => {
    const release: Array<() => void> = [];
    const inFlight = createInFlightGuard(3);
    const { deps, read } = composer({
      inFlight,
      read: () =>
        new Promise((resolve) => {
          release.push(() => resolve({ ok: true, format: "compact", title: "T" }));
        }),
    });
    const ask = () =>
      previewLinkForComposer(
        deps,
        actor,
        { threadId: "thread-1", url: URL_TO_PREVIEW },
        new AbortController().signal,
      );

    const pending = [ask(), ask(), ask()];
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await expect(ask()).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(3);

    for (const resolve of release) resolve();
    await Promise.all(pending);
    // The slots are back.
    const again = ask();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    release.at(-1)?.();
    await again;
  });

  it("counts the in-flight cap per person", () => {
    const guard = createInFlightGuard(1);
    const first = guard.acquire("a");
    expect(first).toBeTypeOf("function");
    expect(guard.acquire("a")).toBeUndefined();
    expect(guard.acquire("b")).toBeTypeOf("function");
    first?.();
    first?.();
    expect(guard.acquire("a")).toBeTypeOf("function");
  });
});

describe("links.preview: cancellation and deadline", () => {
  it("cuts the read when the client goes away", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const { deps } = composer({
      read: async (_url, readDeps) => {
        seen = readDeps.signal;
        controller.abort();
        return { ok: false, reason: "aborted", transient: true };
      },
    });

    await previewLinkForComposer(
      deps,
      actor,
      { threadId: "thread-1", url: URL_TO_PREVIEW },
      controller.signal,
    );

    expect(seen?.aborted).toBe(true);
  });

  it("gives the read ten seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { deps } = composer();
    await previewLinkForComposer(
      deps,
      actor,
      { threadId: "thread-1", url: URL_TO_PREVIEW },
      new AbortController().signal,
    );
    expect(COMPOSER_PREVIEW_DEADLINE_MS).toBe(10_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});

describe("messages.removeLinkPreview (CA 16, CA 19, CA 54)", () => {
  const card = {
    kind: "link_preview",
    url: "https://example.test/a",
    format: "photo",
    image: { artifactId: "a1", width: 1, height: 1 },
  };

  function removal(
    blocks: unknown[],
    message: object | null = { id: "message-1", threadId: "thread-1" },
  ) {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      message: {
        findFirst: vi.fn(async () => ({ id: "message-1", role: "user", blocks })),
        update: vi.fn(),
      },
      thread: {
        findUnique: vi.fn(async () => ({ botId: "bot-1", groupId: null })),
        update: vi.fn(async () => ({ nextEventSeq: 5 })),
      },
      event: { create: vi.fn(async () => ({ seq: 4 })) },
      run: { findUnique: vi.fn() },
      artifact: {
        findMany: vi.fn(async () => [{ id: "a1", storageKey: "blob-1" }]),
        deleteMany: vi.fn(),
      },
    };
    const prisma = {
      message: { findFirst: vi.fn(async () => message) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const artifacts = { remove: vi.fn(async () => undefined) };
    const notify = vi.fn(async () => undefined);
    const deps = {
      prisma: prisma as unknown as PrismaClient,
      artifacts: artifacts as never,
      events: { notify },
    } satisfies LinkPreviewApiDeps;
    return { deps, prisma, tx, artifacts, notify };
  }

  it("refuses a message outside the actor's own threads with the isolation error", async () => {
    const { deps, prisma, tx, artifacts, notify } = removal([card], null);

    await expect(
      removeMessageLinkPreview(deps, actor, { messageId: "message-x" }),
    ).rejects.toBeInstanceOf(IsolationError);

    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        id: "message-x",
        thread: {
          spaceId: "space-1",
          userId: "user-1",
          OR: [{ bot: { archivedAt: null } }, { group: { archivedAt: null } }],
        },
      },
      select: { id: true, threadId: true },
    });
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(artifacts.remove).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("writes the marker, deletes the image row and bytes, and tells every surface", async () => {
    const { deps, tx, artifacts, notify } = removal([{ kind: "text", text: "x" }, card]);

    await removeMessageLinkPreview(deps, actor, { messageId: "message-1" });

    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [
          { kind: "text", text: "x" },
          { kind: "link_preview", removed: true },
        ],
      },
    });
    expect(tx.artifact.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] } } });
    expect(artifacts.remove).toHaveBeenCalledWith(
      "blob-1",
      expect.objectContaining({ spaceId: "space-1" }),
    );
    expect(notify).toHaveBeenCalledWith("thread-1", 4);
  });

  it("is idempotent: a second call writes nothing, deletes nothing and emits nothing", async () => {
    const { deps, tx, artifacts, notify } = removal([
      { kind: "text", text: "x" },
      { kind: "link_preview", removed: true },
    ]);

    await expect(
      removeMessageLinkPreview(deps, actor, { messageId: "message-1" }),
    ).resolves.toBeUndefined();

    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(artifacts.remove).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
