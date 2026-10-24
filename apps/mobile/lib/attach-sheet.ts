import { Alert } from "react-native";

type AttachSheetOption = { text: string; onPress: () => void };

/**
 * Android's attach dialog (iOS opens a native menu from the + instead). `onOpenChange` is the
 * single closing signal the composer's + bubble needs: it fires `true` right away, then `false`
 * on every path back out, whether a button press, Cancel or a dismiss.
 */
export function presentAttachSheet({
  title,
  options,
  cancel,
  onOpenChange,
}: {
  title: string;
  options: AttachSheetOption[];
  cancel: string;
  onOpenChange: (open: boolean) => void;
}): void {
  onOpenChange(true);
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
