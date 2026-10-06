import { updateRoutineRunCard } from "@rakazo/adapters";
import {
  answerRunInputInTransaction,
  appendLinkPreviewBlock,
  type PrismaClient,
  removeLinkPreviewBlock,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

const scope = { spaceId: "space-1", threadId: "thread-1", messageId: "m1" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const routineCard = (state: string) => ({
  kind: "routine_run",
  routineName: "Daily",
  state,
});
const previewCard = {
  kind: "link_preview" as const,
  url: "https://example.test/a",
  format: "compact" as const,
  title: "A page",
};
const unknown = { kind: "from_the_future", n: 1 };

/** Two writers that each read the message, wait, and write: the interleaving that loses updates. */
function racyDb(blocks: unknown[], role = "bot") {
  const db = createFakeThreadDb();
  db.seedThread({ id: "thread-1" });
  db.seedMessage({ id: "m1", threadId: "thread-1", role, blocks });
  db.onMessageRead(() => sleep(10));
  return db;
}

const routineDeps = (db: ReturnType<typeof createFakeThreadDb>) => ({
  prisma: db.prisma,
  events: { notify: async () => undefined },
});
const routineTarget = { spaceId: "space-1", threadId: "thread-1", botId: "bot-1" };

describe("writers that rewrite a message's blocks keep each other's changes (CA 48)", () => {
  it("keeps a removal marker written during a routine card update", async () => {
    const db = racyDb([{ kind: "text", text: "run" }, routineCard("running"), unknown]);

    await Promise.all([
      updateRoutineRunCard(
        routineDeps(db) as never,
        routineTarget,
        "m1",
        () => routineCard("completed") as never,
      ),
      removeLinkPreviewBlock(db.prisma, scope),
    ]);

    const blocks = db.blocksOf("m1")!;
    expect(blocks).toContainEqual(routineCard("completed"));
    expect(blocks).toContainEqual({ kind: "link_preview", removed: true });
    expect(blocks).toContainEqual(unknown);
    expect(
      blocks.filter((block) => (block as { kind: string }).kind === "routine_run"),
    ).toHaveLength(1);
  });

  it("keeps a routine card update written during a preview append, and the other way round", async () => {
    for (const order of ["card first", "append first"] as const) {
      const db = racyDb([{ kind: "text", text: "run" }, routineCard("running"), unknown]);
      const update = () =>
        updateRoutineRunCard(
          routineDeps(db) as never,
          routineTarget,
          "m1",
          () => routineCard("completed") as never,
        );
      const append = () => appendLinkPreviewBlock(db.prisma, { ...scope, block: previewCard });

      await Promise.all(order === "card first" ? [update(), append()] : [append(), update()]);

      const blocks = db.blocksOf("m1")!;
      expect(blocks, order).toContainEqual(routineCard("completed"));
      expect(blocks, order).toContainEqual(previewCard);
      expect(blocks, order).toContainEqual(unknown);
    }
  });

  it("keeps an ask answer and a preview append when they race", async () => {
    const db = racyDb([
      { kind: "text", text: "See https://example.test/a" },
      { kind: "ask", text: "Which one?", status: "pending" },
      unknown,
    ]);
    db.seedRun({ id: "run-1", threadId: "thread-1", status: "waiting_input" });
    db.tables.messages.get("m1")!.runId = "run-1";

    await Promise.all([
      db.prisma.$transaction((tx) =>
        answerRunInputInTransaction(tx as never, {
          spaceId: "space-1",
          threadId: "thread-1",
          runId: "run-1",
          messageId: "m1",
          answeredByUserId: "user-1",
          answer: "the first",
        }),
      ),
      appendLinkPreviewBlock(db.prisma, { ...scope, block: previewCard }),
    ]);

    const blocks = db.blocksOf("m1")!;
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "ask", status: "answered", answer: "the first" }),
    );
    expect(blocks).toContainEqual(previewCard);
    expect(blocks).toContainEqual(unknown);
    // Each write emitted its own full-array event, and the last one has everything.
    const updates = db.eventsOfType("thread.message.updated");
    expect(updates).toHaveLength(2);
    const last = updates.at(-1)!.payload as { blocks: unknown[] };
    expect(last.blocks).toEqual(blocks);
  });

  it("lets only one of two concurrent removals write, and emits one event", async () => {
    const db = racyDb([{ kind: "text", text: "x" }, previewCard]);

    const results = await Promise.all([
      removeLinkPreviewBlock(db.prisma, scope),
      removeLinkPreviewBlock(db.prisma, scope),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["removed", "unchanged"]);
    expect(
      db.blocksOf("m1")!.filter((b) => (b as { kind: string }).kind === "link_preview"),
    ).toEqual([{ kind: "link_preview", removed: true }]);
    expect(db.eventsOfType("thread.message.updated")).toHaveLength(1);
  });

  it("adds a card at most once when two reads of the same message finish together", async () => {
    const db = racyDb([{ kind: "text", text: "x" }], "user");

    const results = await Promise.all([
      appendLinkPreviewBlock(db.prisma, { ...scope, block: previewCard }),
      appendLinkPreviewBlock(db.prisma, { ...scope, block: previewCard }),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["appended", "present"]);
    expect(db.blocksOf("m1")).toHaveLength(2);
  });
});

describe("writing the block", () => {
  it("writes nothing for a message that is gone", async () => {
    const db = createFakeThreadDb();
    db.seedThread({ id: "thread-1" });

    await expect(
      appendLinkPreviewBlock(db.prisma as PrismaClient, { ...scope, block: previewCard }),
    ).resolves.toEqual({ outcome: "gone" });
    await expect(removeLinkPreviewBlock(db.prisma, scope)).resolves.toEqual({ outcome: "gone" });
    expect(db.eventsOfType("thread.message.updated")).toEqual([]);
  });

  it("refuses a message of another thread", async () => {
    const db = createFakeThreadDb();
    db.seedThread({ id: "thread-1" });
    db.seedThread({ id: "thread-2" });
    db.seedMessage({ id: "m1", threadId: "thread-2", blocks: [{ kind: "text", text: "x" }] });

    await expect(
      appendLinkPreviewBlock(db.prisma, { ...scope, block: previewCard }),
    ).resolves.toEqual({ outcome: "gone" });
    await expect(removeLinkPreviewBlock(db.prisma, scope)).resolves.toEqual({ outcome: "gone" });
    expect(db.blocksOf("m1")).toEqual([{ kind: "text", text: "x" }]);
  });
});
