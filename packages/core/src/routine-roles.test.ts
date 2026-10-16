import type { ThreadItem } from "@rakazo/contracts";
import { ThreadItemSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { routineRoles } from "./routine-roles.js";

type Finished = { status: "completed" | "failed" | "cancelled"; result: string } | null;

function run(
  id: string,
  finished: Finished,
  routineId = "rtn_digest",
  ts = "2026-10-10T09:00:00.000Z",
): ThreadItem {
  return ThreadItemSchema.parse({
    kind: "routine",
    id,
    ts,
    runId: `run_${id}`,
    botId: "bot_ada",
    sessionId: `ses_${id}`,
    routineId,
    name: "Digest",
    finished,
  });
}

const failed = { status: "failed", result: "" } as const;
const said = (result: string) => ({ status: "completed", result }) as const;
const message: ThreadItem = {
  kind: "message",
  role: "bot",
  id: "msg",
  ts: "2026-10-10T09:00:00.000Z",
  botId: "bot_ada",
  runId: "run_reply",
  blocks: [{ kind: "text", text: "Hello" }],
} as ThreadItem;

function kinds(items: ThreadItem[]) {
  const { roles, hidden } = routineRoles(items);
  return items.map((item) => {
    const role = roles.get(item.id);
    if (role?.kind === "failures") return `failures:${[...role.folded, item.id].join(",")}`;
    return role?.kind ?? (hidden.has(item.id) ? "hidden" : "-");
  });
}

describe("routineRoles", () => {
  it("shows a run with words as its trimmed text, and hides silent, unfinished and cancelled runs", () => {
    const items = [
      run("a", said("  Invoice due Thursday.\n")),
      run("b", said(" \n ")),
      run("c", null),
      run("d", { status: "cancelled", result: "Half done" }),
    ];
    expect(routineRoles(items).roles.get("a")).toEqual({
      kind: "message",
      text: "Invoice due Thursday.",
    });
    expect(kinds(items)).toEqual(["message", "hidden", "hidden", "hidden"]);
  });

  it("folds consecutive failures of one routine onto the newest, across hidden runs", () => {
    const items = [
      run("a", failed, "rtn_digest", "2026-10-10T07:00:00.000Z"),
      run("b", failed),
      run("q", said("")),
      run("c", failed),
    ];
    expect(kinds(items)).toEqual(["hidden", "hidden", "hidden", "failures:a,b,c"]);
    expect(routineRoles(items).roles.get("c")).toEqual({
      kind: "failures",
      count: 3,
      since: "2026-10-10T07:00:00.000Z",
      folded: ["a", "b"],
    });
  });

  it("breaks the fold at anything shown between failures", () => {
    expect(kinds([run("a", failed), run("m", said("All fine")), run("b", failed)])).toEqual([
      "failures:a",
      "message",
      "failures:b",
    ]);
    expect(kinds([run("a", failed), message, run("b", failed)])).toEqual([
      "failures:a",
      "-",
      "failures:b",
    ]);
  });

  it("never folds two routines together", () => {
    const items = [run("a", failed), run("b", failed, "rtn_other"), run("c", failed)];
    expect(kinds(items)).toEqual(["failures:a", "failures:b", "failures:c"]);
  });
});
