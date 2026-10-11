import { ThreadItemSchema } from "@rakazo/contracts";
import type { RoutineLineRun } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { routineLine } from "./routine-line";

function run(fields: object, latest = true): RoutineLineRun {
  const item = ThreadItemSchema.parse({
    kind: "routine",
    id: "e_0",
    ts: "2026-10-10T09:00:00.000Z",
    runId: "run_digest",
    botId: "bot_ada",
    sessionId: "ses_digest",
    routineId: "rtn_digest",
    name: "Digest",
    finished: null,
    ...fields,
  });
  if (item.kind !== "routine") throw new Error("not a routine item");
  return { item, latest };
}

describe("a routine line", () => {
  it("is queued until its run leaves the queue, then running", () => {
    expect(routineLine(run({}), true).state).toBe("queued");
    expect(routineLine(run({}), false).state).toBe("running");
  });

  it("opens a subscribed latest run on its report, with the bell", () => {
    const finished = { status: "completed", result: "Three new invoices" };
    expect(routineLine(run({ notify: true, finished }), false)).toEqual({
      state: "completed",
      report: "Three new invoices",
      subscribed: true,
      opensOnItsOwn: true,
    });
    expect(routineLine(run({ finished }), false).opensOnItsOwn).toBe(false);
    expect(routineLine(run({ notify: true, finished }, false), false).opensOnItsOwn).toBe(false);
  });
});
