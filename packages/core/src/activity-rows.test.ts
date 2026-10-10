import type { BotActivityItem, MessageBlock, RunActivityRow } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { ActivityRead } from "./activity-rows.js";
import { dayMarkers, foldActivity, recapView, reduceActivity, runRecap } from "./activity-rows.js";

function row(id: string, overrides: Partial<RunActivityRow> = {}): RunActivityRow {
  return {
    runId: id,
    botId: "bot_1",
    botName: "Scout",
    groupId: null,
    groupName: null,
    threadId: "thread_1",
    status: "completed",
    trigger: "routine",
    notificationsEnabled: false,
    promptSnippet: "",
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
    routineId: "routine_1",
    routineName: "Morning digest",
    sourceMessageId: null,
    startedAt: null,
    completedAt: "2026-10-06T10:00:00.000Z",
    failureKind: null,
    ...overrides,
  };
}

const run = (id: string, overrides: Partial<RunActivityRow> = {}): BotActivityItem => ({
  kind: "routine_run",
  run: row(id, overrides),
});

const routineCreated = (
  routineId: string,
  createdAt: string,
  byBotName: string | null = null,
): BotActivityItem => ({
  kind: "routine_created",
  routineId,
  routineName: "Morning digest",
  createdAt,
  byBotName,
});

const botCreated = (createdAt: string): BotActivityItem => ({
  kind: "bot_created",
  botId: "bot_1",
  botName: "Scout",
  createdAt,
});

const shape = (items: ReturnType<typeof foldActivity>) =>
  items.map((item) =>
    item.kind === "run"
      ? item.row.runId
      : item.kind === "folded"
        ? `folded:${item.runs.map((r) => r.runId).join("+")}`
        : item.kind,
  );

describe("foldActivity", () => {
  it("folds three consecutive successes of one routine into one item, newest first", () => {
    const entries = [run("a"), run("b"), run("c")];
    expect(foldActivity(entries)).toEqual([
      {
        kind: "folded",
        routineId: "routine_1",
        name: "Morning digest",
        runs: [row("a"), row("b"), row("c")],
      },
    ]);
  });

  it("lists every run on its own when folding is off, as on a routine's page", () => {
    const entries = [run("a"), run("b"), run("c")];
    expect(foldActivity(entries, { fold: false })).toEqual([
      { kind: "run", row: row("a") },
      { kind: "run", row: row("b") },
      { kind: "run", row: row("c") },
    ]);
  });

  it("keeps a single success as a plain run", () => {
    expect(foldActivity([run("a")])).toEqual([{ kind: "run", row: row("a") }]);
  });

  it("never folds a failure and lets it cut the sequence", () => {
    const failed = run("failed", { status: "failed", failureKind: "provider" });
    expect(shape(foldActivity([run("a"), run("b"), failed, run("c"), run("d")]))).toEqual([
      "folded:a+b",
      "failed",
      "folded:c+d",
    ]);
    expect(shape(foldActivity([run("a"), failed, run("b")]))).toEqual(["a", "failed", "b"]);
  });

  it("never folds cancelled or active runs", () => {
    const entries = [
      run("a", { status: "cancelled" }),
      run("b", { status: "cancelled" }),
      run("c", { status: "running" }),
      run("d", { status: "running" }),
    ];
    expect(shape(foldActivity(entries))).toEqual(["c", "d", "a", "b"]);
  });

  it("puts active runs first and keeps the order of everything else", () => {
    const entries = [
      run("done-1"),
      run("running", { status: "running" }),
      routineCreated("routine_1", "2026-10-05T09:00:00.000Z"),
      run("waiting", { status: "waiting_input" }),
      botCreated("2026-10-01T09:00:00.000Z"),
    ];
    expect(shape(foldActivity(entries))).toEqual([
      "running",
      "waiting",
      "done-1",
      "routine_created",
      "bot_created",
    ]);
  });

  it("does not fold across two routines or a creation in between", () => {
    const entries = [
      run("a"),
      run("b", { routineId: "routine_2", routineName: "Weekly review" }),
      run("c"),
      routineCreated("routine_2", "2026-10-05T09:00:00.000Z"),
      run("d"),
    ];
    expect(shape(foldActivity(entries))).toEqual(["a", "b", "c", "routine_created", "d"]);
  });

  it("does not fold successes whose routine was deleted", () => {
    const entries = [run("a", { routineId: null }), run("b", { routineId: null })];
    expect(shape(foldActivity(entries))).toEqual(["a", "b"]);
  });

  it("returns an empty list for no entries", () => {
    expect(foldActivity([])).toEqual([]);
  });
});

