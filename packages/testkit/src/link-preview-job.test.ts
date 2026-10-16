import {
  type LinkPreviewJobDeps,
  type LinkPreviewReadResult,
  runLinkPreviewJob,
} from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { removeLinkPreviewBlock } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openThreadDb, type ThreadDb } from "./thread-db.js";

const PAGE = "https://example.test/articles/one?id=7";
const png = new Uint8Array([1, 2, 3, 4]);
const okCompact: LinkPreviewReadResult = {
  ok: true,
  format: "compact",
  article: true,
  title: "A page",
};
const okLarge: LinkPreviewReadResult = {
  ok: true,
  format: "large",
  article: true,
  title: "A big page",
  image: { bytes: Buffer.from(png), width: 1200, height: 630 },
};

let db: ThreadDb;
beforeAll(async () => {
  db = await openThreadDb();
}, 60_000);
beforeEach(() => db.reset());
afterAll(() => db.close());

async function setup(
  options: {
    read?: LinkPreviewJobDeps["read"];
    group?: boolean;
    spaceId?: string;
    threadId?: string;
    botId?: string;
  } = {},
) {
  const { threadId = "thread-1", spaceId, botId } = options;
  await db.seedThread({
    id: threadId,
    spaceId,
    botId,
    ...(options.group ? { group: { id: "group-1", memberBotIds: ["bot-first", "bot-b"] } } : {}),
  });
  const read = vi.fn(options.read ?? (async () => okCompact));
  const notify = vi.fn(async () => undefined);
  const deps: LinkPreviewJobDeps = {
    prisma: db.prisma,
    artifacts: db.artifacts,
    events: { notify },
    read,
  };
  return { read, notify, deps };
}

const text = (value: string): MessageBlock => ({ kind: "text", text: value });
const said = (id: string, blocks: MessageBlock[], threadId = "thread-1") =>
  db.seedMessage({ id, threadId, blocks });
const card = async (messageId: string) => (await db.previewOf(messageId)).card;
const previewArtifacts = () => db.prisma.artifact.findMany({ where: { isLinkPreview: true } });

afterEach(() => installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] })));

