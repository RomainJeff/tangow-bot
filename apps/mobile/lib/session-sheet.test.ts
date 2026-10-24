import { SessionEntrySchema } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { isViewedRunLine, originSession } from "./session-sheet";

const usage = { inputTokens: 1, outputTokens: 1 };

const runEntries = (outcome: Record<string, unknown>) =>
  [
    {
      sessionId: "ses_main",
      type: "routine.started",
      payload: {
        sessionId: "ses_digest",
        routineId: "rtn_digest",
        name: "Digest",
        trigger: "routine",
        scheduledAt: "2026-10-10T09:00:00.000Z",
        model: { provider: "local", id: "emulator-1" },
      },
    },
    {
      sessionId: "ses_digest",
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: "Three new invoices" }] },
    },
    { sessionId: "ses_main", type: "routine.finished", payload: { usage, ...outcome } },
  ].map((entry, seq) =>
    SessionEntrySchema.parse({
      id: `e_${seq}`,
      seq,
      parentId: seq === 0 ? null : `e_${seq - 1}`,
      ts: `2026-10-10T09:00:0${seq}.000Z`,
      botId: "bot_ada",
      runId: "run_digest",
      ...entry,
    }),
  );

const said = { status: "completed", result: "Three new invoices" };
const failed = { status: "failed", result: "", error: "boom" };

const roles = (outcome: Record<string, unknown>, viewedRunId: string) =>
  projectThreadView(runEntries(outcome), {
    rendersNothing: (item) => isViewedRunLine(item, viewedRunId),
  }).rows.map((row) => row.routine?.kind ?? row.item.kind);

describe("a session sheet", () => {
  it.each([
    [said, "message"],
    [failed, "failures"],
  ])("leaves out the row of the routine run it shows, and keeps another run's", (outcome, role) => {
    expect(roles(outcome, "run_digest")).toEqual(["message"]);
    expect(roles(outcome, "run_other")).toEqual([role, "message"]);
  });

  it("names the routine an item rose from and opens that routine's session", () => {
    const risen = SessionEntrySchema.parse({
      id: "e_1",
      seq: 1,
      parentId: "e_0",
      ts: "2026-10-10T09:00:01.000Z",
      sessionId: "ses_main",
      botId: "bot_ada",
      runId: "run_digest",
      type: "assistant.ask",
      payload: { originSessionId: "ses_digest", block: { kind: "ask", text: "Pay them?" } },
    });
    const rows = projectThreadView([runEntries(said)[0]!, risen]).rows;
    expect(rows.map((row) => originSession(row.item))).toEqual([
      { sessionId: "ses_digest", title: "Digest" },
    ]);
  });

  it("gives no label to an item that rose from the bot's own run session", () => {
    const risen = SessionEntrySchema.parse({
      id: "e_0",
      seq: 0,
      parentId: null,
      ts: "2026-10-10T09:00:00.000Z",
      sessionId: "ses_main",
      botId: "bot_ada",
      runId: "run_reply",
      type: "assistant.ask",
      payload: { originSessionId: "ses_reply", block: { kind: "ask", text: "Sell or hold?" } },
    });
    const rows = projectThreadView([risen]).rows;
    expect(rows.map((row) => originSession(row.item))).toEqual([null]);
  });
});
