import { ActionSheetIOS, Alert, Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { presentAttachSheet } from "./attach-sheet";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
}));

function sheet(onOpenChange: (open: boolean) => void) {
  const options = ["Photo library", "Camera", "File"].map((text) => ({
    text,
    onPress: vi.fn(),
  }));
  presentAttachSheet({
    title: "Attach",
    options,
    cancel: "Cancel",
    colorScheme: "light",
    anchor: 42,
    onOpenChange,
  });
  return options;
}

describe("native attach sheet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens immediately and closes on picking an option, in iOS order", () => {
    Platform.OS = "ios";
    const onOpenChange = vi.fn();
    const options = sheet(onOpenChange);
    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    const [config, select] = vi.mocked(ActionSheetIOS.showActionSheetWithOptions).mock.calls[0]!;
    expect(config).toEqual({
      userInterfaceStyle: "light",
      options: ["Photo library", "Camera", "File", "Cancel"],
      cancelButtonIndex: 3,
      anchor: 42,
    });
    select(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(options[1]!.onPress).toHaveBeenCalledOnce();
    expect(options[0]!.onPress).not.toHaveBeenCalled();
    expect(options[2]!.onPress).not.toHaveBeenCalled();
  });

  it("closes without running an option on Cancel or a tap outside — both report the cancel index", () => {
    Platform.OS = "ios";
    const onOpenChange = vi.fn();
    const options = sheet(onOpenChange);
    const [, select] = vi.mocked(ActionSheetIOS.showActionSheetWithOptions).mock.calls[0]!;
    onOpenChange.mockClear();
    select(3);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(options.every((option) => option.onPress.mock.calls.length === 0)).toBe(true);
  });

  it("closes on Android for every option, for Cancel, and for a dismiss", () => {
    Platform.OS = "android";
    const onOpenChange = vi.fn();
    const options = sheet(onOpenChange);
    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    const [, , buttons, alertOptions] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(buttons?.map((button) => button.text)).toEqual([
      "Photo library",
      "Camera",
      "File",
      "Cancel",
    ]);
    expect(alertOptions).toMatchObject({ cancelable: true });

    onOpenChange.mockClear();
    buttons?.[0]?.onPress?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(options[0]!.onPress).toHaveBeenCalledOnce();

    onOpenChange.mockClear();
    buttons?.[3]?.onPress?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    alertOptions?.onDismiss?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
