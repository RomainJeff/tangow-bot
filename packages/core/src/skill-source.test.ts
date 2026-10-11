import { MessageBlocks } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { skillSourcesOf } from "./skill-source.js";

const uid = "0123456789abcdef0123456789abcdef";

describe("skillSourcesOf", () => {
  it("reads every skill line of a stored message and drops a malformed one", () => {
    const blocks = MessageBlocks.parse([
      { kind: "text", text: "Done." },
      {
        kind: "skill_source",
        skillUid: uid,
        skillId: "user:coffee",
        name: "Coffee",
        change: "learned",
      },
      {
        kind: "skill_source",
        skillUid: "not-a-uid",
        skillId: "user:x",
        name: "X",
        change: "learned",
      },
      {
        kind: "skill_source",
        skillUid: uid.replace("0", "f"),
        skillId: "user:tea",
        name: "Tea",
        change: "deleted",
      },
    ]);
    expect(skillSourcesOf(blocks).map(({ name, change }) => `${change} ${name}`)).toEqual([
      "learned Coffee",
      "deleted Tea",
    ]);
  });
});
