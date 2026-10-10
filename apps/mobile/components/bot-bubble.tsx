import { motion, radii, sizes } from "@rakazo/ui-tokens";
import { useIsFocused } from "expo-router";
import type { ComponentProps } from "react";
import { useEffect } from "react";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens } from "../lib/appearance";
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";
import { commitHaptic } from "../lib/haptics";
import { useThemedStyles } from "../lib/native";
import {
  PROOF_ICON_POP_FROM,
  PROOF_LINE_DELAY_MS,
  PROOF_LINE_GAP,
  proofLineHitSlop,
} from "../lib/proof-lines";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

/** The thread's side padding, and the gap between a group's avatar and its bubbles. */
export const THREAD_GUTTER = 14;
export const AVATAR_GAP = 8;

/** A proof line under a bot's message: what it came from, or what it changed. */
export interface BotBubbleMeta {
  /** Stable among the lines of one message, so a line keeps its animation when another arrives. */
  id: string;
  /** Already translated ("From Monday review", "Skill learned · Coffee"). */
  label: string;
  icon: { ios: string; android: ComponentProps<typeof NativeSymbol>["android"] };
  onPress?: () => void;
  /** The line just arrived in this thread: it rises in, its icon pops, and a light tap
   * is felt when the thread is on screen. Never set for a line read from history. */
  live?: boolean;
}

const LINE_RISE_PX = 6;
const ICON_SIZE = 13;

export interface BotBubbleProps extends PressableProps {
  /** The proof lines, drawn under the bubble at its text inset, one per line. They sit outside
   * the bubble's Pressable so VoiceOver can reach each one. */
  meta?: readonly BotBubbleMeta[];
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
    <View>
      <View style={styles.row}>
        <Pressable
          {...props}
          style={(state) => [
            styles.bubble,
            { maxWidth },
            typeof style === "function" ? style(state) : style,
          ]}
        >
          {children}
        </Pressable>
      </View>
      {meta?.length ? (
        <View style={styles.under}>
          <BubbleMeta lines={meta} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The proof lines under a bubble's content, also drawn under an attachment card.
 * `standalone` draws them with no bubble, at the bubble's text inset.
 */
export function BubbleMeta({
  lines,
  standalone = false,
}: {
  lines: readonly BotBubbleMeta[];
  standalone?: boolean;
}) {
  const styles = useThemedStyles(createBotBubbleStyles);
  const focused = useIsFocused();
  const arriving = lines.some((line) => line.live);
  useEffect(() => {
    if (arriving && focused) commitHaptic();
  }, []);
  return (
    <View style={standalone ? styles.standalone : styles.lines}>
      {lines.map((line) => (
        <MetaLine key={line.id} line={line} hitSlop={proofLineHitSlop(lines.length)} />
      ))}
    </View>
  );
}

function MetaLine({ line, hitSlop }: { line: BotBubbleMeta; hitSlop: number }) {
  const styles = useThemedStyles(createBotBubbleStyles);
  const tokens = mobileTokens();
  const reducedMotion = useChatReducedMotion();
  const live = Boolean(line.live);
  const opacity = useSharedValue(live ? 0 : 1);
  const rise = useSharedValue(live && !reducedMotion ? LINE_RISE_PX : 0);
  const pop = useSharedValue(live && !reducedMotion ? PROOF_ICON_POP_FROM : 1);
  useEffect(() => {
    if (!live) return;
    const timing = { duration: motion.arrive, easing: CHAT_MOTION.botEnterEasing };
    if (reducedMotion) {
      opacity.value = withTiming(1, { duration: CHAT_MOTION.reducedFadeMs });
      return;
    }
    opacity.value = withDelay(PROOF_LINE_DELAY_MS, withTiming(1, timing));
    rise.value = withDelay(PROOF_LINE_DELAY_MS, withTiming(0, timing));
    pop.value = withDelay(PROOF_LINE_DELAY_MS, withTiming(1, timing));
  }, []);
  const lineStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: rise.value }],
  }));
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  return (
    <Animated.View style={lineStyle}>
      <Pressable
        accessibilityRole={line.onPress ? "link" : undefined}
        accessibilityLabel={line.label}
        hitSlop={{ top: hitSlop, bottom: hitSlop }}
        onPress={line.onPress}
        style={styles.meta}
      >
        <Animated.View accessibilityElementsHidden importantForAccessibility="no" style={iconStyle}>
          <NativeSymbol
            ios={line.icon.ios}
            android={line.icon.android}
            size={ICON_SIZE}
            color={tokens.mutedForeground}
          />
        </Animated.View>
        <Text numberOfLines={1} style={[styles.metaText, styles.metaLabel]}>
          {line.label}
        </Text>
        <Text accessibilityElementsHidden style={styles.metaText}>
          {"›"}
        </Text>
      </Pressable>
    </Animated.View>
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
    under: {
      paddingHorizontal: 14,
    },
    lines: {
      gap: PROOF_LINE_GAP,
      marginTop: 6,
      alignItems: "flex-start",
    },
    standalone: {
      gap: PROOF_LINE_GAP,
      paddingHorizontal: 14,
      paddingVertical: 14,
      alignItems: "flex-start",
    },
    meta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: "100%",
    },
    metaText: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
    metaLabel: {
      flexShrink: 1,
    },
  });
}
