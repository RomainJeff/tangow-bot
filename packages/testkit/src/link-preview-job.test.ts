import {
  KeylessHttpWebProvider,
  type LinkPreviewJobDeps,
  type LinkPreviewReadResult,
  runLinkPreviewJob,
  seenUrlHash,
  toolCompletionAuditPayload,
  webFetchFromTool,
} from "@rakazo/adapters";
import { removeLinkPreviewBlock } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

const PAGE = "https://example.test/articles/one?id=7";
const png = new Uint8Array([1, 2, 3, 4]);
const okCompact: LinkPreviewReadResult = { ok: true, format: "compact", title: "A page" };
const okLarge: LinkPreviewReadResult = {
  ok: true,
  format: "large",
  title: "A big page",
  image: { bytes: Buffer.from(png), width: 1200, height: 630 },
};

function setup(
  options: { read?: LinkPreviewJobDeps["read"]; group?: boolean; spaceId?: string } = {},
) {
  const db = createFakeThreadDb();
  db.seedThread({ id: "thread-1", spaceId: options.spaceId });
  if (options.group) {
    const thread = db.tables.threads.get("thread-1")!;
    thread.botId = null;
    thread.groupId = "group-1";
    db.tables.chatGroupMembers.set("m1", {
      id: "m1",
      groupId: "group-1",
      botId: "bot-first",
      createdAt: new Date(0),
    });
  }
  const read = vi.fn(options.read ?? (async () => okCompact));
  const notify = vi.fn(async () => undefined);
  const deps: LinkPreviewJobDeps = {
    prisma: db.prisma,
    artifacts: db.artifacts,
    events: { notify },
    read,
  };
  return { db, read, notify, deps };
}

const text = (value: string) => ({ kind: "text", text: value });
const card = (blocks: unknown[] | undefined) =>
  blocks?.find((block) => (block as { kind?: string }).kind === "link_preview") as
    | Record<string, unknown>
    | undefined;

afterEach(() => installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] })));

