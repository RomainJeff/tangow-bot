import {
  Button,
  Divider,
  Host,
  Menu,
  Picker,
  RNHostView,
  Text as SwiftText,
} from "@expo/ui/swift-ui";
import { disabled as disabledWhen, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import type { NativeStackHeaderItem } from "expo-router";
import type { ReactElement, ReactNode } from "react";
import { Platform, Pressable, type PressableProps, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useResolvedAppearance } from "../lib/native";
import { headerMenuItems, type MenuAction, splitMenuActions } from "../lib/native-menu";
import { MoreButton } from "./bot-page/skill-parts";

type MenuOption = { value: string; label: string };

type NativeMenuProps = {
  children: ReactNode;
  /** Heads the Android sheet; the iOS menu anchors to its trigger and needs none. */
  title?: string;
  disabled?: boolean;
  onPrimaryAction?: () => void;
  style?: PressableProps["style"];
  accessibilityLabel?: string;
  accessibilityValue?: string;
} & (
  | { actions: MenuAction[] }
  | { options: MenuOption[]; selected: string; onSelect: (value: string) => void }
);

/**
 * Wraps an in-body trigger. iOS opens a native menu anchored to it; Android keeps the action sheet
 * the trigger used before.
 */
export function NativeMenu(props: NativeMenuProps) {
  return Platform.OS === "ios" ? <IosMenu {...props} /> : <AndroidMenu {...props} />;
}

function IosMenu(props: NativeMenuProps) {
  const { children, disabled, onPrimaryAction, accessibilityLabel, accessibilityValue } = props;
  const colorScheme = useResolvedAppearance();
  const style = typeof props.style === "function" ? props.style({ pressed: false }) : props.style;
  return (
    <Host colorScheme={colorScheme} matchContents={{ vertical: true }}>
      <Menu
        label={
          <RNHostView matchContents={{ vertical: true }}>
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              accessibilityValue={accessibilityValue ? { text: accessibilityValue } : undefined}
              accessibilityState={{ disabled: !!disabled }}
              style={style}
            >
              {children}
            </View>
          </RNHostView>
        }
        onPrimaryAction={onPrimaryAction}
        modifiers={[disabledWhen(!!disabled)]}
      >
        {"options" in props ? <ValueItems {...props} /> : <ActionItems actions={props.actions} />}
      </Menu>
    </Host>
  );
}

function ActionItems({ actions }: { actions: MenuAction[] }): ReactElement {
  const { regular, destructive } = splitMenuActions(actions);
  return (
    <>
      {regular.map((action) => (
        <Button key={action.label} label={action.label} onPress={action.onPress} />
      ))}
      {regular.length && destructive.length ? <Divider /> : null}
      {destructive.map((action) => (
        // biome-ignore lint/a11y/useValidAriaRole: SwiftUI button role, not an ARIA role
        <Button
          key={action.label}
          role="destructive"
          label={action.label}
          onPress={action.onPress}
        />
      ))}
    </>
  );
}

function ValueItems({
  options,
  selected,
  onSelect,
}: {
  options: MenuOption[];
  selected: string;
  onSelect: (value: string) => void;
}): ReactElement {
  return (
    <Picker selection={selected} onSelectionChange={onSelect} modifiers={[pickerStyle("inline")]}>
      {options.map((option) => (
        <SwiftText key={option.value} modifiers={[tag(option.value)]}>
          {option.label}
        </SwiftText>
      ))}
    </Picker>
  );
}

function AndroidMenu(props: NativeMenuProps) {
  const { children, title, disabled, onPrimaryAction, style } = props;
  const present = useActionSheet(title);
  const actions: MenuAction[] =
    "options" in props
      ? props.options.map((option) => ({
          label: option.label,
          onPress: () => props.onSelect(option.value),
        }))
      : props.actions;
  const open = () => present(actions);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityValue={props.accessibilityValue ? { text: props.accessibilityValue } : undefined}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPrimaryAction ?? open}
      onLongPress={onPrimaryAction ? open : undefined}
      style={style}
    >
      {children}
    </Pressable>
  );
}

function useActionSheet(title?: string) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  return (actions: MenuAction[]) =>
    presentMessageActionSheet({
      title,
      actions: actions.map(({ label, onPress, destructive }) => ({
        text: label,
        onPress,
        destructive,
      })),
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });
}

/**
 * The header's `⋯`. iOS opens a native menu from the bar item; Android keeps its button and the
 * action sheet.
 */
export function useHeaderMenu(label: string, actions: MenuAction[]) {
  const present = useActionSheet();
  return {
    unstable_headerRightItems: (): NativeStackHeaderItem[] => [
      {
        type: "menu",
        label,
        icon: { type: "sfSymbol", name: "ellipsis" },
        menu: { items: headerMenuItems(actions) },
      },
    ],
    headerRight: () => <MoreButton label={label} onPress={() => present(actions)} />,
  };
}
