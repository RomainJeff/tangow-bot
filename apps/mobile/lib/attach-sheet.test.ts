import { Alert } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { presentAttachSheet } from "./attach-sheet";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

describe("android attach sheet", () => {
  it("closes for every option, for Cancel, and for a dismiss", () => {
    const onOpenChange = vi.fn();
    const options = ["Photo library", "Camera", "File"].map((text) => ({
      text,
      onPress: vi.fn(),
    }));
    presentAttachSheet({ title: "Attach", options, cancel: "Cancel", onOpenChange });
    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    const [title, , buttons, alertOptions] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(title).toBe("Attach");
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
