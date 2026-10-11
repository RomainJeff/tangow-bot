import { SessionEntrySchema } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { isViewedRunLine } from "./session-sheet";

const entries = [
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

const kinds = (viewedRunId: string | undefined) =>
  projectThreadView(entries, {
    rendersNothing: (item) => isViewedRunLine(item, viewedRunId),
  }).rows.map((row) => row.item.kind);

describe("a session sheet", () => {
  it("leaves out the line of the routine run it shows, and keeps another run's", () => {
    expect(kinds("run_digest")).toEqual(["message"]);
    expect(kinds("run_other")).toEqual(["routine", "message"]);
  });
});
