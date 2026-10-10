import { ActionSheetIOS, Alert, Platform } from "react-native";

type MessageAction = { text: string; onPress: () => void; destructive?: boolean };

export function presentMessageActionSheet({
  actions,
  title,
  cancel,
  more,
  colorScheme,
}: {
  actions: MessageAction[];
  title?: string;
  cancel: string;
  more: string;
  colorScheme: "light" | "dark";
}): void {
  if (Platform.OS === "ios") {
    const destructive = actions.flatMap((action, index) => (action.destructive ? [index] : []));
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((action) => action.text), cancel],
        cancelButtonIndex: actions.length,
        ...(destructive.length ? { destructiveButtonIndex: destructive } : {}),
        title,
        userInterfaceStyle: colorScheme,
      },
      (index) => actions[index]?.onPress(),
    );
    return;
  }

  function showPage(remaining: MessageAction[]) {
    // Android alerts support three buttons. Back/outside tap dismisses every page.
    const buttons =
      remaining.length > 3
        ? [
            ...remaining.slice(0, 2).map(androidButton),
            { text: more, onPress: () => showPage(remaining.slice(2)) },
          ]
        : [
            ...remaining.map(androidButton),
            ...(remaining.length < 3 ? [{ text: cancel, style: "cancel" as const }] : []),
          ];
    Alert.alert(title ?? "", undefined, buttons, { cancelable: true });
  }
  showPage(actions);
}

function androidButton({ text, onPress, destructive }: MessageAction) {
  return { text, onPress, ...(destructive ? { style: "destructive" as const } : {}) };
}