describe("link.preview job for a message a person sent", () => {
  it("appends the card to the stored blocks and emits one thread.message.updated", async () => {
    const { db, read, notify, deps } = setup();
    db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(`look ${PAGE} ok`)] });

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(read).toHaveBeenCalledTimes(1);
    const blocks = db.blocksOf("m1")!;
    expect(blocks).toHaveLength(2);
    expect(card(blocks)).toEqual({
      kind: "link_preview",
      url: PAGE,
      format: "compact",
      title: "A page",
    });
    expect(card(blocks)).not.toHaveProperty("site");
    const [event] = db.eventsOfType("thread.message.updated");
    expect(event?.payload).toEqual({ messageId: "m1", role: "user", blocks });
    expect(event?.botId).toBe("bot-1");
    expect(notify).toHaveBeenCalledWith("thread-1", event?.seq);
  });

  it("keeps blocks this build does not know when it writes the card", async () => {
    const { db, deps } = setup();
    const unknown = { kind: "from_the_future", payload: { n: 1 } };
    db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE), unknown] });

    await runLinkPreviewJob(deps, { messageId: "m1" });

    expect(db.blocksOf("m1")).toContainEqual(unknown);
    expect(card(db.blocksOf("m1"))).toBeDefined();
  });

  it("copies the cached image into an artifact owned like the thread's attachments", async () => {
    const { db, deps } = setup({ read: async () => okLarge });
    db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

    await runLinkPreviewJob(deps, { messageId: "m1" });

    const [artifact] = [...db.tables.artifact.values()];
    expect(artifact).toMatchObject({
      isLinkPreview: true,
      previewMessageId: "m1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      groupId: null,
      mimeType: "image/webp",
    });
    expect(card(db.blocksOf("m1"))).toMatchObject({
      format: "large",
      image: { artifactId: artifact?.id, width: 1200, height: 630 },
    });
    // The cache keeps its own bytes: deleting the artifact must never empty the cache.
    const [cached] = [...db.tables.linkPreviewCache.values()];
    expect(cached?.imageKey).toBeDefined();
    expect(cached?.imageKey).not.toBe(artifact?.storageKey);
    expect(db.artifacts.keys()).toContain(cached?.imageKey);
    expect(db.artifacts.keys()).toContain(artifact?.storageKey);
  });

  it("writes the icon marker on the card image of a site icon, and not on a page image", async () => {
    const icon = setup({
      read: async () => ({
        ...okCompact,
        image: okLarge.ok ? okLarge.image : undefined,
        imageFit: "contain",
      }),
    });
    icon.db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
    await runLinkPreviewJob(icon.deps, { messageId: "m1" });
    expect(card(icon.db.blocksOf("m1"))).toMatchObject({
      format: "compact",
      image: { fit: "contain" },
    });

    const page = setup({ read: async () => okLarge });
    page.db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
    await runLinkPreviewJob(page.deps, { messageId: "m1" });
    expect(card(page.db.blocksOf("m1"))?.image).not.toHaveProperty("fit");
  });

  it("owns the image of a group thread by the group and its first member", async () => {
    const { db, deps } = setup({ read: async () => okLarge, group: true });
    db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

    await runLinkPreviewJob(deps, { messageId: "m1" });

    const [artifact] = [...db.tables.artifact.values()];
    expect(artifact).toMatchObject({ groupId: "group-1", botId: "bot-first", userId: "user-1" });
    expect(db.eventsOfType("thread.message.updated")[0]?.botId).toBe("bot-first");
  });

  describe("skips (CA 28, CA 57)", () => {
    const cases: Array<[string, () => (db: ReturnType<typeof createFakeThreadDb>) => void]> = [
      [
        "a message with no link",
        () => (db) => db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text("hello")] }),
      ],
      [
        "a link in a code fence",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text(`\`\`\`\n${PAGE}\n\`\`\``)],
          }),
      ],
      [
        "a message that already has a card",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [
              text(PAGE),
              { kind: "link_preview", url: PAGE, format: "compact", title: "x" },
            ],
          }),
      ],
      [
        "a message that carries the removal marker",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text(PAGE), { kind: "link_preview", removed: true }],
          }),
      ],
      [
        "a link that names a secret in its query",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text("https://example.test/login?token=abc")],
          }),
      ],
      [
        "a message an external channel brought in",
        () => (db) => {
          db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
          db.tables.externalMessages.set("e1", { id: "e1", threadMessageId: "m1" });
        },
      ],
      [
        "a message with a pending ask",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text(PAGE), { kind: "ask", text: "Allow?", status: "pending" }],
          }),
      ],
      [
        "an answered ask: the same rule as the screens",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text(PAGE), { kind: "ask", text: "Allow?", status: "answered" }],
          }),
      ],
      [
        "a routine run card",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [text(PAGE), { kind: "routine_run", routineName: "r", state: "running" }],
          }),
      ],
      [
        "a handoff",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [{ kind: "handoff", fromBotId: "a", toBotId: "b", text: PAGE }, text(PAGE)],
          }),
      ],
      [
        "a message between bots",
        () => (db) =>
          db.seedMessage({
            id: "m1",
            threadId: "thread-1",
            blocks: [
              { kind: "bot_message_received", fromBotId: "a", fromBotName: "A", text: PAGE },
              text(PAGE),
            ],
          }),
      ],
      [
        "a message that is not the person's",
        () => (db) =>
          db.seedMessage({ id: "m1", threadId: "thread-1", role: "bot", blocks: [text(PAGE)] }),
      ],
    ];

    it.each(cases)("reads nothing and writes nothing for %s", async (_name, seed) => {
      const { db, read, notify, deps } = setup();
      seed()(db);
      const before = structuredClone(db.blocksOf("m1"));

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(read).not.toHaveBeenCalled();
      expect(db.blocksOf("m1")).toEqual(before);
      expect(db.eventsOfType("thread.message.updated")).toEqual([]);
      expect(db.tables.linkPreviewCache.size).toBe(0);
      expect(db.tables.linkPreviewRead.size).toBe(0);
      expect(notify).not.toHaveBeenCalled();
    });

    it("logs nothing at all for a secret link (no read, no cache, no log)", async () => {
      const { db, deps } = setup();
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
      db.seedMessage({
        id: "m1",
        threadId: "thread-1",
        blocks: [text("https://example.test/p?magic=SECRET")],
      });

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(sink.events).toEqual([]);
    });

    it("does nothing for a message that is gone", async () => {
      const { read, deps } = setup();
      await expect(runLinkPreviewJob(deps, { messageId: "missing" })).resolves.toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe("cache (CA 21, CA 22)", () => {
    it("reads a link once for two messages of the same space", async () => {
      const { db, read, deps } = setup();
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
      db.seedMessage({ id: "m2", threadId: "thread-1", blocks: [text(`#2 ${PAGE}#frag`)] });

      await runLinkPreviewJob(deps, { messageId: "m1" });
      await runLinkPreviewJob(deps, { messageId: "m2" });

      expect(read).toHaveBeenCalledTimes(1);
      expect(card(db.blocksOf("m2"))).toMatchObject({ title: "A page" });
    });

    it("does not store the URL, only its hash, and never shares it between spaces", async () => {
      const first = setup();
      first.db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
      await runLinkPreviewJob(first.deps, { messageId: "m1" });
      const [row] = [...first.db.tables.linkPreviewCache.values()];
      expect(JSON.stringify(row)).not.toContain("example.test");
      expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);

      const second = setup({ spaceId: "space-2" });
      second.db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
      await runLinkPreviewJob(second.deps, { messageId: "m1" });
      const [other] = [...second.db.tables.linkPreviewCache.values()];
      expect(other?.keyHash).not.toBe(row?.keyHash);
    });

    it("caches a definitive failure and shows no card", async () => {
      const { db, read, deps } = setup({
        read: async () => ({ ok: false, reason: "no_title", transient: false }),
      });
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
      db.seedMessage({ id: "m2", threadId: "thread-1", blocks: [text(PAGE)] });

      await runLinkPreviewJob(deps, { messageId: "m1" });
      await runLinkPreviewJob(deps, { messageId: "m2" });

      expect(read).toHaveBeenCalledTimes(1);
      expect([...db.tables.linkPreviewCache.values()][0]?.status).toBe("failed");
      expect(card(db.blocksOf("m1"))).toBeUndefined();
      expect(card(db.blocksOf("m2"))).toBeUndefined();
    });

    it("never caches a transient failure and never retries inside one job", async () => {
      const { db, read, deps } = setup({
        read: async () => ({ ok: false, reason: "timeout", transient: true }),
      });
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

      await runLinkPreviewJob(deps, { messageId: "m1" });
      expect(read).toHaveBeenCalledTimes(1);
      expect(db.tables.linkPreviewCache.size).toBe(0);

      db.seedMessage({ id: "m2", threadId: "thread-1", blocks: [text(PAGE)] });
      await runLinkPreviewJob(deps, { messageId: "m2" });
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("stops at 30 real reads a minute per space, without a negative cache", async () => {
      const { db, read, deps } = setup();
      for (let index = 0; index < 31; index += 1) {
        db.seedMessage({
          id: `m${index}`,
          threadId: "thread-1",
          blocks: [text(`https://example.test/page-${index}`)],
        });
      }

      for (let index = 0; index < 31; index += 1) {
        await runLinkPreviewJob(deps, { messageId: `m${index}` });
      }

      expect(read).toHaveBeenCalledTimes(30);
      expect(card(db.blocksOf("m29"))).toBeDefined();
      expect(card(db.blocksOf("m30"))).toBeUndefined();
      // The refused link left nothing behind: it is tried again once the minute is over.
      expect(db.tables.linkPreviewCache.size).toBe(30);
      expect(db.tables.linkPreviewRead.size).toBe(30);
    });

    it("counts reads per space: another space still has its 30", async () => {
      const busy = setup();
      for (let index = 0; index < 30; index += 1) {
        busy.db.tables.linkPreviewRead.set(`r${index}`, {
          id: `r${index}`,
          spaceId: "space-1",
          source: "job",
          createdAt: new Date(),
        });
      }
      busy.db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
      await runLinkPreviewJob(busy.deps, { messageId: "m1" });
      expect(busy.read).not.toHaveBeenCalled();

      const other = setup({ spaceId: "space-2" });
      other.db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });
      await runLinkPreviewJob(other.deps, { messageId: "m1" });
      expect(other.read).toHaveBeenCalledTimes(1);
    });
  });

  describe("concurrency (CA 17, CA 40)", () => {
    it("writes nothing when the thread was cleared while the page was read", async () => {
      const { db, notify, deps } = setup({
        read: async () => {
          db.tables.messages.clear();
          return okLarge;
        },
      });
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(db.eventsOfType("thread.message.updated")).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      // The card image made for it was deleted again, row and bytes.
      expect(db.tables.artifact.size).toBe(0);
    });

    it("drops the card when the preview was removed while the page was read", async () => {
      const { db, deps } = setup({
        read: async () => {
          await removeLinkPreviewBlock(db.prisma, {
            spaceId: "space-1",
            threadId: "thread-1",
            messageId: "m1",
          });
          return okLarge;
        },
      });
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

      await runLinkPreviewJob(deps, { messageId: "m1" });

      expect(db.blocksOf("m1")).toEqual([text(PAGE), { kind: "link_preview", removed: true }]);
      expect(db.eventsOfType("thread.message.updated")).toHaveLength(1);
      expect(db.tables.artifact.size).toBe(0);
      // Only the cache's own copy of the image is left.
      expect(db.artifacts.keys()).toHaveLength(1);
    });

    it("does not deadlock the thread while the page is being read", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { db, deps } = setup({
        read: async () => {
          await gate;
          return okCompact;
        },
      });
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

      const job = runLinkPreviewJob(deps, { messageId: "m1" });
      // A write that needs the thread lock (what finalizeRun and threads.send do) goes through.
      await db.prisma.$transaction(async (tx) => {
        await (
          tx as unknown as {
            $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
          }
        ).$queryRaw`SELECT id FROM threads WHERE id = ${"thread-1"} FOR UPDATE`;
      });
      release();
      await job;

      expect(card(db.blocksOf("m1"))).toBeDefined();
    });
  });

  describe("never throws", () => {
    it("survives a reader that throws", async () => {
      const { db, deps } = setup({
        read: async () => {
          throw new Error("boom https://example.test/secret?token=1");
        },
      });
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

      await expect(runLinkPreviewJob(deps, { messageId: "m1" })).resolves.toBeUndefined();

      expect(JSON.stringify(sink.events)).not.toContain("example.test");
    });

    it("survives a database that fails", async () => {
      const { deps } = setup();
      const broken = {
        ...deps,
        prisma: {
          message: {
            findUnique: async () => {
              throw new Error("database down");
            },
          },
        },
      } as unknown as LinkPreviewJobDeps;
      await expect(runLinkPreviewJob(broken, { messageId: "m1" })).resolves.toBeUndefined();
    });

    it("gives up after its own deadline", async () => {
      const { db, deps } = setup({
        read: async (_url, readDeps) => {
          await new Promise<void>((resolve) =>
            readDeps.signal?.addEventListener("abort", () => resolve()),
          );
          return { ok: false, reason: "aborted", transient: true };
        },
      });
      db.seedMessage({ id: "m1", threadId: "thread-1", blocks: [text(PAGE)] });

      await runLinkPreviewJob({ ...deps, timeoutMs: 30 }, { messageId: "m1" });

      expect(card(db.blocksOf("m1"))).toBeUndefined();
    });
  });
});

