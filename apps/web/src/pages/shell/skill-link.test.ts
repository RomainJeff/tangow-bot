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
    expect(
      await skillPageView({ skillUid: uid, skillId: "user:coffee", change: "learned" }, catalog),
    ).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:espresso" },
    });
    expect(
      await skillPageView({ skillUid: uid, skillId: "user:coffee", change: "updated" }, catalog),
    ).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:espresso" },
    });
  });

  it("opens a line written without a uid by its id, never a built-in skill", async () => {
    expect(await skillPageView({ skillId: "user:tea", change: "updated" }, catalog)).toEqual({
      tab: "knowledge",
      detail: { kind: "skill", skillId: "user:tea" },
    });
  });

  it("opens the Knowledge list when the catalog no longer has the skill", async () => {
    expect(
      await skillPageView(
        { skillUid: "a".repeat(32), skillId: "user:x", change: "learned" },
        catalog,
      ),
    ).toEqual({
      tab: "knowledge",
      detail: null,
    });
  });

  it("opens Recently deleted for a deleted skill without looking it up", async () => {
    let looked = false;
    const view = await skillPageView(
      { skillUid: uid, skillId: "user:espresso", change: "deleted" },
      async () => {
        looked = true;
        return catalog();
      },
    );
    expect({ view, looked }).toEqual({
      view: { tab: "knowledge", detail: null, trash: true },
      looked: false,
    });
  });
});
