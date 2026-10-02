import { ActionSheetIOS, Alert, Platform } from "react-native";

type MessageAction = {
  text: string;
  onPress: () => void;
  /** Shown greyed out on iOS; Android alerts cannot grey a button, so it is left out. */
  disabled?: boolean;
  destructive?: boolean;
};

function indicesOf(actions: MessageAction[], pick: (action: MessageAction) => boolean | undefined) {
  return actions.flatMap((action, index) => (pick(action) ? [index] : []));
}

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
    const disabledButtonIndices = indicesOf(actions, (action) => action.disabled);
    const destructiveButtonIndex = indicesOf(actions, (action) => action.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((action) => action.text), cancel],
        cancelButtonIndex: actions.length,
        title,
        userInterfaceStyle: colorScheme,
        ...(disabledButtonIndices.length ? { disabledButtonIndices } : {}),
        ...(destructiveButtonIndex.length ? { destructiveButtonIndex } : {}),
      },
      (index) => actions[index]?.onPress(),
    );
    return;
  }

  function showPage(remaining: MessageAction[]) {
    const button = (action: MessageAction) => ({
      text: action.text,
      onPress: action.onPress,
      ...(action.destructive ? { style: "destructive" as const } : {}),
    });
    // Android alerts support three buttons. Back/outside tap dismisses every page.
    const buttons =
      remaining.length > 3
        ? [
            ...remaining.slice(0, 2).map(button),
            { text: more, onPress: () => showPage(remaining.slice(2)) },
          ]
        : [
            ...remaining.map(button),
            ...(remaining.length < 3 ? [{ text: cancel, style: "cancel" as const }] : []),
          ];
    Alert.alert(title ?? "", undefined, buttons, { cancelable: true });
  }
  showPage(actions.filter((action) => !action.disabled));
}