describe("dayMarkers", () => {
  const at = (id: string, completedAt: string, overrides: Partial<RunActivityRow> = {}) =>
    run(id, {
      completedAt,
      createdAt: completedAt,
      updatedAt: completedAt,
      routineId: null,
      ...overrides,
    });

  it("groups items by the day they were created in the given zone, with the time it read", () => {
    const items = foldActivity([
      at("late", "2026-10-06T23:30:00.000Z"),
      at("early", "2026-10-06T03:00:00.000Z"),
      at("older", "2026-10-05T12:00:00.000Z"),
    ]);
    expect(
      dayMarkers(items, "UTC").map((group) => [group.day, group.at, group.items.length]),
    ).toEqual([
      ["2026-10-06", "2026-10-06T23:30:00.000Z", 2],
      ["2026-10-05", "2026-10-05T12:00:00.000Z", 1],
    ]);
    expect(
      dayMarkers(items, "Pacific/Auckland").map((group) => [group.day, group.items.length]),
    ).toEqual([
      ["2026-10-07", 1],
      ["2026-10-06", 2],
    ]);
  });

  it("files creations under the day they were made", () => {
    const items = foldActivity([
      at("run", "2026-10-06T09:00:00.000Z"),
      routineCreated("routine_1", "2026-10-04T09:00:00.000Z", "Scout"),
      botCreated("2026-10-04T08:00:00.000Z"),
    ]);
    expect(dayMarkers(items, "UTC").map((group) => [group.day, group.items.length])).toEqual([
      ["2026-10-06", 1],
      ["2026-10-04", 2],
    ]);
  });

  it("leads with active runs under a null day", () => {
    const items = foldActivity([
      at("done", "2026-10-06T09:00:00.000Z"),
      at("live", "2026-10-04T09:00:00.000Z", { status: "running", completedAt: null }),
    ]);
    expect(dayMarkers(items, "UTC").map((group) => group.day)).toEqual([null, "2026-10-06"]);
  });

  it("groups by creation day, as the server sorts, whenever a run started or finished", () => {
    const items = foldActivity([
      at("overnight", "2026-10-10T00:20:00.000Z", {
        createdAt: "2026-10-09T23:20:00.000Z",
        startedAt: "2026-10-10T00:05:00.000Z",
      }),
      routineCreated("routine_2", "2026-10-09T23:30:00.000Z"),
    ]);
    expect(
      dayMarkers(items, "UTC").map((group) => [group.day, group.items.map((item) => item.kind)]),
    ).toEqual([["2026-10-09", ["run", "routine_created"]]]);
  });

  it("places a folded item under the day of its newest run", () => {
    const items = foldActivity([
      at("a", "2026-10-06T08:00:00.000Z", { routineId: "r" }),
      at("b", "2026-10-05T08:00:00.000Z", { routineId: "r" }),
    ]);
    expect(dayMarkers(items, "UTC")).toEqual([
      { day: "2026-10-06", at: "2026-10-06T08:00:00.000Z", items },
    ]);
  });

  it("returns no groups for no items", () => {
    expect(dayMarkers([], "UTC")).toEqual([]);
  });
});

describe("reduceActivity", () => {
  const cursor = { createdAt: "2026-10-05T08:00:00.000Z", id: "run-2" };
  const keys = (read: ActivityRead) =>
    read.kind === "ready"
      ? read.entries.map((entry) => (entry.kind === "routine_run" ? entry.run.runId : entry.kind))
      : read.kind;

  it("adds earlier pages after the first, each entry once", () => {
    let read: ActivityRead = { kind: "loading" };
    read = reduceActivity(read, {
      type: "first",
      page: { items: [run("a"), run("b")], nextCursor: cursor },
    });
    read = reduceActivity(read, { type: "earlier-started" });
    expect(read.kind === "ready" && read.earlier).toBe("loading");
    read = reduceActivity(read, {
      type: "earlier",
      page: { items: [run("b"), botCreated("2026-10-01T08:00:00.000Z")], nextCursor: null },
    });
    expect(read).toMatchObject({ kind: "ready", next: null, pages: 2, earlier: "idle" });
    expect(keys(read)).toEqual(["a", "b", "bot_created"]);
  });

  it("keeps the earlier pages when a refresh reads the first page again", () => {
    const ready: ActivityRead = {
      kind: "ready",
      entries: [run("b"), run("c")],
      next: null,
      pages: 2,
      earlier: "idle",
    };
    const read = reduceActivity(ready, {
      type: "first",
      page: { items: [run("a"), run("b")], nextCursor: cursor },
    });
    expect(keys(read)).toEqual(["a", "b", "c"]);
  });

  it("starts again from the fresh first page when a held active run is no longer active", () => {
    const ready: ActivityRead = {
      kind: "ready",
      entries: [run("old-wait", { status: "waiting_input" }), run("b"), run("c")],
      next: cursor,
      pages: 2,
      earlier: "idle",
    };
    const read = reduceActivity(ready, {
      type: "first",
      page: { items: [run("a"), run("b")], nextCursor: cursor },
    });
    expect(read).toMatchObject({ kind: "ready", pages: 1, next: cursor });
    expect(keys(read)).toEqual(["a", "b"]);
  });

  it("lets an earlier page's copy of a run replace the one already held", () => {
    const ready: ActivityRead = {
      kind: "ready",
      entries: [run("a"), run("live", { status: "running" })],
      next: cursor,
      pages: 1,
      earlier: "loading",
    };
    const read = reduceActivity(ready, {
      type: "earlier",
      page: { items: [run("live"), run("z")], nextCursor: null },
    });
    expect(keys(read)).toEqual(["a", "live", "z"]);
    expect(
      read.kind === "ready" &&
        read.entries.map((entry) => entry.kind === "routine_run" && entry.run.status),
    ).toEqual(["completed", "completed", "completed"]);
  });

  it("shows a failed first read, but keeps known entries when only a refresh fails", () => {
    expect(reduceActivity({ kind: "loading" }, { type: "first-failed" })).toEqual({
      kind: "failed",
    });
    const ready: ActivityRead = {
      kind: "ready",
      entries: [run("a")],
      next: cursor,
      pages: 1,
      earlier: "idle",
    };
    expect(reduceActivity(ready, { type: "first-failed" })).toBe(ready);
    expect(reduceActivity(ready, { type: "earlier-failed" })).toMatchObject({ earlier: "failed" });
  });
});

