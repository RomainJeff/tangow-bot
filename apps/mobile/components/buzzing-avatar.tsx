import type { ReactNode } from "react";
import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useChatReducedMotion } from "../lib/chat-motion";

/**
 * A working bot buzzes: a steady, linear left-right jitter of its avatar,
 * mounted only while the typing bubble shows. Mirrors `rk-buzz` in
 * `packages/ui-web/src/styles.css`; reduced motion keeps it still.
 */
export function BuzzingAvatar({ children }: { children: ReactNode }) {
  const reducedMotion = useChatReducedMotion();
  const x = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    x.value = -1.5;
    x.value = withRepeat(withTiming(1.5, { duration: 120, easing: Easing.linear }), -1, true);
    return () => {
      cancelAnimation(x);
      x.value = 0;
    };
  }, [reducedMotion, x]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { rotate: `${x.value * (4 / 3)}deg` }],
  }));

  return <Animated.View style={style}>{children}</Animated.View>;
}
