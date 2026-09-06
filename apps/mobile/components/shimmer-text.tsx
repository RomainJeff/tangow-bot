import { memo, useEffect } from "react";
import type { StyleProp, TextStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/** Pulsing label for working states — the native stand-in for the web shimmer.
    ponytail: opacity sweep, not a gradient mask; masked gradients need
    react-native-masked-view, add it only if the pulse reads as too plain. */
export const ShimmerText = memo(function ShimmerText({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const progress = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    cancelAnimation(progress);
    if (reducedMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(progress);
  }, [progress, reducedMotion]);

  const sweep = useAnimatedStyle(() => ({ opacity: 0.45 + progress.value * 0.55 }));

  return (
    <Animated.Text numberOfLines={1} style={[style, sweep]}>
      {children}
    </Animated.Text>
  );
});
