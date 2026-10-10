import type { SkillVersion } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { serverError } from "./server-error";
import {
  canUndo,
  markRestored,
  showsVersions,
  skillIdForUid,
  takeRestored,
  undoOutcome,
  versionSubline,
} from "./skill-versions";

const bot = { kind: "bot", botId: "b1", botName: "Claudius" } as const;
const version = (patch: Partial<SkillVersion> = {}): SkillVersion => ({
  versionId: "v000001-aaaaaaaa",
  createdAt: "2026-10-10T12:00:00.000Z",
  author: { kind: "user" },
  nature: "modified",
  current: false,
  undone: false,
  ...patch,
});
const words = {
  learned: "learned",
  updated: "updated",
  you: "You",
  undone: "Undone",
  unknown: "Updated",
};

describe("showsVersions", () => {
  it("hides the history of a skill with one version the user wrote", () => {
    expect(showsVersions([version({ current: true })])).toBe(false);
    expect(showsVersions([])).toBe(false);
  });

  it("shows it for a lone version a bot wrote, or for two versions", () => {
    expect(showsVersions([version({ author: bot, nature: "created", current: true })])).toBe(true);
    expect(showsVersions([version({ current: true }), version()])).toBe(true);
  });
});

describe("canUndo", () => {
  it("offers Undo when an earlier version is kept", () => {
    expect(canUndo([version({ current: true }), version()])).toBe(true);
  });

  it("skips versions already undone when looking for the earlier one", () => {
    expect(canUndo([version({ current: true }), version({ undone: true })])).toBe(false);
  });

  it("offers Undo on a bot's lone creation, not on a lone user version", () => {
    expect(canUndo([version({ author: bot, nature: "created", current: true })])).toBe(true);
    expect(canUndo([version({ current: true })])).toBe(false);
    expect(canUndo([version({ author: bot, nature: "modified", current: true })])).toBe(false);
  });
});

describe("versionSubline", () => {
  it("names the bot and what it did", () => {
    expect(versionSubline(version({ author: bot, nature: "created" }), words)).toBe(
      "Claudius · learned",
    );
    expect(versionSubline(version({ author: bot }), words)).toBe("Claudius · updated");
  });

  it("says You for the owner and marks an undone version", () => {
    expect(versionSubline(version(), words)).toBe("You · updated");
    expect(versionSubline(version({ undone: true }), words)).toBe("You · updated · Undone");
  });

  it("reads an unknown author as Updated, whatever the nature, as on web", () => {
    expect(versionSubline(version({ author: { kind: "unknown" } }), words)).toBe("Updated");
    expect(versionSubline(version({ author: { kind: "unknown" }, nature: "created" }), words)).toBe(
      "Updated",
    );
  });
});

describe("undoOutcome", () => {
  it("returns the id the skill has after the undo", async () => {
    expect(
      await undoOutcome(async () => ({ kind: "restored", skillId: "user:old", name: "Old" })),
    ).toEqual({ kind: "restored", skillId: "user:old" });
  });

  it("reports a creation undone as trashed", async () => {
    expect(await undoOutcome(async () => ({ kind: "trashed" }))).toEqual({ kind: "trashed" });
  });

  it("carries the server's sentence when the skill changed meanwhile", async () => {
    const message = "This skill changed. Reload and try again.";
    expect(
      await undoOutcome(async () => {
        throw serverError(message);
      }),
    ).toEqual({ kind: "refused", message });
  });

  it("has no sentence when the call never got an answer", async () => {
    expect(
      await undoOutcome(async () => {
        throw new Error("Network request failed");
      }),
    ).toEqual({ kind: "refused", message: "" });
  });
});

describe("skillIdForUid", () => {
  const entries = [
    { id: "user:retro", uid: "a".repeat(32) },
    { id: "user:standup", uid: "b".repeat(32) },
  ];

  it("gives the id of the entry carrying the uid", () => {
    expect(skillIdForUid(entries, "b".repeat(32), (entry) => entry.uid)).toBe("user:standup");
  });

  it("finds nothing for an unknown uid", () => {
    expect(skillIdForUid(entries, "c".repeat(32), (entry) => entry.uid)).toBeNull();
  });
});

describe("restored skill hand-off", () => {
  it("is read once by the group that shows the skill again", () => {
    markRestored({ skillId: "user:retro", botGone: true });
    expect(takeRestored()).toEqual({ skillId: "user:retro", botGone: true });
    expect(takeRestored()).toBeNull();
  });
});
