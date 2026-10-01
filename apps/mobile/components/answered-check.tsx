import { useEffect } from "react";
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The check's path length in its own viewBox units — long enough that
 * `strokeDasharray` covers it fully at offset 0 (drawn), and hides it
 * entirely at offset = length (undrawn). Mirrors `stop-contour.tsx`'s
 * `strokeDashoffset` technique. */
const CHECK_PATH_LENGTH = 22;

export interface AnsweredCheckProps {
  color: string;
  size?: number;
  /** True only for a card that just settled while on screen (7e) — draws the
   * check over `CHAT_MOTION.decisionCheckMs`. A card already answered at
   * thread open renders this fully drawn, with no animation. */
  animate: boolean;
}

/** The small drawn check beside a settled decision card's answered line. */
export function AnsweredCheck({ color, size = 14, animate }: AnsweredCheckProps) {
  const reducedMotion = useChatReducedMotion();
  const progress = useSharedValue(animate && !reducedMotion ? 0 : 1);

  useEffect(() => {
    if (!animate || reducedMotion) {
      progress.value = 1;
      return;
    }
    progress.value = withTiming(1, {
      duration: CHAT_MOTION.decisionCheckMs,
      easing: Easing.out(Easing.ease),
    });
    // `animate` is only ever true once per card (the transition itself never
    // repeats), so re-running this on its own change is exactly right.
  }, [animate, reducedMotion, progress]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_PATH_LENGTH * (1 - progress.value),
  }));

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <AnimatedPath
        d="M4 12.5l4.5 4.5L20 6"
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={CHECK_PATH_LENGTH}
        animatedProps={animatedProps}
      />
    </Svg>
  );
}
