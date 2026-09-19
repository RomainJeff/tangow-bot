import { radii } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { useEffect } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { elevationForAppearance } from "../lib/theme";

export type ComposerState = "idle" | "typing" | "dictating" | "speaking" | "working";

const BAR_DELAYS_MS = [0, 140, 280, 420];
const DOT_DELAYS_MS = [0, 160, 320];

export interface ComposerShellProps extends Omit<ViewProps, "children"> {
  /** A mention chip, or the avatar of the bot that is speaking. */
  leading?: ReactNode;
  /** The field itself. */
  children: ReactNode;
  /** Round-icon buttons: attach, dictate, send, stop. */
  trailing?: ReactNode;
  state?: ComposerState;
}

/**
 * The capsule at the bottom of the thread — the one elevation of that screen.
 * Mirrors `packages/ui-web/src/composer-shell.tsx`.
 */
export function ComposerShell({
  leading,
  children,
  trailing,
  state = "idle",
  style,
  ...props
}: ComposerShellProps) {
  const styles = useThemedStyles(createComposerShellStyles);
  return (
    <View
      style={[styles.root, leading ? styles.withLeading : styles.withoutLeading, style]}
      {...props}
    >
      {leading}
      {state === "dictating" ? <PulseGroup count={BAR_DELAYS_MS.length} bar /> : null}
      {state === "working" ? <PulseGroup count={DOT_DELAYS_MS.length} /> : null}
      <View style={styles.field}>{children}</View>
      {trailing}
    </View>
  );
}

/** Four bars (dictating) or three dots (working), pulsing out of phase;
 * frozen under reduced motion instead of looping. */
function PulseGroup({ count, bar = false }: { count: number; bar?: boolean }) {
  const styles = useThemedStyles(createComposerShellStyles);
  const delays = bar ? BAR_DELAYS_MS : DOT_DELAYS_MS;
  return (
    <View style={bar ? styles.dictating : styles.working}>
      {Array.from({ length: count }, (_, index) => (
        <Pulse key={index} delayMs={delays[index] ?? 0} bar={bar} styles={styles} />
      ))}
    </View>
  );
}

function Pulse({
  delayMs,
  bar,
  styles,
}: {
  delayMs: number;
  bar: boolean;
  styles: ReturnType<typeof createComposerShellStyles>;
}) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(reducedMotion ? 0.7 : 0.3);

  useEffect(() => {
    cancelAnimation(progress);
    if (reducedMotion) {
      progress.value = 0.7;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 420, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: 420, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(progress);
  }, [delayMs, progress, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: bar ? [{ scaleY: 0.4 + progress.value * 0.6 }] : undefined,
  }));

  return <Animated.View style={[bar ? styles.bar : styles.dot, animatedStyle]} />;
}

function createComposerShellStyles() {
  const tokens = mobileTokens();
  const elevation = elevationForAppearance(resolveMobileAppearance());
  return StyleSheet.create({
    root: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: radii.pill,
      backgroundColor: tokens.surface,
      paddingVertical: 7,
      paddingEnd: 7,
      ...elevation.composer,
    },
    withLeading: { paddingStart: 10 },
    withoutLeading: { paddingStart: 16 },
    field: {
      flex: 1,
      minWidth: 0,
    },
    dictating: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 3,
    },
    bar: {
      width: 3,
      height: 14,
      borderRadius: 1.5,
      backgroundColor: tokens.foreground,
    },
    working: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    dot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: tokens.foreground,
    },
  });
}
