import { useEffect, useRef } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Animated, Easing } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

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
 * forever, with a per-dot delay — the thread's typing bubble
 * (`typing-bubble.tsx`) animates three of these. Freezes at the midpoint under
 * reduced motion instead of looping (design handoff "Réduire les animations").
 * On the native driver: a Reanimated opacity commits the shadow tree on the
 * main thread every frame for as long as a bot works.
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
  const opacity = useRef(new Animated.Value(reducedMotion ? midpoint : minOpacity)).current;

  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(midpoint);
      return;
    }
    opacity.setValue(minOpacity);
    const phase = (toValue: number) =>
      Animated.timing(opacity, {
        toValue,
        duration: durationMs,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      });
    const pulse = Animated.sequence([
      Animated.delay(delayMs),
      Animated.loop(Animated.sequence([phase(maxOpacity), phase(minOpacity)])),
    ]);
    pulse.start();
    return () => pulse.stop();
  }, [delayMs, durationMs, maxOpacity, midpoint, minOpacity, opacity, reducedMotion]);

  return <Animated.View style={[style, { opacity }]} />;
}
