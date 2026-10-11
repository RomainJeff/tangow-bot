import { createSkillLineSweep, writeSkillLines } from "@rakazo/adapters";
import { appendLinkPreviewBlock, clearThread, rewindThread } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

type SkillWrite = "skill_create" | "skill_update" | "skill_delete";

async function setup(
  run: { trigger?: string; status?: string; threadId?: string } = {},
  options: { lineOnlyMessages?: boolean } = {},
) {
  const db = createFakeThreadDb();
  db.seedThread({ id: "thread-1" });
  db.seedThread({ id: "group-thread", botId: null, groupId: "group-1" });
  db.seedRun({ id: "run-1", threadId: run.threadId ?? "thread-1", ...run });
  const deps = { prisma: db.prisma, events: { notify: async () => undefined }, ...options };
  /** A skill call of the run, as the executor records it once the call returned. */
  const wrote = (
    kind: SkillWrite,
    name: string,
    { runId = "run-1", result = { ok: true, name } as unknown } = {},
  ) => {
    const id = `effect-${db.tables.externalEffects.size + 1}`;
    const row = { id, runId, kind, status: "completed", result, createdAt: new Date() };
    db.tables.externalEffects.set(id, row);
  };
  const linesIn = (threadId: string) =>
    [...db.tables.messages.values()]
      .filter((message) => message.threadId === threadId)
      .map((message) => ({
        clientNonce: message.clientNonce,
        lines: (message.blocks as Array<{ kind: string; change?: string; name?: string }>)
          .filter((block) => block.kind === "skill_source")
          .map((block) => `${block.change} ${block.name}`),
      }));
  return { db, deps, wrote, linesIn };
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
    const { db, deps, wrote, linesIn } = await setup();
    wrote("skill_create", "Coffee");
    wrote("skill_update", "Coffee");
    wrote("skill_update", "Soup");
    wrote("skill_delete", "Tea");
    db.seedMessage(reply("bubble", "On it.", "user-message:1"));
    db.seedMessage(reply("final", "Done."));

    await writeSkillLines(deps, "run-1");

    expect(linesIn("thread-1")).toEqual([
      { clientNonce: "user-message:1", lines: [] },
      { clientNonce: null, lines: ["learned Coffee", "updated Soup", "deleted Tea"] },
    ]);
    expect(db.tables.threads.get("thread-1")?.unread).toBe(false);
    expect(
      db.eventsOfType("thread.message.updated").map((event) => [event.runId, event.payload]),
    ).toEqual([[undefined, expect.objectContaining({ messageId: "final" })]]);
  });

  it("goes under the message_user bubble when the run's final text was empty", async () => {
    const { db, deps, wrote, linesIn } = await setup();
    wrote("skill_create", "Coffee");
    db.seedMessage(reply("bubble", "Saved your order.", "user-message:1"));

    await writeSkillLines(deps, "run-1");

    expect(linesIn("thread-1")).toEqual([
      { clientNonce: "user-message:1", lines: ["learned Coffee"] },
    ]);
  });

  it.each(["completed", "failed", "cancelled"])(
    "stands alone when a %s run left no message, and marks nothing unread, once line-only messages are on",
    async (status) => {
      const { db, deps, wrote, linesIn } = await setup({ status }, { lineOnlyMessages: true });
      wrote("skill_create", "Coffee");

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
    const { db, deps, wrote, linesIn } = await setup();
    wrote("skill_create", "Coffee");

    await writeSkillLines(deps, "run-1");
    db.seedMessage(reply("late", "Here."));
    await writeSkillLines(deps, "run-1");

    expect(linesIn("thread-1")).toEqual([{ clientNonce: null, lines: [] }]);
    expect(db.eventsOfType("thread.message.created")).toEqual([]);
  });

  it("is written once, however many times the run is resumed, replayed or swept", async () => {
    const { db, deps, wrote, linesIn } = await setup();
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    db.tables.runs.get("run-1")!.updatedAt = new Date(now.getTime() - 10 * 60_000);
    db.seedMessage(reply("final", "Done."));
    wrote("skill_create", "Coffee");
    await writeSkillLines(deps, "run-1");
    wrote("skill_update", "Coffee");
    await writeSkillLines(deps, "run-1");
    await createSkillLineSweep(deps, { now: () => now })();

    expect(linesIn("thread-1")).toEqual([{ clientNonce: null, lines: ["learned Coffee"] }]);
    expect(db.eventsOfType("thread.message.updated")).toHaveLength(1);
  });

  it("is added by the sweep for a run that ended over five minutes ago without one", async () => {
    const { db, deps, wrote, linesIn } = await setup();
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    db.tables.runs.get("run-1")!.updatedAt = new Date(now.getTime() - 10 * 60_000);
    db.seedRun({ id: "run-2", threadId: "thread-1", updatedAt: new Date(now.getTime() - 60_000) });
    db.seedMessage(reply("first", "Done."));
    db.seedMessage({ ...reply("second", "Done too."), runId: "run-2" });
    wrote("skill_create", "Coffee");
    wrote("skill_create", "Tea", { runId: "run-2" });
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
      ctx.wrote("skill_create", "Coffee");
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
    const { db, deps, wrote } = await setup();
    wrote("skill_create", "Coffee");
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

  it("folds each skill's successful writes into one line, and skips a refused call", async () => {
    const { db, deps, wrote, linesIn } = await setup();
    wrote("skill_create", "Coffee");
    wrote("skill_update", "Coffee");
    wrote("skill_update", "Soup");
    wrote("skill_update", "Soup");
    wrote("skill_update", "Tea");
    wrote("skill_delete", "Tea");
    wrote("skill_create", "Jam");
    wrote("skill_delete", "Jam");
    wrote("skill_create", "Rice", { result: { error: 'A skill named "Rice" already exists.' } });
    db.seedMessage(reply("final", "Done."));

    await writeSkillLines(deps, "run-1");

    expect(linesIn("thread-1")).toEqual([
      {
        clientNonce: null,
        lines: ["learned Coffee", "updated Soup", "deleted Tea", "deleted Jam"],
      },
    ]);
  });

  it.each([
    [true, [{ clientNonce: "skill-source:run-1", lines: ["updated Shared", "updated Picked"] }]],
    [false, []],
  ])(
    "from a silent routine run stands alone in the bot's conversation, only for a skill another bot reads now, when line-only messages are %s",
    async (lineOnlyMessages, expected) => {
      const { db, deps, wrote, linesIn } = await setup(
        { trigger: "routine", threadId: "group-thread" },
        { lineOnlyMessages },
      );
      const owner = { spaceId: "space-1", userId: "user-1" };
      const setting = (skillKey: string, availability: string) =>
        db.tables.skillSettings.set(skillKey, { id: skillKey, ...owner, skillKey, availability });
      const pick = (skillKey: string, botId: string) =>
        db.tables.botSkills.set(`${botId}/${skillKey}`, {
          id: `${botId}/${skillKey}`,
          ...owner,
          botId,
          skillKey,
          enabled: true,
        });
      setting("user:picked", "selected");
      pick("user:picked", "bot-2");
      setting("user:mine", "selected");
      pick("user:mine", "bot-1");
      setting("user:off", "disabled");
      pick("user:off", "bot-2");
      for (const name of ["Shared", "Picked", "Mine", "Off"]) wrote("skill_update", name);
      wrote("skill_create", "New");

      await writeSkillLines(deps, "run-1");

      expect(linesIn("group-thread")).toEqual([]);
      expect(linesIn("thread-1")).toEqual(expected);
    },
  );
});
