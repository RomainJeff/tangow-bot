import { radii, sizes } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

/** The thread's side padding, and the gap between a group's avatar and its bubbles. */
export const THREAD_GUTTER = 14;
export const AVATAR_GAP = 8;

export interface BotBubbleMeta {
  /** The proof line, already translated ("Sent to #ops", "2 sources"). */
  label: ReactNode;
  onPress?: () => void;
}

export interface BotBubbleProps extends PressableProps {
  /** The proof line, drawn inside the bubble under its content. */
  meta?: BotBubbleMeta;
  /** A single-bot thread: the bubble caps at 82% of the thread instead of 88%
   * of the content column. */
  mono?: boolean;
}

/**
 * What a bot said: a `muted` bubble that fits its content. Mirrors
 * `MessageBubble` in `packages/ui-web/src/message-row.tsx`. The cap is a
 * number, not a percentage: a bubble that fits its content has no definite
 * width for percentages to resolve against, so Yoga would measure wrapped
 * markdown wider than it draws it and clip the last line.
 */
export function BotBubble({ mono = false, meta, style, children, ...props }: BotBubbleProps) {
  const styles = useThemedStyles(createBotBubbleStyles);
  const { width } = useWindowDimensions();
  // Mono: 82% of the thread. Group: 88% of the column right of the avatar.
  const column = width - THREAD_GUTTER * 2 - (mono ? 0 : sizes.message + AVATAR_GAP);
  const maxWidth = Math.floor(column * (mono ? 0.82 : 0.88));
  return (
    <View style={styles.row}>
      <Pressable
        {...props}
        style={(state) => [
          styles.bubble,
          { maxWidth },
          typeof style === "function" ? style(state) : style,
        ]}
      >
        {(state) => (
          <>
            {typeof children === "function" ? children(state) : children}
            {meta ? (
              <Pressable
                accessibilityRole={meta.onPress ? "button" : undefined}
                onPress={meta.onPress}
                style={styles.meta}
              >
                <Text style={styles.metaText}>{meta.label}</Text>
                <Text accessibilityElementsHidden style={styles.metaText}>
                  {"›"}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </Pressable>
    </View>
  );
}

function createBotBubbleStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    row: {
      flexDirection: "row",
    },
    bubble: {
      flexShrink: 1,
      borderRadius: radii.bubble,
      backgroundColor: tokens.muted,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    meta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 6,
      alignSelf: "flex-start",
    },
    metaText: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
  });
}
