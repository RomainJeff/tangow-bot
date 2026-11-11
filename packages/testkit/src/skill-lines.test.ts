import { createSkillLineSweep, writeSkillLines } from "@tangow/adapters";
import { appendSessionEntryInTransaction } from "@tangow/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openThreadDb, type ThreadDb } from "./thread-db.js";

type SkillWrite = "skill_create" | "skill_update" | "skill_delete";

let db: ThreadDb;
beforeAll(async () => {
  db = await openThreadDb();
}, 60_000);
beforeEach(() => db.reset());
afterAll(() => db.close());

const said = (id: string, text: string) => ({ id, blocks: [{ kind: "text" as const, text }] });

async function setup(
  run: {
    trigger?: string;
    status?: string;
    threadId?: string;
    updatedAt?: Date;
    messages?: Array<ReturnType<typeof said>>;
  } = {},
  options: { lineOnlyMessages?: boolean } = {},
) {
  await db.seedThread({ id: "thread-1" });
  await db.seedThread({ id: "group-thread", group: { id: "group-1", memberBotIds: ["bot-1"] } });
  await db.seedRun({ id: "run-1", threadId: run.threadId ?? "thread-1", botId: "bot-1", ...run });
  const deps = {
    prisma: db.prisma,
    events: { notify: async () => undefined },
    sessionLog: { append: appendSessionEntryInTransaction },
    ...options,
  };
  let effects = 0;
  /** A skill call of the run, as the executor records it once the call returned. */
  const wrote = (
    kind: SkillWrite,
    name: string,
    { runId = "run-1", result = { ok: true, name } as object } = {},
  ) =>
    db.prisma.externalEffect.create({
      data: {
        spaceId: "space-1",
        runId,
        kind,
        idempotencyKey: `effect-${++effects}`,
        status: "completed",
        request: {},
        result,
        createdAt: new Date(Date.UTC(2026, 9, 10, 9, 0, effects)),
      },
    });
  /** The lines logged in a thread's session, in order. */
  const linesIn = async (threadId: string) =>
    (
      await db.prisma.sessionEntry.findMany({
        where: { type: "skill.learnt", session: { threadId, kind: "thread" } },
        orderBy: { seq: "asc" },
      })
    ).map((entry) => {
      const { change, name } = entry.payload as { change: string; name: string };
      return `${change} ${name}`;
    });
  const unread = async (threadId: string) =>
    (await db.prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).unread;
  return { deps, wrote, linesIn, unread };
}

describe("the skill line of a finished run", () => {
  it("is logged after the run's words, once per skill, in the order the run touched them", async () => {
    const { deps, wrote, linesIn, unread } = await setup({
      messages: [said("final", "Done.")],
    });
    await wrote("skill_create", "Coffee");
    await wrote("skill_update", "Coffee");
    await wrote("skill_update", "Soup");
    await wrote("skill_delete", "Tea");

    await writeSkillLines(deps, "run-1");

    expect(await linesIn("thread-1")).toEqual(["learned Coffee", "updated Soup", "deleted Tea"]);
    expect(await unread("thread-1")).toBe(false);
  });

  it.each(["completed", "failed", "cancelled"])(
    "stands alone when a %s run left no message, and marks nothing unread, once line-only messages are on",
    async (status) => {
      const { deps, wrote, linesIn, unread } = await setup({ status }, { lineOnlyMessages: true });
      await wrote("skill_create", "Coffee");

      await writeSkillLines(deps, "run-1");

      expect(await linesIn("thread-1")).toEqual(["learned Coffee"]);
      expect(await unread("thread-1")).toBe(false);
    },
  );

  it("shows nothing for a run that left no message while line-only messages are off, and never comes back to it", async () => {
    const { deps, wrote, linesIn } = await setup();
    await wrote("skill_create", "Coffee");

    await writeSkillLines(deps, "run-1");
    await writeSkillLines(deps, "run-1");

    expect(await linesIn("thread-1")).toEqual([]);
  });

  it("is written once, however many times the run is resumed, replayed or swept", async () => {
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    const { deps, wrote, linesIn } = await setup({
      updatedAt: new Date(now.getTime() - 10 * 60_000),
      messages: [said("final", "Done.")],
    });
    await wrote("skill_create", "Coffee");
    await writeSkillLines(deps, "run-1");
    await wrote("skill_update", "Coffee");
    await writeSkillLines(deps, "run-1");
    await createSkillLineSweep(deps, { now: () => now })();

    expect(await linesIn("thread-1")).toEqual(["learned Coffee"]);
  });

  it("is added by the sweep for a run that ended over five minutes ago without one", async () => {
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    const { deps, wrote, linesIn } = await setup({
      updatedAt: new Date(now.getTime() - 10 * 60_000),
      messages: [said("first", "Done.")],
    });
    await db.seedRun({
      id: "run-2",
      threadId: "thread-1",
      updatedAt: new Date(now.getTime() - 60_000),
      messages: [said("second", "Done too.")],
    });
    await wrote("skill_create", "Coffee");
    await wrote("skill_create", "Tea", { runId: "run-2" });
    const sweep = createSkillLineSweep(deps, { now: () => now });

    await sweep();
    await sweep();

    expect(await linesIn("thread-1")).toEqual(["learned Coffee"]);
  });

  it("folds each skill's successful writes into one line, and skips a refused call", async () => {
    const { deps, wrote, linesIn } = await setup({ messages: [said("final", "Done.")] });
    await wrote("skill_create", "Coffee");
    await wrote("skill_update", "Coffee");
    await wrote("skill_update", "Soup");
    await wrote("skill_update", "Soup");
    await wrote("skill_update", "Tea");
    await wrote("skill_delete", "Tea");
    await wrote("skill_create", "Jam");
    await wrote("skill_delete", "Jam");
    await wrote("skill_create", "Rice", {
      result: { error: 'A skill named "Rice" already exists.' },
    });

    await writeSkillLines(deps, "run-1");

    expect(await linesIn("thread-1")).toEqual([
      "learned Coffee",
      "updated Soup",
      "deleted Tea",
      "deleted Jam",
    ]);
  });

  it.each([
    [true, ["updated Shared", "updated Picked"]],
    [false, []],
  ])(
    "from a silent routine run stands alone in the bot's conversation, only for a skill another bot reads now, when line-only messages are %s",
    async (lineOnlyMessages, expected) => {
      const { deps, wrote, linesIn } = await setup(
        { trigger: "routine", threadId: "group-thread" },
        { lineOnlyMessages },
      );
      await db.seedThread({ id: "thread-2", botId: "bot-2" });
      const owner = { spaceId: "space-1", userId: "user-1" };
      const setting = (skillKey: string, availability: string) =>
        db.prisma.skillSetting.create({ data: { ...owner, skillKey, availability } });
      const pick = (skillKey: string, botId: string) =>
        db.prisma.botSkill.create({ data: { ...owner, botId, skillKey, enabled: true } });
      await setting("user:picked", "selected");
      await pick("user:picked", "bot-2");
      await setting("user:mine", "selected");
      await pick("user:mine", "bot-1");
      await setting("user:off", "disabled");
      await pick("user:off", "bot-2");
      for (const name of ["Shared", "Picked", "Mine", "Off"]) await wrote("skill_update", name);
      await wrote("skill_create", "New");

      await writeSkillLines(deps, "run-1");

      expect(await linesIn("group-thread")).toEqual([]);
      expect(await linesIn("thread-1")).toEqual(expected);
    },
  );
});
