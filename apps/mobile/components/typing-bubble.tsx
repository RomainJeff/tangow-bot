import { radii } from "@rakazo/ui-tokens";
import { memo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { PulseDot } from "./pulse-dot";
import { ShimmerText } from "./shimmer-text";

const DOT_DELAYS_MS = [0, 160, 320];

export interface TypingBubbleProps {
  /**
   * A single bot's current activity ("Reading …"), shown as chatoyant text
   * instead of the dots (design contract decision D1-b). Omit for a group, or
   * when no activity is known yet — the plain three-dot pulse is the default.
   */
  activityLabel?: string;
}

/**
 * The bubble a bot's turn shows while it works (design contract § "Indicateur
 * d'écriture", decision D1-b): replaces the old working line's avatar,
 * "{name} is working…" label and elapsed clock — no chrome beyond the bubble
 * itself. Callers wrap it in `MessageRow` for the mono/multi grammar, same as
 * any other bot row (name on top, `BotAvatar status="working"` at the foot in
 * multi).
 */
export const TypingBubble = memo(function TypingBubble({ activityLabel }: TypingBubbleProps) {
  const styles = useThemedStyles(createTypingBubbleStyles);
  return (
    <View style={styles.bubble}>
      {activityLabel ? (
        // A long activity ("Searching the web: …") runs past the bubble's edge
        // and slides under the finger, with no scroll bar to show for it.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
        >
          <ShimmerText numberOfLines={0} style={styles.label}>
            {activityLabel}
          </ShimmerText>
        </ScrollView>
      ) : (
        <View style={styles.dots}>
          {DOT_DELAYS_MS.map((delayMs, index) => (
            <PulseDot
              key={index}
              delayMs={delayMs}
              durationMs={600}
              minOpacity={0.25}
              maxOpacity={1}
              style={styles.dot}
            />
          ))}
        </View>
      )}
    </View>
  );
});

function createTypingBubbleStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    bubble: {
      alignSelf: "flex-start",
      maxWidth: "100%",
      height: 40,
      paddingHorizontal: 16,
      overflow: "hidden",
      borderRadius: radii.bubble,
      backgroundColor: tokens.muted,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    scroll: {
      flexGrow: 0,
      flexShrink: 1,
      // The label scrolls to the bubble's own edge, not to its padding.
      marginHorizontal: -16,
    },
    scrollContent: {
      paddingHorizontal: 16,
      alignItems: "center",
    },
    dots: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
    },
    dot: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
      backgroundColor: tokens.mutedForeground,
    },
    label: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("working"),
    },
  });
}
