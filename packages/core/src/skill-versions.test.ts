import type { SkillVersion } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { canUndoSkillVersion, showsSkillVersions, skillVersionSubline } from "./skill-versions.js";

const bot = { kind: "bot", botId: "bot-1", botName: "Scout" } as const;
const user = { kind: "user" } as const;

function version(id: number, patch: Partial<SkillVersion> = {}): SkillVersion {
  return {
    versionId: `v${String(id).padStart(6, "0")}-0123abcd`,
    createdAt: "2026-10-07T18:40:00.000Z",
    author: bot,
    nature: "modified",
    current: false,
    undone: false,
    ...patch,
  };
}

const words = {
  learned: "learned",
  updated: "updated",
  you: "You",
  unknown: "Updated",
  undone: "Undone",
};

describe("showsSkillVersions", () => {
  it("hides the history of a lone version the user or an unknown author wrote", () => {
    expect(showsSkillVersions([version(1, { author: user })])).toBe(false);
    expect(showsSkillVersions([version(1, { author: { kind: "unknown" } })])).toBe(false);
    expect(showsSkillVersions([])).toBe(false);
  });

  it("shows a lone bot version and any longer history", () => {
    expect(showsSkillVersions([version(1)])).toBe(true);
    expect(showsSkillVersions([version(2, { author: user }), version(1, { author: user })])).toBe(
      true,
    );
  });
});

describe("canUndoSkillVersion", () => {
  it("offers Undo with an older live version below the current one", () => {
    expect(canUndoSkillVersion([version(2, { current: true }), version(1)])).toBe(true);
  });

  it("looks below the current version past the ones already undone", () => {
    expect(
      canUndoSkillVersion([
        version(4, { undone: true }),
        version(3, { current: true }),
        version(2, { undone: true }),
        version(1),
      ]),
    ).toBe(true);
    expect(canUndoSkillVersion([version(2, { current: true }), version(1, { undone: true })])).toBe(
      false,
    );
  });

  it("offers Undo on a bot's creation, which removes the skill", () => {
    expect(canUndoSkillVersion([version(1, { current: true, nature: "created" })])).toBe(true);
  });

  it("refuses it on a lone version that is not a bot's creation", () => {
    expect(canUndoSkillVersion([version(1, { current: true })])).toBe(false);
    expect(
      canUndoSkillVersion([version(1, { current: true, nature: "created", author: user })]),
    ).toBe(false);
  });

  it("refuses it when no version is current", () => {
    expect(canUndoSkillVersion([version(2), version(1)])).toBe(false);
  });
});

describe("skillVersionSubline", () => {
  it("names the bot and what it did", () => {
    expect(skillVersionSubline(version(1, { nature: "created" }), words)).toBe("Scout · learned");
    expect(skillVersionSubline(version(2), words)).toBe("Scout · updated");
  });

  it("says You for the user and only Updated when the author is unknown", () => {
    expect(skillVersionSubline(version(1, { author: user }), words)).toBe("You · updated");
    expect(
      skillVersionSubline(version(1, { author: { kind: "unknown" }, nature: "created" }), words),
    ).toBe("Updated");
  });

  it("marks an undone version", () => {
    expect(skillVersionSubline(version(2, { undone: true }), words)).toBe(
      "Scout · updated · Undone",
    );
  });
});
