import { radii } from "@rakazo/ui-tokens";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens } from "../lib/appearance";
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";
import { nativeTextStyle } from "../lib/typography";

export interface ReactionPillProps {
  emoji: string;
  count: number;
  /** True the render this pill appeared or its count went up (`useReactionPops`) —
   * read once, at mount, since a pop's own trigger already re-mounts nothing:
   * the caller re-renders this component with a new `pop` value on the
   * SAME instance, so the pop is driven by an effect on that prop instead
   * of a mount-time read. */
  pop: boolean;
}

/** 7d: a reaction pill pops `0 → 1.25 → 1` when it appears or its count goes
 * up — never on a plain re-render with nothing changed. */
export function ReactionPill({ emoji, count, pop }: ReactionPillProps) {
  const tokens = mobileTokens();
  const reducedMotion = useChatReducedMotion();
  const scale = useSharedValue(1);

  useEffect(() => {
    if (!pop) return;
    if (reducedMotion) return;
    scale.value = 0;
    scale.value = withSequence(
      withTiming(CHAT_MOTION.reactionPopScale, { duration: CHAT_MOTION.reactionPopMs / 2 }),
      withTiming(1, { duration: CHAT_MOTION.reactionPopMs / 2 }),
    );
  }, [pop, reducedMotion, scale]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.Text
      style={[
        animatedStyle,
        {
          color: tokens.foreground,
          backgroundColor: tokens.muted,
          borderColor: tokens.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radii.pill,
          paddingHorizontal: 8,
          paddingVertical: 2,
          ...nativeTextStyle("meta"),
        },
      ]}
    >
      {emoji}
      {count > 1 ? ` ${count}` : ""}
    </Animated.Text>
  );
}
