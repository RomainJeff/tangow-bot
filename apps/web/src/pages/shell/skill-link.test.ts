import { describe, expect, it } from "vitest";
import { skillPageView } from "./skill-link";

const catalog = async () => [{ id: "builtin:Routines" }, { id: "user:tea" }];

describe("skillPageView", () => {
  it("opens the skill by its id, never a built-in skill", async () => {
    expect(await skillPageView({ skillId: "user:tea" }, catalog)).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:tea" },
    });
  });

  it("opens a line stored with a uid by its id too", async () => {
    const stored = { skillUid: "0123456789abcdef0123456789abcdef", skillId: "user:tea" };
    expect(await skillPageView(stored, catalog)).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:tea" },
    });
  });

  it("opens the Knowledge list when the catalog no longer has the skill", async () => {
    expect(await skillPageView({ skillId: "user:x" }, catalog)).toEqual({
      tab: "knowledge",
      detail: null,
    });
  });
});
