import { ActionSheetIOS, Alert, Platform } from "react-native";

type AttachSheetOption = { text: string; onPress: () => void };

/**
 * The mobile composer's attach sheet: iOS gets a native `ActionSheetIOS`
 * anchored to the + (iOS 26+ otherwise centres an unanchored sheet like an
 * alert) and without a title, the + already said what it is; Android keeps
 * `Alert.alert`, which needs its title.
 * `onOpenChange` is the single closing signal the composer's + bubble needs —
 * it fires `true` right away, then `false` on every path back out: picking an
 * option, Cancel, or a tap outside the sheet (iOS reports all three through
 * the same callback, at `cancelButtonIndex` for the latter two), and on every
 * Android button press or dismiss.
 */
export function presentAttachSheet({
  title,
  options,
  cancel,
  colorScheme,
  anchor,
  onOpenChange,
}: {
  /** Android only: the dialog's heading. */
  title: string;
  options: AttachSheetOption[];
  cancel: string;
  colorScheme: "light" | "dark";
  /** iOS: the + bubble's native tag (`findNodeHandle`), so the sheet opens from it. */
  anchor?: number | null;
  onOpenChange: (open: boolean) => void;
}): void {
  onOpenChange(true);
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        userInterfaceStyle: colorScheme,
        options: [...options.map((option) => option.text), cancel],
        cancelButtonIndex: options.length,
        ...(anchor ? { anchor } : {}),
      },
      (index) => {
        onOpenChange(false);
        options[index]?.onPress();
      },
    );
    return;
  }
  Alert.alert(
    title,
    undefined,
    [
      ...options.map((option) => ({
        text: option.text,
        onPress: () => {
          onOpenChange(false);
          option.onPress();
        },
      })),
      { text: cancel, style: "cancel" as const, onPress: () => onOpenChange(false) },
    ],
    { cancelable: true, onDismiss: () => onOpenChange(false) },
  );
}