describe("link.preview job for a message a person sent", () => {
  it("logs the card against the message and tells the thread once", async () => {
    const { read, notify, deps } = await setup();
    await said("m1", [text(`look ${PAGE} ok`)]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(read).toHaveBeenCalledTimes(1);
    expect(await card("m1")).toEqual({
      kind: "link_preview",
      url: PAGE,
      format: "compact",
      title: "A page",
    });
    const preview = await db.prisma.sessionEntry.findFirstOrThrow({
      where: { type: "link.preview" },
    });
    expect(preview.botId).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("thread-1", expect.any(Number));
  });

  it("copies the cached image into an artifact owned like the thread's attachments", async () => {
    const { deps } = await setup({ read: async () => okLarge });
    await said("m1", [text(PAGE)]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    const [artifact] = await previewArtifacts();
    expect(artifact).toMatchObject({
      previewMessageId: "m1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      groupId: null,
      mimeType: "image/webp",
    });
    expect(await card("m1")).toMatchObject({
      format: "large",
      image: { artifactId: artifact?.id, width: 1200, height: 630 },
    });
    // The cache keeps its own bytes: deleting the artifact must never empty the cache.
    const [cached] = await db.prisma.linkPreviewCache.findMany();
    expect(cached?.imageKey).toBeDefined();
    expect(cached?.imageKey).not.toBe(artifact?.storageKey);
    expect(db.artifacts.keys()).toContain(cached?.imageKey);
    expect(db.artifacts.keys()).toContain(artifact?.storageKey);
  });

  it("writes the icon marker on the card image of a site icon, and not on a page image", async () => {
    const icon = await setup({
      read: async () => ({
        ...okCompact,
        image: okLarge.ok ? okLarge.image : undefined,
        imageFit: "contain",
      }),
    });
    await said("m1", [text(PAGE)]);
    await runLinkPreviewJob(icon.deps, { messageId: "m1" });
    expect(await card("m1")).toMatchObject({ format: "compact", image: { fit: "contain" } });

    const page = await setup({
      read: async () => okLarge,
      threadId: "thread-2",
      botId: "bot-2",
      spaceId: "space-2",
    });
    await said("m2", [text(PAGE)], "thread-2");
    await runLinkPreviewJob(page.deps, { messageId: "m2" });
    expect((await card("m2"))?.image).not.toHaveProperty("fit");
  });

  it("owns the image of a group thread by the group and its first member", async () => {
    const { deps } = await setup({ read: async () => okLarge, group: true });
    await said("m1", [text(PAGE)]);

    await runLinkPreviewJob(deps, { messageId: "m1" });

    const [artifact] = await previewArtifacts();
    expect(artifact).toMatchObject({ groupId: "group-1", botId: "bot-first", userId: "user-1" });
    expect(await card("m1")).toBeDefined();
  });

  describe("skips (CA 28, CA 57)", () => {
    const cases: Array<[string, () => Promise<void>]> = [
      ["a message with no link", () => said("m1", [text("hello")])],
      ["a link in a code fence", () => said("m1", [text(`\`\`\`\n${PAGE}\n\`\`\``)])],
      [
        "a message sent with the preview turned off",
        () => said("m1", [text(PAGE), { kind: "link_preview", removed: true }]),
      ],
      [
        "a link that names a secret in its query",
        () => said("m1", [text("https://example.test/page?token=abc")]),
      ],
      [
        "a message an external channel brought in",
        () =>
          db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)], external: true }),
      ],
      [
        "a message with a pending ask",
        () => said("m1", [text(PAGE), { kind: "ask", text: "Allow?", status: "pending" }]),
      ],
      [
        "an answered ask: the same rule as the screens",
        () => said("m1", [text(PAGE), { kind: "ask", text: "Allow?", status: "answered" }]),
      ],
      [
        "a routine run card",
        () => said("m1", [text(PAGE), { kind: "routine_run", routineName: "r", state: "running" }]),
      ],
      [
        "a handoff",
        () =>
          said("m1", [{ kind: "handoff", fromBotId: "a", toBotId: "b", text: PAGE }, text(PAGE)]),
      ],
      [
        "a message that is not the person's",
        () =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text(PAGE)],
            from: { botId: "bot-1" },
          }),
      ],
    ];

    it.each(cases)("reads nothing and writes nothing for %s", async (_name, seed) => {
      const { read, notify, deps } = await setup();
      await seed();

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(read).not.toHaveBeenCalled();
      expect(await db.prisma.sessionEntry.count({ where: { type: "link.preview" } })).toBe(0);
      expect(await db.prisma.linkPreviewCache.count()).toBe(0);
      expect(await db.prisma.linkPreviewRead.count()).toBe(0);
      expect(notify).not.toHaveBeenCalled();
    });

    it("logs nothing at all for a secret link (no read, no cache, no log)", async () => {
      const { deps } = await setup();
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
      await said("m1", [text("https://example.test/p?magic=SECRET")]);

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(sink.events).toEqual([]);
    });

    it("does nothing for a message that is gone", async () => {
      const { read, deps } = await setup();
      await expect(runLinkPreviewJob(deps, { messageId: "missing" })).resolves.toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe("cache (CA 21, CA 22)", () => {
    it("reads a link once for two messages of the same space", async () => {
      const { read, deps } = await setup();
      await said("m1", [text(PAGE)]);
      await said("m2", [text(`#2 ${PAGE}#frag`)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });
      await runLinkPreviewJob(deps, { messageId: "m2" });

      expect(read).toHaveBeenCalledTimes(1);
      expect(await card("m2")).toMatchObject({ title: "A page" });
    });

    it("does not store the URL, only its hash, and never shares it between spaces", async () => {
      const first = await setup();
      await said("m1", [text(PAGE)]);
      await runLinkPreviewJob(first.deps, { messageId: "m1" });
      const [row] = await db.prisma.linkPreviewCache.findMany();
      expect(JSON.stringify(row)).not.toContain("example.test");
      expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);

      const second = await setup({ spaceId: "space-2", threadId: "thread-2", botId: "bot-2" });
      await said("m2", [text(PAGE)], "thread-2");
      await runLinkPreviewJob(second.deps, { messageId: "m2" });
      const [other] = await db.prisma.linkPreviewCache.findMany({ where: { spaceId: "space-2" } });
      expect(other?.keyHash).not.toBe(row?.keyHash);
      expect(second.read).toHaveBeenCalledTimes(1);
    });

    it("caches a definitive failure and shows no card", async () => {
      const { read, deps } = await setup({
        read: async () => ({ ok: false, reason: "no_title", transient: false }),
      });
      await said("m1", [text(PAGE)]);
      await said("m2", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });
      await runLinkPreviewJob(deps, { messageId: "m2" });

      expect(read).toHaveBeenCalledTimes(1);
      expect((await db.prisma.linkPreviewCache.findFirst())?.status).toBe("failed");
      expect(await card("m1")).toBeUndefined();
      expect(await card("m2")).toBeUndefined();
    });

    it("never caches a transient failure and never retries inside one job", async () => {
      const { read, deps } = await setup({
        read: async () => ({ ok: false, reason: "timeout", transient: true }),
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });
      expect(read).toHaveBeenCalledTimes(1);
      expect(await db.prisma.linkPreviewCache.count()).toBe(0);

      await said("m2", [text(PAGE)]);
      await runLinkPreviewJob(deps, { messageId: "m2" });
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("stops at 30 real reads a minute per space, without a negative cache", async () => {
      const { read, deps } = await setup();
      for (let index = 0; index < 31; index += 1) {
        await said(`m${index}`, [text(`https://example.test/page-${index}`)]);
      }

      for (let index = 0; index < 31; index += 1) {
        await runLinkPreviewJob(deps, { messageId: `m${index}` });
      }

      expect(read).toHaveBeenCalledTimes(30);
      expect(await card("m29")).toBeDefined();
      expect(await card("m30")).toBeUndefined();
      // The refused link left nothing behind: it is tried again once the minute is over.
      expect(await db.prisma.linkPreviewCache.count()).toBe(30);
      expect(await db.prisma.linkPreviewRead.count()).toBe(30);
    });

    it("counts reads per space: another space still has its 30", async () => {
      const busy = await setup();
      await db.prisma.linkPreviewRead.createMany({
        data: Array.from({ length: 30 }, () => ({ spaceId: "space-1", source: "job" })),
      });
      await said("m1", [text(PAGE)]);
      await runLinkPreviewJob(busy.deps, { messageId: "m1" });
      expect(busy.read).not.toHaveBeenCalled();

      const other = await setup({ spaceId: "space-2", threadId: "thread-2", botId: "bot-2" });
      await said("m2", [text(PAGE)], "thread-2");
      await runLinkPreviewJob(other.deps, { messageId: "m2" });
      expect(other.read).toHaveBeenCalledTimes(1);
    });
  });

  describe("concurrency (CA 17, CA 40)", () => {
    it("writes nothing when the thread was deleted while the page was read", async () => {
      const { notify, deps } = await setup({
        read: async () => {
          await db.prisma.thread.delete({ where: { id: "thread-1" } });
          return okLarge;
        },
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(await db.prisma.sessionEntry.count({ where: { type: "link.preview" } })).toBe(0);
      expect(notify).not.toHaveBeenCalled();
      // No card image was left behind for it, row or bytes: only the cache's own copy.
      expect(await previewArtifacts()).toEqual([]);
      expect(db.artifacts.keys()).toHaveLength(1);
    });

    it("drops the card when the preview was removed while the page was read", async () => {
      const { deps } = await setup({
        read: async () => {
          await removeLinkPreviewBlock(db.prisma, {
            spaceId: "space-1",
            threadId: "thread-1",
            messageId: "m1",
          });
          return okLarge;
        },
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(await db.previewOf("m1")).toEqual({ removed: true });
      expect(await previewArtifacts()).toEqual([]);
      // Only the cache's own copy of the image is left.
      expect(db.artifacts.keys()).toHaveLength(1);
    });

    it("does not deadlock the thread while the page is being read", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { deps } = await setup({
        read: async () => {
          await gate;
          return okCompact;
        },
      });
      await said("m1", [text(PAGE)]);

      const job = runLinkPreviewJob(deps, { messageId: "m1" });
      // A write that needs the thread lock (what finalizeRun and threads.send do) goes through.
      await db.prisma.$transaction(
        (tx) => tx.$queryRaw`SELECT id FROM threads WHERE id = ${"thread-1"} FOR UPDATE`,
      );
      release();
      await job;

      expect(await card("m1")).toBeDefined();
    });
  });

  describe("never throws", () => {
    it("survives a reader that throws", async () => {
      const { deps } = await setup({
        read: async () => {
          throw new Error("boom https://example.test/secret?token=1");
        },
      });
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
      await said("m1", [text(PAGE)]);

      await expect(runLinkPreviewJob(deps, { messageId: "m1" })).resolves.toBeUndefined();

      expect(JSON.stringify(sink.events)).not.toContain("example.test");
    });

    it("survives a database that fails", async () => {
      const { deps } = await setup();
      const broken = {
        ...deps,
        prisma: {
          sessionEntry: {
            findUnique: async () => {
              throw new Error("database down");
            },
          },
        },
      } as unknown as LinkPreviewJobDeps;
      await expect(runLinkPreviewJob(broken, { messageId: "m1" })).resolves.toBeUndefined();
    });

    it("gives up after its own deadline", async () => {
      const { deps } = await setup({
        read: async (_url, readDeps) => {
          await new Promise<void>((resolve) =>
            readDeps.signal?.addEventListener("abort", () => resolve()),
          );
          return { ok: false, reason: "aborted", transient: true };
        },
      });
      await said("m1", [text(PAGE)]);

      await runLinkPreviewJob({ ...deps, timeoutMs: 30 }, { messageId: "m1" });

      expect(await card("m1")).toBeUndefined();
    });
  });
});

describe("link.preview job for a bot's run (CA 13, CA 70, CA 71)", () => {
  const LINK = "https://a.test/x";

  async function run(options: {
    status?: string;
    trigger?: string;
    messages?: Array<{ id: string; blocks: MessageBlock[]; midTurn?: true; toPerson?: true }>;
  }) {
    const ctx = await setup();
    await db.seedRun({
      id: "run-1",
      threadId: "thread-1",
      status: options.status,
      trigger: options.trigger,
      messages: options.messages ?? [{ id: "final", blocks: [text(`Source: ${LINK}`)] }],
    });
    return ctx;
  }

  it("previews the final reply and the message_user posts, whether or not the bot opened the link (CA 70)", async () => {
    const { read, deps } = await run({
      messages: [
        { id: "progress", midTurn: true, blocks: [text(`working on ${LINK}`)] },
        { id: "said", midTurn: true, toPerson: true, blocks: [text(`here: ${LINK}`)] },
        { id: "final", blocks: [text(`Source: ${LINK}`)] },
      ],
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(await card("said")).toMatchObject({ url: LINK });
    expect(await card("final")).toMatchObject({ url: LINK });
    // Narration is never previewed.
    expect(await card("progress")).toBeUndefined();
    // Same link twice: one page read.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("previews a link from a run that used no tool at all", async () => {
    const { deps } = await run({
      messages: [{ id: "final", blocks: [text("https://never-opened.test/page")] }],
    });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(await card("final")).toMatchObject({ url: "https://never-opened.test/page" });
  });

  it.each([
    ["a failed run", { status: "failed" }],
    ["a stopped run", { status: "cancelled" }],
    ["a run still going", { status: "running" }],
    ["a bot-to-bot run", { trigger: "bot_message" }],
  ])("shows no card for %s", async (_name, options) => {
    const { read, deps } = await run(options);
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(read).not.toHaveBeenCalled();
    expect(await card("final")).toBeUndefined();
  });

  it.each([
    "https://accounts.google.com/signin/v2/identifier",
    "https://login.example.com/",
    "https://example.com/sso",
    "https://example.com/a/sign-in",
  ])("reads nothing for a link to a sign-in page: %s (CA 71)", async (link) => {
    const { read, deps } = await run({ messages: [{ id: "final", blocks: [text(link)] }] });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(read).not.toHaveBeenCalled();
    expect(await card("final")).toBeUndefined();
  });

  it("still previews a page whose path only contains a sign-in word", async () => {
    const link = "https://example.com/blog/login-tips";
    const { deps } = await run({ messages: [{ id: "final", blocks: [text(link)] }] });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(await card("final")).toMatchObject({ url: link });
  });
});