describe("runRecap", () => {
  const message = (id: string, blocks: MessageBlock[]) => ({ id, blocks });

  it("joins the text the run posted and opens at its first message that says something", () => {
    expect(
      runRecap([
        message("m1", [{ kind: "steps", steps: [] } as unknown as MessageBlock]),
        message("m2", [{ kind: "text", text: "  **3 new invoices**  " }]),
        message("m3", [
          { kind: "text", text: "Paid: 2" },
          { kind: "text", text: "Late: 1" },
        ]),
      ]),
    ).toEqual({ text: "**3 new invoices**\n\nPaid: 2\n\nLate: 1", messageId: "m2" });
  });

  it("reads a routine card's report, or its headline without one", () => {
    const card = (extra: object): MessageBlock =>
      ({
        kind: "routine_run",
        routineName: "Digest",
        state: "completed",
        ...extra,
      }) as MessageBlock;
    expect(runRecap([message("c1", [card({ digest: "Full report", headline: "Full" })])])).toEqual({
      text: "Full report",
      messageId: "c1",
    });
    expect(runRecap([message("c2", [card({ headline: "All quiet" })])])).toEqual({
      text: "All quiet",
      messageId: "c2",
    });
  });

  it("never returns a failed routine card's raw error as a recap", () => {
    const failed = {
      kind: "routine_run",
      routineName: "Digest",
      state: "failed",
      digest: "Error: Connect that model provider first",
    } as MessageBlock;
    expect(runRecap([message("c1", [failed])])).toEqual({ text: null, messageId: "c1" });
  });

  it("has no text when the run said nothing, and still points at its first message", () => {
    expect(runRecap([message("m1", [{ kind: "text", text: "   " }])])).toEqual({
      text: null,
      messageId: "m1",
    });
    expect(runRecap([])).toEqual({ text: null, messageId: null });
  });
});

describe("recapView", () => {
  const ready = (text: string | null, messageId: string | null = "m-1") =>
    ({ kind: "ready", recap: { text, messageId } }) as const;

  it("shows what a run wrote, failed or not, and opens the chat at that message", () => {
    expect(
      recapView(ready("Checked 3 folders."), { failed: true, sourceMessageId: "s-1" }),
    ).toEqual({ body: { kind: "text", text: "Checked 3 folders." }, jumpTo: "m-1" });
  });

  it("says No report only for a run that did not fail", () => {
    expect(recapView(ready(null, null), { failed: false, sourceMessageId: null })).toEqual({
      body: { kind: "no_report" },
      jumpTo: null,
    });
    expect(recapView(ready(null, null), { failed: true, sourceMessageId: "s-1" })).toEqual({
      body: { kind: "none" },
      jumpTo: "s-1",
    });
  });

  it("opens the chat where the run began while the recap is loading or could not be read", () => {
    for (const read of [null, { kind: "loading" } as const, { kind: "failed" } as const]) {
      expect(recapView(read, { failed: true, sourceMessageId: "s-1" }).jumpTo).toBe("s-1");
    }
    expect(recapView({ kind: "failed" }, { failed: false, sourceMessageId: null }).body).toEqual({
      kind: "failed",
    });
  });
});
