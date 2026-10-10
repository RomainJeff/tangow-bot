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
    expect(await skillPageView({ skillUid: uid, change: "learned" }, catalog)).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:espresso" },
    });
    expect(await skillPageView({ skillUid: uid, change: "updated" }, catalog)).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:espresso" },
    });
  });

  it("opens the Knowledge list when the catalog no longer has the skill", async () => {
    expect(await skillPageView({ skillUid: "a".repeat(32), change: "learned" }, catalog)).toEqual({
      tab: "knowledge",
      detail: null,
    });
  });

  it("opens Recently deleted for a deleted skill without looking it up", async () => {
    let looked = false;
    const view = await skillPageView({ skillUid: uid, change: "deleted" }, async () => {
      looked = true;
      return catalog();
    });
    expect({ view, looked }).toEqual({
      view: { tab: "knowledge", detail: null, trash: true },
      looked: false,
    });
  });
});
