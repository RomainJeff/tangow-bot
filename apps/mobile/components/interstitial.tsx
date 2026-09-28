import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

export interface InterstitialProps extends Omit<ViewProps, "children"> {
  /** Usually a `StackedAvatars` at 16 (mobile's `stackXs` size). */
  avatars: ReactNode;
  children: ReactNode;
  onPress?: () => void;
  /**
   * Tap slop around a pressable line, 8 by default: the row is one short
   * sentence, so its target has to be bigger than its ink. Ignored when there
   * is no `onPress` — nothing to hit.
   */
  hitSlop?: ViewProps["hitSlop"];
}

/**
 * A handoff between two bots, centred between messages: who talked to whom,
 * quiet enough to skip. Mirrors `packages/ui-web/src/interstitial.tsx`.
 */
export function Interstitial({
  avatars,
  children,
  onPress,
  hitSlop = 8,
  style,
  ...props
}: InterstitialProps) {
  const styles = useThemedStyles(createInterstitialStyles);
  const content = (
    <>
      {avatars}
      <Text numberOfLines={1} style={styles.text}>
        {children}
      </Text>
      <Text accessibilityElementsHidden style={styles.chevron}>
        {"›"}
      </Text>
    </>
  );
  if (!onPress) {
    return (
      <View style={[styles.row, style]} {...props}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={hitSlop}
      onPress={onPress}
      style={({ pressed }) => [styles.row, style, pressed && styles.pressed]}
      {...props}
    >
      {content}
    </Pressable>
  );
}

function createInterstitialStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    row: {
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 34,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    pressed: {
      opacity: 0.6,
    },
    text: {
      flexShrink: 1,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
    chevron: {
      color: tokens.mutedForeground,
      fontSize: 14,
    },
  });
}

export interface HandoffDividerProps extends Omit<ViewProps, "children"> {
  children: ReactNode;
}

/**
 * A handoff between two bots (design contract §B, "Handoff"): centred label
 * with a 28×1 `border` hairline on each side, no avatars, no chevron — it is
 * never tappable, unlike the peer-message `Interstitial` above.
 */
export function HandoffDivider({ children, style, ...props }: HandoffDividerProps) {
  const styles = useThemedStyles(createHandoffDividerStyles);
  return (
    <View style={[styles.row, style]} {...props}>
      <View style={styles.hairline} />
      <Text numberOfLines={1} style={styles.text}>
        {children}
      </Text>
      <View style={styles.hairline} />
    </View>
  );
}

function createHandoffDividerStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    row: {
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    hairline: {
      width: 28,
      height: 1,
      backgroundColor: tokens.border,
    },
    text: {
      flexShrink: 1,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
  });
}
