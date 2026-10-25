import { Alert } from "react-native";

type SheetAction = { text: string; onPress: () => void; destructive?: boolean };

/** Android has no anchored menu: an alert lists the actions, paging past its three-button limit. */
export function presentAndroidActionSheet({
  actions,
  title,
  cancel,
  more,
}: {
  actions: SheetAction[];
  title?: string;
  cancel: string;
  more: string;
}): void {
  function showPage(remaining: SheetAction[]) {
    // Back/outside tap dismisses every page.
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

function androidButton({ text, onPress, destructive }: SheetAction) {
  return { text, onPress, ...(destructive ? { style: "destructive" as const } : {}) };
}
