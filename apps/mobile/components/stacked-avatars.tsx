import type { ViewProps } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import type { StackedAvatarSize } from "../lib/stacked-avatars-layout";
import { STACKED_AVATAR_OVERLAP, stackedAvatarsLayout } from "../lib/stacked-avatars-layout";
import { nativeTextStyle } from "../lib/typography";
import { BotAvatar } from "./bot-avatar";

export type { StackedAvatarSize };

export interface StackedAvatarItem {
  color: string;
  identity?: string;
  working?: boolean;
  shapeSeed?: number | null;
}

export interface StackedAvatarsProps extends Omit<ViewProps, "children"> {
  items: StackedAvatarItem[];
  size: StackedAvatarSize;
  /** Avatars shown before the rest collapses into `+N`. */
  max?: number;
  /**
   * Translated name for the group ("Maya, Atlas and 2 more"). Without it the
   * stack is decoration and is hidden from assistive technology, which is
   * right when the sentence beside it already names the bots.
   */
  label?: string;
}

/**
 * The bots behind a group, a delegation or a receipt, in one glance. Mirrors
 * `packages/ui-web/src/stacked-avatars.tsx`.
 */
export function StackedAvatars({
  items,
  size,
  max = 3,
  label,
  style,
  ...props
}: StackedAvatarsProps) {
  const styles = useThemedStyles(createStackedAvatarsStyles);
  const { shown, overflow } = stackedAvatarsLayout(items, max);
  const overlap = STACKED_AVATAR_OVERLAP[size];
  return (
    <View
      accessible={Boolean(label)}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      accessibilityElementsHidden={!label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      style={[styles.row, style]}
      {...props}
    >
      {shown.map((item, index) => (
        <View
          key={item.identity ?? `${item.color}-${index}`}
          style={index === 0 ? undefined : { marginStart: -overlap }}
        >
          <BotAvatar
            color={item.color}
            identity={item.identity}
            shapeSeed={item.shapeSeed}
            size={size}
            status={item.working ? "running" : undefined}
          />
        </View>
      ))}
      {overflow > 0 ? <Text style={styles.overflow}>{`+${overflow}`}</Text> : null}
    </View>
  );
}

function createStackedAvatarsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
    },
    overflow: {
      paddingStart: 4,
      color: tokens.mutedForeground,
      ...nativeTextStyle("label"),
    },
  });
}
