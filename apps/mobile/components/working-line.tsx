import { sizes } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ViewProps } from "react-native";
import { Platform, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens } from "../lib/appearance";
import { formatElapsed } from "../lib/format-elapsed";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

export interface WorkingLineProps extends Omit<ViewProps, "children"> {
  /** A working `BotAvatar` at the `message` size (26). */
  avatar: ReactNode;
  /** "Maya is drafting the recap", already translated. */
  label: ReactNode;
  /** Epoch ms the run started. Falls back to mount time. */
  startedAt?: number;
}

/** Ticks the elapsed time in tenths of a second; freezes at its first reading
 * under reduced motion, same contract as `packages/ui-web/src/use-elapsed.ts`. */
function useElapsedTicker(startedAt?: number): string {
  const reducedMotion = useReducedMotion();
  const started = useRef(startedAt ?? Date.now()).current;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [reducedMotion]);
  return formatElapsed(started, now);
}

/** A working bot buzzes: a steady, linear left-right jitter.
 * Mirrors `rk-buzz` in `packages/ui-web/src/styles.css`. */
function useBuzzStyle() {
  const reducedMotion = useReducedMotion();
  const x = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) return;
    x.value = -1.5;
    x.value = withRepeat(withTiming(1.5, { duration: 120, easing: Easing.linear }), -1, true);
    return () => {
      x.value = 0;
    };
  }, [reducedMotion, x]);
  return useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { rotate: `${x.value * (4 / 3)}deg` }],
  }));
}

/** The only thing that moves while a bot works. Mirrors
 * `packages/ui-web/src/working-line.tsx`. */
export function WorkingLine({ avatar, label, startedAt, style, ...props }: WorkingLineProps) {
  const styles = useThemedStyles(createWorkingLineStyles);
  const elapsed = useElapsedTicker(startedAt);
  const buzz = useBuzzStyle();
  return (
    <View
      accessible
      accessibilityLabel={typeof label === "string" ? label : undefined}
      accessibilityLiveRegion={Platform.OS === "android" ? "polite" : undefined}
      style={[styles.row, style]}
      {...props}
    >
      <Animated.View style={[styles.avatar, buzz]}>{avatar}</Animated.View>
      <Text numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      <Text accessibilityElementsHidden style={styles.elapsed}>
        {elapsed}
      </Text>
    </View>
  );
}

function createWorkingLineStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 11,
    },
    avatar: {
      width: sizes.message,
      flexShrink: 0,
    },
    label: {
      flex: 1,
      minWidth: 0,
      color: tokens.mutedForeground,
      ...nativeTextStyle("working"),
    },
    elapsed: {
      color: tokens.mutedForeground,
      fontVariant: ["tabular-nums"],
      fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
      ...nativeTextStyle("mono"),
    },
  });
}