describe("link.preview job for a bot's run (CA 13, CA 26-29)", () => {
  const OPENED = "https://a.test/x";

  function run(options: {
    opened?: string[];
    status?: string;
    trigger?: string;
    messages?: Array<{ id: string; nonce?: string | null; blocks: unknown[] }>;
    extraEvents?: Array<Record<string, unknown>>;
  }) {
    const ctx = setup();
    ctx.db.seedRun({
      id: "run-1",
      threadId: "thread-1",
      status: options.status,
      trigger: options.trigger,
      toolEvents: [
        ...(options.opened ?? [OPENED]).map((openedUrl) => ({
          name: "web_fetch",
          outcome: "succeeded",
          openedUrl,
        })),
        ...(options.extraEvents ?? []),
      ],
    });
    for (const message of options.messages ?? [
      { id: "final", nonce: null, blocks: [text(`Source: ${OPENED}`)] },
    ]) {
      ctx.db.seedMessage({
        id: message.id,
        threadId: "thread-1",
        role: "bot",
        runId: "run-1",
        clientNonce: message.nonce ?? null,
        blocks: message.blocks,
      });
    }
    return ctx;
  }

  it("previews the final reply and the message_user posts, for links the bot opened", async () => {
    const { db, read, deps } = run({
      messages: [
        {
          id: "progress",
          nonce: "user-progress:run-1:0:x",
          blocks: [text(`working on ${OPENED}`)],
        },
        { id: "said", nonce: "user-message:run-1:0:x", blocks: [text(`here: ${OPENED}`)] },
        { id: "final", nonce: null, blocks: [text(`Source: ${OPENED}`)] },
      ],
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(card(db.blocksOf("said"))).toMatchObject({ url: OPENED });
    expect(card(db.blocksOf("final"))).toMatchObject({ url: OPENED });
    // Narration is never previewed.
    expect(card(db.blocksOf("progress"))).toBeUndefined();
    // Same link twice: one page read.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("recomputes from the database, so a resumed run is no different (CA 13)", async () => {
    // Nothing but identifiers travels in the job: a worker that never saw the run reads the
    // URLs from the events table by run id.
    const { db, deps } = run({});
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(card(db.blocksOf("final"))).toBeDefined();
  });

  it("matches a link exactly: a fragment is fine, nothing else is", async () => {
    const eligible = ["https://a.test/x#frag", "HTTPS://A.TEST/x"];
    const refused = [
      "https://a.test/x?s=1",
      "https://a.test/x/",
      "https://a.test/X",
      "https://a.test/x%2F",
      "https://a.test:8443/x",
      "http://a.test/x",
      "https://sub.a.test/x",
      "https://a.test./x",
    ];
    for (const link of eligible) {
      const { db, deps } = run({ messages: [{ id: "final", blocks: [text(link)] }] });
      await runLinkPreviewJob(deps, { runId: "run-1" });
      expect(card(db.blocksOf("final")), link).toBeDefined();
    }
    for (const link of refused) {
      const { db, read, deps } = run({ messages: [{ id: "final", blocks: [text(link)] }] });
      await runLinkPreviewJob(deps, { runId: "run-1" });
      expect(card(db.blocksOf("final")), link).toBeUndefined();
      expect(read, `${link} must not be contacted`).not.toHaveBeenCalled();
    }
  });

  it("does not make the final URL of a redirect eligible", async () => {
    // The recorded URL is what the bot asked for; the page it was redirected to is not recorded.
    const { db, read, deps } = run({
      opened: [OPENED],
      messages: [{ id: "final", blocks: [text("https://b.test/z")] }],
    });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(card(db.blocksOf("final"))).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("reads nothing for a link the bot never opened", async () => {
    const { db, read, deps } = run({ opened: [] });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(card(db.blocksOf("final"))).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not count the opened URLs of a run that is not completed", async () => {
    const { db, read, deps } = setup();
    db.seedRun({ id: "run-1", threadId: "thread-1", toolEvents: [] });
    db.seedRun({
      id: "run-2",
      threadId: "thread-1",
      status: "failed",
      toolEvents: [{ name: "web_fetch", outcome: "succeeded", openedUrl: OPENED }],
    });
    db.seedMessage({
      id: "final",
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      blocks: [text(OPENED)],
    });

    await runLinkPreviewJob(deps, { runId: "run-1" });

    expect(read).not.toHaveBeenCalled();
    expect(card(db.blocksOf("final"))).toBeUndefined();
  });

  it("keeps at most 50 opened URLs for a run", async () => {
    const opened = Array.from({ length: 51 }, (_, index) => `https://a.test/${index}`);
    const first = run({ opened, messages: [{ id: "final", blocks: [text(opened[49]!)] }] });
    await runLinkPreviewJob(first.deps, { runId: "run-1" });
    expect(card(first.db.blocksOf("final"))).toBeDefined();

    const beyond = run({ opened, messages: [{ id: "final", blocks: [text(opened[50]!)] }] });
    await runLinkPreviewJob(beyond.deps, { runId: "run-1" });
    expect(card(beyond.db.blocksOf("final"))).toBeUndefined();
  });

  it.each([
    ["a failed run", { status: "failed" }],
    ["a stopped run", { status: "cancelled" }],
    ["a run still going", { status: "running" }],
    ["a bot-to-bot run", { trigger: "bot_message" }],
  ])("shows no card for %s", async (_name, options) => {
    const { db, read, deps } = run(options);
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(read).not.toHaveBeenCalled();
    expect(card(db.blocksOf("final"))).toBeUndefined();
  });

  it("skips a final message that holds a pending ask or a routine card", async () => {
    for (const block of [
      { kind: "ask", text: "ok?", status: "pending" },
      { kind: "routine_run", routineName: "r", state: "completed" },
    ]) {
      const { db, read, deps } = run({
        messages: [{ id: "final", blocks: [text(OPENED), block] }],
      });
      await runLinkPreviewJob(deps, { runId: "run-1" });
      expect(read).not.toHaveBeenCalled();
      expect(card(db.blocksOf("final"))).toBeUndefined();
    }
  });

  it("ignores opened URLs that carry credentials, are too long, or are not http(s)", async () => {
    const { db, read, deps } = run({
      opened: [
        "https://user:pw@a.test/x",
        `https://a.test/${"a".repeat(2100)}`,
        "ftp://a.test/x",
        "file:///etc/passwd",
      ],
      messages: [{ id: "final", blocks: [text("https://a.test/x")] }],
    });
    await runLinkPreviewJob(deps, { runId: "run-1" });
    expect(read).not.toHaveBeenCalled();
    expect(card(db.blocksOf("final"))).toBeUndefined();
  });

  describe("links the bot saw on the public web (CA 58-60)", () => {
    const SEEN = "https://hit.test/article";
    const seenEvent = (url: string, runId = "run-1") => ({
      name: "web_search",
      outcome: "succeeded",
      seenUrlHashes: [seenUrlHash(runId, url)],
    });

    it("previews a link whose hash a web tool of the run recorded, and nothing it did not", async () => {
      const { db, read, deps } = run({
        opened: [],
        extraEvents: [seenEvent(SEEN)],
        messages: [{ id: "final", blocks: [text(`See ${SEEN}#part and https://other.test/x`)] }],
      });
      await runLinkPreviewJob(deps, { runId: "run-1" });
      expect(card(db.blocksOf("final"))).toMatchObject({ url: `${SEEN}#part` });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("uses the same exact equality: a different path, query or slash has no card", async () => {
      for (const link of [`${SEEN}?s=1`, `${SEEN}/`, "https://hit.test/Article"]) {
        const { db, read, deps } = run({
          opened: [],
          extraEvents: [seenEvent(SEEN)],
          messages: [{ id: "final", blocks: [text(link)] }],
        });
        await runLinkPreviewJob(deps, { runId: "run-1" });
        expect(card(db.blocksOf("final")), link).toBeUndefined();
        expect(read, link).not.toHaveBeenCalled();
      }
    });

    it("ignores a hash salted for another run, even from an event of this run", async () => {
      const { db, read, deps } = run({
        opened: [],
        extraEvents: [seenEvent(SEEN, "run-2")],
        messages: [{ id: "final", blocks: [text(SEEN)] }],
      });
      await runLinkPreviewJob(deps, { runId: "run-1" });
      expect(read).not.toHaveBeenCalled();
      expect(card(db.blocksOf("final"))).toBeUndefined();
    });

    it("gives no card to a path-token link that only a browser snapshot showed (M1)", async () => {
      const link = "https://svc.tld/confirm/AbC123";
      const snapshot = {
        name: "browser_snapshot",
        args: {},
        executionId: "call-1",
        durationMs: 1,
        result: {
          content: [],
          details: { url: link, elements: [{ ref: "e1", role: "link", value: link }], tree: link },
        },
      };
      const { db, read, deps } = run({
        opened: [],
        extraEvents: [toolCompletionAuditPayload(snapshot, [], "run-1")],
        messages: [{ id: "final", blocks: [text(`Confirm here: ${link}`)] }],
      });
      await runLinkPreviewJob(deps, { runId: "run-1" });
      expect(read).not.toHaveBeenCalled();
      expect(card(db.blocksOf("final"))).toBeUndefined();
    });

    describe("links in the HTML of a page web_fetch read (CA 67-69)", () => {
      const HOME = "https://home.test/";
      const ARTICLE = "https://home.test/x/123_article";
      const homepage = `<html><head><title>Home</title></head><body>
        <main><p>${"Front page text. ".repeat(20)}</p><a href="/x/123_article">The story</a>
        <a href="javascript:void(0)">js</a><a href="mailto:a@b.test">mail</a>
        <a href="https://u:pw@home.test/secret">creds</a><a href="http://[bad">bad</a></main>
      </body></html>`;
      const signal = new AbortController().signal;
      const context = { operationId: "o", traceId: "t", spaceId: "s", userId: "u", signal };

      /** The audit payload of a real keyless `web_fetch` of the homepage, links and all. */
      async function fetchHomepage(tool = "web_fetch") {
        const web = new KeylessHttpWebProvider({
          fetch: async () =>
            new Response(homepage, { status: 200, headers: { "content-type": "text/html" } }),
          resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
        });
        let links: string[] | undefined;
        const output = await webFetchFromTool(web, context, { url: HOME }, (found) => {
          links = found;
        });
        return toolCompletionAuditPayload(
          {
            name: tool,
            executionId: "call-1",
            durationMs: 1,
            args: { url: HOME },
            result: { content: [], details: output },
          },
          [],
          "run-1",
          tool === "web_fetch" ? links : undefined,
        );
      }

      it("gives a card to an article linked from a homepage the bot read, when it cites it (CA 67)", async () => {
        const { db, read, deps } = run({
          opened: [],
          extraEvents: [await fetchHomepage()],
          messages: [{ id: "final", blocks: [text(`À la une : ${ARTICLE}`)] }],
        });
        await runLinkPreviewJob(deps, { runId: "run-1" });
        expect(card(db.blocksOf("final"))).toMatchObject({ url: ARTICLE });
        expect(read).toHaveBeenCalledTimes(1);
      });

      it("never makes a javascript:, mailto:, credential or unresolvable link seen (CA 69)", async () => {
        const event = await fetchHomepage();
        for (const link of [
          "javascript:void(0)",
          "mailto:a@b.test",
          "https://u:pw@home.test/secret",
          "https://home.test/not-on-the-page",
        ]) {
          const { db, read, deps } = run({
            opened: [],
            extraEvents: [event],
            messages: [{ id: "final", blocks: [text(`See ${link}`)] }],
          });
          await runLinkPreviewJob(deps, { runId: "run-1" });
          expect(card(db.blocksOf("final")), link).toBeUndefined();
          expect(read, link).not.toHaveBeenCalled();
        }
      });

      it("gives no card to a page link that a browser tool returned instead (CA 69)", async () => {
        const { db, read, deps } = run({
          opened: [],
          extraEvents: [await fetchHomepage("browser_navigate")],
          messages: [{ id: "final", blocks: [text(`À la une : ${ARTICLE}`)] }],
        });
        await runLinkPreviewJob(deps, { runId: "run-1" });
        expect(card(db.blocksOf("final"))).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
      });
    });

    it("ignores malformed hashes and keeps at most 300 per run", async () => {
      const hashes = Array.from({ length: 301 }, (_, index) =>
        seenUrlHash("run-1", `https://hit.test/${index}`),
      );
      const events = [
        { name: "web_search", seenUrlHashes: ["not-a-hash", 3, null, "A".repeat(64)] },
        { name: "web_fetch", seenUrlHashes: hashes },
      ];
      const inside = run({
        opened: [],
        extraEvents: events,
        messages: [{ id: "final", blocks: [text("https://hit.test/299")] }],
      });
      await runLinkPreviewJob(inside.deps, { runId: "run-1" });
      expect(card(inside.db.blocksOf("final"))).toBeDefined();
      const beyond = run({
        opened: [],
        extraEvents: events,
        messages: [{ id: "final", blocks: [text("https://hit.test/300")] }],
      });
      await runLinkPreviewJob(beyond.deps, { runId: "run-1" });
      expect(card(beyond.db.blocksOf("final"))).toBeUndefined();
    });
  });

  describe("links seen in a recent run of the same thread and bot (CA 64-66)", () => {
    const SEEN = "https://hit.test/article";
    const DAY = 24 * 60 * 60 * 1000;
    const seen = (url: string, runId: string) => ({
      name: "web_search",
      outcome: "succeeded",
      seenUrlHashes: [seenUrlHash(runId, url)],
    });

    /** A current run without any tool call, and its final reply that re-sends SEEN. */
    function current(otherRuns: Parameters<ReturnType<typeof setup>["db"]["seedRun"]>[0][]) {
      const ctx = setup();
      for (const other of otherRuns) ctx.db.seedRun(other);
      ctx.db.seedRun({ id: "run-now", threadId: "thread-1", toolEvents: [] });
      ctx.db.seedMessage({
        id: "final",
        threadId: "thread-1",
        role: "bot",
        runId: "run-now",
        blocks: [text(`Again: ${SEEN}`)],
      });
      return ctx;
    }

    it("previews a link seen in an earlier run of the thread, re-sent in a run with no tool call (CA 64)", async () => {
      const { db, read, deps } = current([
        {
          id: "run-old",
          threadId: "thread-1",
          createdAt: new Date(Date.now() - 6 * DAY),
          toolEvents: [seen(SEEN, "run-old")],
        },
      ]);
      await runLinkPreviewJob(deps, { runId: "run-now" });
      expect(card(db.blocksOf("final"))).toMatchObject({ url: SEEN });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("previews a link an earlier run opened, not only one it saw", async () => {
      const { db, deps } = current([
        {
          id: "run-old",
          threadId: "thread-1",
          createdAt: new Date(Date.now() - DAY),
          toolEvents: [{ name: "web_fetch", outcome: "succeeded", openedUrl: SEEN }],
        },
      ]);
      await runLinkPreviewJob(deps, { runId: "run-now" });
      expect(card(db.blocksOf("final"))).toBeDefined();
    });

    it("does not use the hash of one run for the link of another (salt)", async () => {
      const { db, read, deps } = current([
        {
          id: "run-old",
          threadId: "thread-1",
          createdAt: new Date(Date.now() - DAY),
          toolEvents: [seen(SEEN, "run-elsewhere")],
        },
      ]);
      await runLinkPreviewJob(deps, { runId: "run-now" });
      expect(read).not.toHaveBeenCalled();
      expect(card(db.blocksOf("final"))).toBeUndefined();
    });

    it.each([
      ["another thread", { threadId: "thread-2" }],
      ["another bot", { botId: "bot-2" }],
      ["a run 8 days old", { createdAt: new Date(Date.now() - 8 * DAY) }],
      ["a failed run", { status: "failed" }],
      ["a stopped run", { status: "stopped" }],
    ])("gives no card, and reads nothing, for a link seen in %s (CA 65)", async (_name, over) => {
      const { db, read, deps } = current([
        {
          id: "run-old",
          threadId: "thread-1",
          createdAt: new Date(Date.now() - DAY),
          toolEvents: [seen(SEEN, "run-old")],
          ...over,
        },
      ]);
      await runLinkPreviewJob(deps, { runId: "run-now" });
      expect(read).not.toHaveBeenCalled();
      expect(card(db.blocksOf("final"))).toBeUndefined();
    });

    it("considers 50 runs at most and reads events for those run ids only (CA 66)", async () => {
      const older = Array.from({ length: 60 }, (_, index) => ({
        id: `run-${index}`,
        threadId: "thread-1",
        // run-0 is the newest of the others, run-59 the oldest.
        createdAt: new Date(Date.now() - (index + 1) * 60_000),
        toolEvents: [seen(`https://hit.test/${index}`, `run-${index}`)],
      }));
      const ctx = current(older);
      ctx.db.seedRun({
        id: "run-failed",
        threadId: "thread-1",
        status: "failed",
        createdAt: new Date(Date.now() - 30_000),
        toolEvents: [seen("https://hit.test/failed", "run-failed")],
      });
      const runs = vi.spyOn(ctx.db.prisma.run, "findMany");
      const events = vi.spyOn(ctx.db.prisma.event, "findMany");
      ctx.db.seedMessage({
        id: "inside",
        threadId: "thread-1",
        role: "bot",
        runId: "run-now",
        blocks: [text("https://hit.test/48")],
      });
      ctx.db.seedMessage({
        id: "beyond",
        threadId: "thread-1",
        role: "bot",
        runId: "run-now",
        blocks: [text("https://hit.test/49")],
      });
      ctx.db.seedMessage({
        id: "failed",
        threadId: "thread-1",
        role: "bot",
        runId: "run-now",
        blocks: [text("https://hit.test/failed")],
      });

      await runLinkPreviewJob(ctx.deps, { runId: "run-now" });

      // 49 others plus the current run: run-48 is the last one that counts.
      expect(card(ctx.db.blocksOf("inside"))).toBeDefined();
      expect(card(ctx.db.blocksOf("beyond"))).toBeUndefined();
      expect(card(ctx.db.blocksOf("failed"))).toBeUndefined();
      expect(runs).toHaveBeenCalledTimes(1);
      expect(runs.mock.calls[0]?.[0]).toMatchObject({
        where: { threadId: "thread-1", botId: "bot-1", status: "completed" },
        orderBy: { createdAt: "desc" },
        take: 49,
      });
      expect(events).toHaveBeenCalledTimes(1);
      const [call] = events.mock.calls as unknown as Array<
        [{ where: { runId: { in: string[] } } }]
      >;
      const where = call![0].where;
      expect(where.runId.in).toHaveLength(50);
      expect(where.runId.in[0]).toBe("run-now");
      expect(where.runId.in).toContain("run-48");
      expect(where.runId.in).not.toContain("run-49");
      expect(where.runId.in).not.toContain("run-failed");
    });
  });
});
