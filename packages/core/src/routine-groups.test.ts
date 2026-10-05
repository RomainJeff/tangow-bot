import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { RoutineGroupMessage } from "./routine-groups.js";
import { foldRoutineRuns } from "./routine-groups.js";

function run(
  id: string,
  name = "check-inbox",
  botId = "alfred",
  state = "completed",
): RoutineGroupMessage {
  return {
    id,
    role: "bot",
    botId,
    blocks: [{ kind: "routine_run", routineName: name, state } as MessageBlock],
  };
}

function handoff(id: string, botId = "alfred"): RoutineGroupMessage {
  return {
    id,
    role: "user",
    botId,
    blocks: [
      {
        kind: "bot_message_sent",
        toBotId: "claudius",
        toBotName: "Claudius",
      } as unknown as MessageBlock,
    ],
  };
}

function said(id: string, role: "user" | "bot" = "user"): RoutineGroupMessage {
  return { id, role, botId: "alfred", blocks: [{ kind: "text", text: "hi" } as MessageBlock] };
}

function roleKinds(roles: ReadonlyMap<string, { kind: string }>, ids: string[]) {
  return ids.map((id) => roles.get(id)?.kind ?? "-");
}

describe("foldRoutineRuns", () => {
  it("keeps a lone run on its own line with the message it sent", () => {
    const roles = foldRoutineRuns([run("r1"), handoff("h1")]);

    expect(roles.get("r1")).toMatchObject({
      kind: "run",
      run: { sentTo: { toBotName: "Claudius" }, latest: true },
    });
    expect(roles.get("h1")).toEqual({ kind: "hidden" });
  });

  it("folds the earlier runs of one routine and keeps the latest on its own line", () => {
    const roles = foldRoutineRuns([
      run("r1", "accor"),
      handoff("h1"),
      run("r2", "accor"),
      handoff("h2"),
      run("r3", "accor"),
      run("r4", "accor"),
    ]);

    expect(roleKinds(roles, ["r1", "r2", "r3", "r4"])).toEqual([
      "hidden",
      "hidden",
      "group",
      "run",
    ]);
    const group = roles.get("r3");
    expect(group?.kind === "group" && group.runs.map((item) => item.messageId)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(roles.get("r4")).toMatchObject({ run: { latest: true } });
  });

  it("never folds two different routines together", () => {
    const roles = foldRoutineRuns([
      run("r1", "accor"),
      run("r2", "accor"),
      run("r3", "accor"),
      run("r4", "marché"),
    ]);

    expect(roleKinds(roles, ["r1", "r2", "r3", "r4"])).toEqual(["hidden", "group", "run", "run"]);
  });

  it("does not fold a single earlier run", () => {
    const roles = foldRoutineRuns([run("r1"), run("r2")]);

    expect(roleKinds(roles, ["r1", "r2"])).toEqual(["run", "run"]);
    expect(roles.get("r1")).toMatchObject({ run: { latest: false } });
  });

  it("ends a sequence at a message from the person", () => {
    const roles = foldRoutineRuns([
      run("r1"),
      run("r2"),
      run("r3"),
      said("u1"),
      run("r4"),
      run("r5"),
      run("r6"),
    ]);

    expect(roleKinds(roles, ["r1", "r2", "r3", "u1", "r4", "r5", "r6"])).toEqual([
      "hidden",
      "group",
      "run",
      "-",
      "hidden",
      "group",
      "run",
    ]);
  });

  it("keeps a failed or running run in place and marks only the routine's last run", () => {
    const roles = foldRoutineRuns([
      run("r1", "accor", "alfred", "failed"),
      run("r2", "accor"),
      run("r3", "accor"),
      run("r4", "accor", "alfred", "failed"),
    ]);

    expect(roleKinds(roles, ["r1", "r2", "r3", "r4"])).toEqual(["run", "run", "run", "run"]);
    expect(roles.get("r1")).toMatchObject({ run: { latest: false } });
    expect(roles.get("r4")).toMatchObject({ run: { latest: true } });
  });

  it("does not take a handoff from another bot as this run's", () => {
    const roles = foldRoutineRuns([run("r1"), handoff("h1", "warren")]);

    expect(roles.get("r1")).toMatchObject({ kind: "run", run: { sentTo: undefined } });
    expect(roles.has("h1")).toBe(false);
  });

  // A2b: a failed (or running) run of the same routine cuts the sequence like
  // a message would — nothing folds across it, so it never moves and nothing
  // else reorders around it.
  it("cuts the sequence at a failed run instead of folding across it (A2b)", () => {
    const roles = foldRoutineRuns([
      run("r1", "accor"), // completed, before the failure
      run("r2", "accor", "alfred", "failed"),
      run("r3", "accor"), // completed, after the failure
      run("r4", "accor"), // completed, the routine's latest
    ]);

    // Nothing is hidden and nothing is grouped: each side of the failure has
    // only one quiet run, one short of the two a fold needs, so the failure
    // stays exactly where it happened instead of the thread reordering
    // around a group that would otherwise span both sides of it.
    expect(roleKinds(roles, ["r1", "r2", "r3", "r4"])).toEqual(["run", "run", "run", "run"]);
    expect(roles.get("r1")).toMatchObject({ run: { latest: false } });
    expect(roles.get("r2")).toMatchObject({ run: { latest: false } });
    expect(roles.get("r3")).toMatchObject({ run: { latest: false } });
    expect(roles.get("r4")).toMatchObject({ run: { latest: true } });
  });

  it("still folds a longer quiet run either side of a failure, each side on its own", () => {
    const roles = foldRoutineRuns([
      run("r1", "accor"),
      run("r2", "accor"),
      run("r3", "accor"), // 3 quiet runs before the failure: fold r1+r2, keep r3
      run("r4", "accor", "alfred", "failed"),
      run("r5", "accor"),
      run("r6", "accor"),
      run("r7", "accor"), // 3 quiet runs after: fold r5+r6, keep r7 (the routine's latest)
    ]);

    expect(roleKinds(roles, ["r1", "r2", "r3", "r4", "r5", "r6", "r7"])).toEqual([
      "hidden",
      "group",
      "run",
      "run",
      "hidden",
      "group",
      "run",
    ]);
    const before = roles.get("r2");
    expect(before?.kind === "group" && before.runs.map((item) => item.messageId)).toEqual([
      "r1",
      "r2",
    ]);
    const after = roles.get("r6");
    expect(after?.kind === "group" && after.runs.map((item) => item.messageId)).toEqual([
      "r5",
      "r6",
    ]);
    expect(roles.get("r7")).toMatchObject({ run: { latest: true } });
  });
});
