import { describe, expect, it } from "vitest";
import { headerMenuItems, type MenuAction, splitMenuActions } from "./native-menu";

const press = () => {};
const clear: MenuAction = { label: "Clear", onPress: press, destructive: true };
const archive: MenuAction = { label: "Archive", onPress: press };
const open: MenuAction = { label: "Open", onPress: press };
const remove: MenuAction = { label: "Delete", onPress: press, destructive: true };

describe("splitMenuActions", () => {
  it("keeps each group in its original order", () => {
    expect(splitMenuActions([clear, archive, remove, open])).toEqual({
      regular: [archive, open],
      destructive: [clear, remove],
    });
  });
});

describe("headerMenuItems", () => {
  it("puts destructive actions last in an inline submenu", () => {
    expect(headerMenuItems([clear, archive, open])).toEqual([
      { type: "action", label: "Archive", onPress: press },
      { type: "action", label: "Open", onPress: press },
      {
        type: "submenu",
        label: "",
        inline: true,
        items: [{ type: "action", label: "Clear", onPress: press, destructive: true }],
      },
    ]);
  });

  it("stays flat when every action is destructive", () => {
    expect(headerMenuItems([remove])).toEqual([
      { type: "action", label: "Delete", onPress: press, destructive: true },
    ]);
  });

  it("stays flat when no action is destructive", () => {
    expect(headerMenuItems([archive, open])).toEqual([
      { type: "action", label: "Archive", onPress: press },
      { type: "action", label: "Open", onPress: press },
    ]);
  });
});
