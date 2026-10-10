import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillContent } from "@rakazo/adapters";
import {
  createInMemorySkillLock,
  createSkillLibrary,
  createSkillLineSweep,
  writeSkillLines,
} from "@rakazo/adapters";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { appendLinkPreviewBlock, clearThread, rewindThread } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

const owner = { spaceId: "space-1", userId: "user-1" };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The access tables the skill library reads: no rows, so a user's skill is every bot's. */
function accessTables() {
  const table = () => ({
    findMany: async () => [],
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
  });
  return {
    skillSetting: table(),
    botSkill: table(),
    bot: { findMany: async () => [] },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaClient;
}

const skill = (name: string, description = `About ${name}`, body = "Steps"): SkillContent => ({
  kind: "skill-md",
  name,
  content: buildSkillMd({ name, description, body }),
});

async function setup(
  run: { trigger?: string; status?: string; threadId?: string } = {},
  options: { lineOnlyMessages?: boolean } = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-skill-lines-"));
  dirs.push(dataDir);
  let tick = 0;
  const library = createSkillLibrary({
    prisma: accessTables(),
    dataDir,
    lock: createInMemorySkillLock(),
    now: () => new Date(Date.UTC(2026, 9, 10, 9, 0, tick++)),
  });
  const db = createFakeThreadDb();
  db.seedThread({ id: "thread-1" });
  db.seedThread({ id: "group-thread", botId: null, groupId: "group-1" });
  db.seedRun({ id: "run-1", threadId: run.threadId ?? "thread-1", ...run });
  const deps = {
    prisma: db.prisma,
    library,
    events: { notify: async () => undefined },
    ...options,
  };
  let calls = 0;
  const writer = (runId = "run-1", toolCallId = `${runId}-call-${++calls}`) =>
    library.forBot(owner, { botId: "bot-1", botName: "Ada", runId, toolCallId, secrets: [] });
  const linesIn = (threadId: string) =>
    [...db.tables.messages.values()]
      .filter((message) => message.threadId === threadId)
      .map((message) => ({
        clientNonce: message.clientNonce,
        lines: (message.blocks as Array<{ kind: string; change?: string; name?: string }>)
          .filter((block) => block.kind === "skill_source")
          .map((block) => `${block.change} ${block.name}`),
      }));
  return { db, deps, library, writer, linesIn };
}

const reply = (id: string, text: string, clientNonce: string | null = null) => ({
  id,
  threadId: "thread-1",
  role: "bot",
  runId: "run-1",
  botId: "bot-1",
  clientNonce,
  blocks: [{ kind: "text", text }],
});

describe("the skill line of a finished run", () => {
  it("goes under the run's last message, once per skill, in the order the run touched them", async () => {
    const { db, deps, library, writer, linesIn } = await setup();
    await library.forOwner(owner).create(skill("Tea"));
    await library.forOwner(owner).create(skill("Soup"));
    await writer().create(skill("Coffee"));
    await writer().update("user:coffee", skill("Coffee", "About Coffee", "Better"));
    await writer().update("user:soup", skill("Soup", "About Soup", "Hotter"));
    await writer().delete("user:tea");
    await library
      .forOwner(owner)
      .update("user:coffee", skill("Espresso", "About Coffee", "Better"));
    db.seedMessage(reply("bubble", "On it.", "user-message:1"));
    db.seedMessage(reply("final", "Done."));

    await writeSkillLines(deps, "run-1");

    expect(linesIn("thread-1")).toEqual([
      { clientNonce: "user-message:1", lines: [] },
      { clientNonce: null, lines: ["learned Espresso", "updated Soup", "deleted Tea"] },
    ]);
    expect(db.tables.threads.get("thread-1")?.unread).toBe(false);
    expect(
      db.eventsOfType("thread.message.updated").map((event) => [event.runId, event.payload]),
    ).toEqual([[undefined, expect.objectContaining({ messageId: "final" })]]);
  });

  it("goes under the message_user bubble when the run's final text was empty", async () => {
    const { db, deps, writer, linesIn } = await setup();
    await writer().create(skill("Coffee"));
    db.seedMessage(reply("bubble", "Saved your order.", "user-message:1"));

    await writeSkillLines(deps, "run-1");

    expect(linesIn("thread-1")).toEqual([
      { clientNonce: "user-message:1", lines: ["learned Coffee"] },
    ]);
  });

  it.each(["completed", "failed", "cancelled"])(
    "stands alone when a %s run left no message, and marks nothing unread, once line-only messages are on",
    async (status) => {
      const { db, deps, writer, linesIn } = await setup({ status }, { lineOnlyMessages: true });
      await writer().create(skill("Coffee"));

      await writeSkillLines(deps, "run-1");

      expect(linesIn("thread-1")).toEqual([
        { clientNonce: "skill-source:run-1", lines: ["learned Coffee"] },
      ]);
      expect(db.tables.threads.get("thread-1")?.unread).toBe(false);
      expect(db.eventsOfType("thread.message.created").map((event) => event.runId)).toEqual([
        undefined,
      ]);
    },
  );

  it("shows nothing for a run that left no message while line-only messages are off, and never comes back to it", async () => {
    const { db, deps, writer, linesIn } = await setup();
    await writer().create(skill("Coffee"));

    await writeSkillLines(deps, "run-1");
    db.seedMessage(reply("late", "Here."));
    await writeSkillLines(deps, "run-1");

    expect(linesIn("thread-1")).toEqual([{ clientNonce: null, lines: [] }]);
    expect(db.eventsOfType("thread.message.created")).toEqual([]);
  });

  it("is written once, however many times the run is resumed, replayed or swept", async () => {
    const { db, deps, writer, linesIn } = await setup();
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    db.tables.runs.get("run-1")!.updatedAt = new Date(now.getTime() - 10 * 60_000);
    db.seedMessage(reply("final", "Done."));
    await writer("run-1", "call-1").create(skill("Coffee"));
    await writeSkillLines(deps, "run-1");
    await writer("run-1", "call-1").create(skill("Coffee"));
    await writer("run-1", "call-2").update("user:coffee", skill("Coffee", "About Coffee", "More"));
    await writeSkillLines(deps, "run-1");
    await createSkillLineSweep(deps, { now: () => now })();

    expect(linesIn("thread-1")).toEqual([{ clientNonce: null, lines: ["learned Coffee"] }]);
    expect(db.eventsOfType("thread.message.updated")).toHaveLength(1);
  });

  it("is added by the sweep for a run that ended over five minutes ago without one", async () => {
    const { db, deps, writer, linesIn } = await setup();
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    db.tables.runs.get("run-1")!.updatedAt = new Date(now.getTime() - 10 * 60_000);
    db.seedRun({ id: "run-2", threadId: "thread-1", updatedAt: new Date(now.getTime() - 60_000) });
    db.seedMessage(reply("first", "Done."));
    db.seedMessage({ ...reply("second", "Done too."), runId: "run-2" });
    await writer("run-1").create(skill("Coffee"));
    await writer("run-2").create(skill("Tea"));
    const sweep = createSkillLineSweep(deps, { now: () => now });

    await sweep();
    await sweep();

    expect(linesIn("thread-1")).toEqual([
      { clientNonce: null, lines: ["learned Coffee"] },
      { clientNonce: null, lines: [] },
    ]);
  });

  describe("in a conversation the user emptied since", () => {
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    const asked = new Date(now.getTime() - 20 * 60_000);
    const thread = { spaceId: "space-1", threadId: "thread-1", botId: "bot-1" };
    const emptied = async (
      status: string,
      { startedAt = asked, replied = true }: { startedAt?: Date; replied?: boolean } = {},
    ) => {
      const ctx = await setup({ status }, { lineOnlyMessages: true });
      const run = ctx.db.tables.runs.get("run-1")!;
      run.createdAt = startedAt;
      run.updatedAt = new Date(now.getTime() - 10 * 60_000);
      ctx.db.seedMessage({
        ...reply("ask", "Order my coffee."),
        role: "user",
        runId: undefined,
        createdAt: asked,
      });
      if (replied) ctx.db.seedMessage(reply("final", "Done."));
      await ctx.writer().create(skill("Coffee"));
      return ctx;
    };

    it("gets no line back after a clear", async () => {
      const { db, deps, linesIn } = await emptied("completed");

      await clearThread(db.prisma, thread);
      await createSkillLineSweep(deps, { now: () => now })();

      expect(linesIn("thread-1")).toEqual([]);
    });

    it("gets no line back after a rewind to the message that started the run", async () => {
      const { db, deps, linesIn } = await emptied("completed", { replied: false });

      await rewindThread(db.prisma, { ...thread, messageId: "ask" });
      await createSkillLineSweep(deps, { now: () => now })();

      expect(linesIn("thread-1")).toEqual([]);
    });

    it("gets no line back after a rewind to a message sent while the run was going, once its reply is gone", async () => {
      const { db, deps, linesIn } = await emptied("completed", {
        startedAt: new Date(asked.getTime() - 60_000),
      });

      await rewindThread(db.prisma, { ...thread, messageId: "ask" });
      await createSkillLineSweep(deps, { now: () => now })();

      expect(linesIn("thread-1")).toEqual([]);
    });

    it("gets no line for a run the clear stopped before it ended", async () => {
      const { db, deps, linesIn } = await emptied("running");

      await clearThread(db.prisma, thread);
      await createSkillLineSweep(deps, { now: () => now })();

      expect(db.tables.runs.get("run-1")?.status).toBe("cancelled");
      expect(linesIn("thread-1")).toEqual([]);
    });
  });

  it("keeps a link preview written at the same time", async () => {
    const { db, deps, writer } = await setup();
    await writer().create(skill("Coffee"));
    db.seedMessage(reply("final", "See https://example.test/a"));
    db.onMessageRead(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const card = {
      kind: "link_preview" as const,
      url: "https://example.test/a",
      format: "compact" as const,
      title: "A page",
    };

    await Promise.all([
      writeSkillLines(deps, "run-1"),
      appendLinkPreviewBlock(db.prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        messageId: "final",
        block: card,
      }),
    ]);

    expect((db.blocksOf("final") as Array<{ kind: string }>).map((block) => block.kind)).toEqual(
      expect.arrayContaining(["text", "link_preview", "skill_source"]),
    );
  });

  it.each([
    [true, [{ clientNonce: "skill-source:run-1", lines: ["updated Shared"] }]],
    [false, []],
  ])(
    "from a silent routine run stands alone in the bot's conversation, only for a skill other bots read, when line-only messages are %s",
    async (lineOnlyMessages, expected) => {
      const { db, deps, library, writer, linesIn } = await setup(
        { trigger: "routine", threadId: "group-thread" },
        { lineOnlyMessages },
      );
      db.seedRun({ id: "run-2", threadId: "group-thread", trigger: "routine" });
      await library.forOwner(owner).create(skill("Shared", "Book a table"));
      await writer("run-1").update("user:shared", skill("Shared", "Book and pay"));
      await writer("run-2").update("user:shared", skill("Shared", "Book and pay", "Call first"));
      await writer("run-2").create(skill("Mine"));

      await writeSkillLines(deps, "run-1");
      await writeSkillLines(deps, "run-2");

      expect(linesIn("group-thread")).toEqual([]);
      expect(linesIn("thread-1")).toEqual(expected);
    },
  );
});
