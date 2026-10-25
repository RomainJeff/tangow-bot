import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { presentAndroidActionSheet } from "./android-action-sheet";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

function sheet() {
  const actions = ["Reply", "React", "Speak", "Copy"].map((text) => ({ text, onPress: vi.fn() }));
  presentAndroidActionSheet({ actions, title: "12:34", cancel: "Cancel", more: "More" });
  return actions;
}

describe("android action sheet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps all actions reachable within the three-button limit", () => {
    const actions = sheet();
    const [title, , firstPage, options] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(title).toBe("12:34");
    expect(options).toEqual({ cancelable: true });
    expect(firstPage?.map((button) => button.text)).toEqual(["Reply", "React", "More"]);
    firstPage?.[0]?.onPress?.();
    firstPage?.[1]?.onPress?.();
    firstPage?.[2]?.onPress?.();
    const [, , secondPage, secondOptions] = vi.mocked(Alert.alert).mock.calls[1]!;
    expect(secondPage?.map((button) => button.text)).toEqual(["Speak", "Copy", "Cancel"]);
    expect(secondOptions).toEqual({ cancelable: true });
    secondPage?.[0]?.onPress?.();
    secondPage?.[1]?.onPress?.();
    expect(actions.every((action) => action.onPress.mock.calls.length === 1)).toBe(true);
  });

  it("marks only the destructive actions", () => {
    presentAndroidActionSheet({
      actions: [
        { text: "Archive", onPress: vi.fn() },
        { text: "Delete…", onPress: vi.fn(), destructive: true },
      ],
      cancel: "Cancel",
      more: "More",
    });
    const [, , buttons] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(buttons).toEqual([
      expect.objectContaining({ text: "Archive" }),
      expect.objectContaining({ text: "Delete…", style: "destructive" }),
      { text: "Cancel", style: "cancel" },
    ]);
  });
});
