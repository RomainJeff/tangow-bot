import { describe, expect, it } from "vitest";
import { skillPageView } from "./skill-link";

const uid = "0123456789abcdef0123456789abcdef";
const catalog = async () => [
  { id: "builtin:Routines" },
  { id: "user:espresso", uid },
  { id: "user:tea", uid: "f".repeat(32) },
];

describe("skillPageView", () => {
  it("opens the skill under the name it has now", async () => {
    expect(await skillPageView({ skillUid: uid, skillId: "user:coffee" }, catalog)).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:espresso" },
    });
  });

  it("opens a line written without a uid by its id, never a built-in skill", async () => {
    expect(await skillPageView({ skillId: "user:tea" }, catalog)).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:tea" },
    });
  });

  it("opens the Knowledge list when the catalog no longer has the skill", async () => {
    expect(await skillPageView({ skillUid: "a".repeat(32), skillId: "user:x" }, catalog)).toEqual({
      tab: "knowledge",
      detail: null,
    });
  });
});
