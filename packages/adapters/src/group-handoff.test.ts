import type { PrismaClient } from "@rakazo/db";
import { appendSessionEntryInTransaction } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handoffToGroupBot, loadGroupContext } from "./group-handoff.js";

vi.mock("../../db/src/sessions.js", async () =>
  (await import("@rakazo/db/sessions.test-support")).stubbedDbSessions(),
);

beforeEach(() => {
  vi.clearAllMocks();
});

/** The entry that woke the handing-off run. */
type Source = { type: string; payload: Record<string, unknown> } | null;
const handoffFrom = (fromBotId: string, hop: number): Source => ({
  type: "handoff",
  payload: { fromBotId, toBotId: "bot-a", text: "Stage", hop },
});
/** The handoff entries the run wrote. */
const handoffs = () =>
  vi
    .mocked(appendSessionEntryInTransaction)
    .mock.calls.map(([, draft]) => draft)
    .filter((draft) => draft.type === "handoff");

const run = {
  id: "run-a",
  spaceId: "workspace-1",
  threadId: "thread-1",
  botId: "bot-a",
  userId: "user-1",
};

function harness(
  source: Source,
  existing?: { sourceRuns: { id: string; botId: string }[] },
  runRow: { routineId?: string | null; trigger?: string; inheritedHop?: number | null } = {},
  /** The bots the run's person can use. */
  usable = ["bot-a", "bot-b", "bot-c"],
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    sessionEntry: {
      findUnique: vi.fn(async () => source),
      findFirst: vi.fn(async () => existing ?? null),
    },
    bot: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => usable.includes(id)).map((id) => ({ id })),
      ),
    },
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
          bot: { id, name: id.toUpperCase() },
        })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        sessionId: "session-1",
        sourceMessageId: source ? "message-source" : null,
        routineId: runRow.routineId ?? null,
        trigger: runRow.trigger ?? "follow_up",
        sourceMessage: source,
      })),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: runCreate,
    },
    routine: { findUnique: vi.fn(async () => ({ inheritedHop: runRow.inheritedHop ?? null })) },
    thread: {
      update: vi.fn(async () => ({ nextEventSeq: 2 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    chatGroupPerson: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: { create: vi.fn(async () => ({ id: "task-b" })) },
    event: {
      findFirst: vi.fn(async () => ({ seq: 1 })),
      create: vi.fn(async () => ({ seq: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    runCreate,
  };
}

describe("group handoff ownership", () => {
  it("marks a new ownership transfer as a follow-up with a chain hop", async () => {
    const { deps, runCreate } = harness({ type: "user.message", payload: {} });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(handoffs()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        runId: "run-a",
        payload: {
          fromBotId: "bot-a",
          toBotId: "bot-b",
          text: "Do the distinct next stage",
          hop: 1,
        },
      }),
    ]);
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "follow_up", sourceMessageId: "entry-new" }),
      }),
    );
  });

  it("refuses to bounce a handed-off stage straight back to its sender", async () => {
    const { deps, runCreate } = harness(handoffFrom("bot-b", 1));

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "You investigate it",
      }),
    ).resolves.toEqual({
      error:
        "do not hand this stage back to its sender; post the result in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("refuses a handoff to a bot the run's person cannot use", async () => {
    const { deps, runCreate } = harness({ type: "user.message", payload: {} }, undefined, {}, [
      "bot-a",
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Next" }),
    ).resolves.toEqual({
      error: "the person you are answering cannot use that bot; finish this stage yourself",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("caps longer multi-agent handoff chains", async () => {
    const { deps, runCreate } = harness(handoffFrom("bot-b", 6));

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "Stage seven",
      }),
    ).resolves.toEqual({
      error:
        "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("carries a handoff from a run at hop 5 to hop 6, not back to 1", async () => {
    const { deps } = harness({ type: "bot.message.received", payload: { hop: 5 } });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Next stage" }),
    ).resolves.toMatchObject({ ok: true });
    expect(handoffs()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ hop: 6 }) }),
    ]);
  });

  it("carries a handoff from a routine run that inherited hop 5 to hop 6", async () => {
    const { deps } = harness(null, undefined, {
      routineId: "routine-1",
      trigger: "routine",
      inheritedHop: 5,
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Next stage" }),
    ).resolves.toMatchObject({ ok: true });
    expect(handoffs()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ hop: 6 }) }),
    ]);
  });

  it("refuses a handoff from a routine run whose routine was deleted", async () => {
    const { deps, runCreate } = harness(null, undefined, { trigger: "routine" });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", { bot_id: "bot-b", message: "Next stage" }),
    ).resolves.toMatchObject({ error: expect.stringMatching(/limit reached/) });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("reuses the recorded transfer when a source run is retried", async () => {
    const { deps, runCreate } = harness(null, {
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "A duplicate stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });
    expect(handoffs()).toEqual([]);
    expect(runCreate).not.toHaveBeenCalled();
  });
});

describe("group context", () => {
  it("names the group's people, its creator owning unattributed messages, and whom the run answers", async () => {
    const prisma = {
      chatGroup: {
        findUnique: vi.fn(async () => ({
          name: "Trip",
          description: "",
          userId: "ana",
          members: [{ bot: { id: "bot-a", name: "Planner", title: "", description: "" } }],
          people: [{ userId: "ana" }, { userId: "bo" }],
        })),
      },
      chatGroupPerson: {
        findMany: vi.fn(async () => [
          { user: { id: "ana", name: "Ana", image: null } },
          { user: { id: "bo", name: "Bo", image: null } },
        ]),
      },
      $queryRaw: vi.fn(async () => []),
    } as unknown as PrismaClient;

    const group = await loadGroupContext(
      prisma,
      { groupId: "group-1", sessionId: "session-1" },
      { id: "bot-a", name: "Planner" },
      "bo",
    );

    expect(group?.speakers).toEqual({
      names: new Map([
        ["ana", "Ana"],
        ["bo", "Bo"],
      ]),
      ownerId: "ana",
    });
    expect(group?.context).toContain("You are answering Bo, who woke you.");
  });
});
