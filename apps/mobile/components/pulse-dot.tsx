import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
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

export interface PulseDotProps {
  /** Stagger before this dot's cycle starts, so a group of dots pulses out of phase. */
  delayMs: number;
  /** One phase (opacity rising or falling), so a full cycle is `2 * durationMs`. */
  durationMs?: number;
  minOpacity?: number;
  maxOpacity?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * A single dot pulsing opacity `minOpacity` → `maxOpacity` → `minOpacity`,
 * forever, with a per-dot delay — the composer's "working"/"dictating" dots
 * (`composer-shell.tsx`) and the thread's typing bubble (`typing-bubble.tsx`)
 * both animate one of these; extracted here so neither duplicates the other's
 * reanimated wiring. Freezes at the midpoint under reduced motion instead of
 * looping (design handoff "Réduire les animations").
 */
export function PulseDot({
  delayMs,
  durationMs = 420,
  minOpacity = 0.3,
  maxOpacity = 1,
  style,
}: PulseDotProps) {
  const reducedMotion = useReducedMotion();
  const midpoint = (minOpacity + maxOpacity) / 2;
  const progress = useSharedValue(reducedMotion ? midpoint : minOpacity);

  useEffect(() => {
    cancelAnimation(progress);
    if (reducedMotion) {
      progress.value = midpoint;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(maxOpacity, { duration: durationMs, easing: Easing.inOut(Easing.ease) }),
          withTiming(minOpacity, { duration: durationMs, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(progress);
  }, [delayMs, durationMs, maxOpacity, midpoint, minOpacity, progress, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  return <Animated.View style={[style, animatedStyle]} />;
}
