import type { ButtonProps } from "@expo/ui/swift-ui";
import type {
  NativeStackHeaderItemMenuAction,
  NativeStackHeaderItemMenuSubmenu,
} from "expo-router";

export type MenuAction = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  /** iOS only: the SF Symbol drawn beside the label in an in-body menu. */
  systemImage?: ButtonProps["systemImage"];
};

export function splitMenuActions(actions: MenuAction[]): {
  regular: MenuAction[];
  destructive: MenuAction[];
} {
  return {
    regular: actions.filter((action) => !action.destructive),
    destructive: actions.filter((action) => action.destructive),
  };
}

/** Destructive actions come last, set apart by an inline submenu when regular ones precede them. */
export function headerMenuItems(
  actions: MenuAction[],
): (NativeStackHeaderItemMenuAction | NativeStackHeaderItemMenuSubmenu)[] {
  const { regular, destructive } = splitMenuActions(actions);
  const items = regular.map(
    ({ label, onPress }): NativeStackHeaderItemMenuAction => ({ type: "action", label, onPress }),
  );
  const destructiveItems = destructive.map(
    ({ label, onPress }): NativeStackHeaderItemMenuAction => ({
      type: "action",
      label,
      onPress,
      destructive: true,
    }),
  );
  if (!destructiveItems.length) return items;
  if (!items.length) return destructiveItems;
  return [...items, { type: "submenu", label: "", inline: true, items: destructiveItems }];
}
