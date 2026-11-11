import { SessionEntrySchema } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { splitRowsByPerson } from "./group-people.js";

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
