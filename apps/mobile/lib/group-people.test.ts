import { SessionEntrySchema } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { otherPeoplesRunIds, splitRowsByPerson } from "./group-people.js";

/** A group thread's chain, one entry a second, each entry given as its type, payload and run. */
function chain(entries: Array<Record<string, unknown>>) {
  return entries.map((entry, seq) =>
    SessionEntrySchema.parse({
      id: `e_${seq}`,
      seq,
      parentId: seq === 0 ? null : `e_${seq - 1}`,
      ts: `2026-11-11T09:00:0${seq}.000Z`,
      sessionId: "ses_group",
      ...entry,
    }),
  );
}

const said = (text: string, authorId?: string) => ({
  type: "user.message",
  payload: { blocks: [{ kind: "text", text }], source: "app", ...(authorId ? { authorId } : {}) },
});

describe("splitRowsByPerson", () => {
  it("starts a new group where another person writes, its creator writing without an author", () => {
    const view = projectThreadView(
      chain([said("Plan the launch"), said("I can take the post", "ben"), said("Tuesday?", "ben")]),
    );
    const rows = splitRowsByPerson(view.rows, "ada");
    expect(rows.map((row) => [row.firstOfGroup, row.lastOfGroup])).toEqual([
      [true, true],
      [true, false],
      [false, true],
    ]);
  });
});

const started = (runId: string, botId: string, trigger: Record<string, unknown>) => ({
  type: "run.started",
  runId,
  botId,
  payload: { trigger, model: { provider: "emulator", id: "emulator-1" }, effort: null },
});

describe("otherPeoplesRunIds", () => {
  it("leaves a run to the person whose message woke it, through handoffs and retries", () => {
    const entries = chain([
      said("Draft the launch post", "ben"),
      started("run_ben", "bot_writer", { kind: "message", entryId: "e_0" }),
      {
        type: "handoff",
        runId: "run_ben",
        botId: "bot_writer",
        payload: { fromBotId: "bot_writer", toBotId: "bot_editor", text: "Polish it", hop: 1 },
      },
      started("run_handed", "bot_editor", { kind: "handoff", entryId: "e_2" }),
      started("run_retried", "bot_editor", {
        kind: "retry",
        attempt: 1,
        previousRunId: "run_handed",
        reason: "timeout",
      }),
      said("And the newsletter"),
      started("run_ada", "bot_writer", { kind: "message", entryId: "e_5" }),
    ]);
    expect([...otherPeoplesRunIds(entries, "ada", "ada")].sort()).toEqual([
      "run_ben",
      "run_handed",
      "run_retried",
    ]);
    expect([...otherPeoplesRunIds(entries, "ben", "ada")]).toEqual(["run_ada"]);
  });
});
