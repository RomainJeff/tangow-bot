import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { CHAT_MOTION, entrance, useChatReducedMotion } from "../lib/chat-motion";
import { commitHaptic } from "../lib/haptics";
import {
  hasCrossedSwipeReplyThreshold,
  resistedSwipeOffset,
  SWIPE_REPLY_THRESHOLD_PX,
} from "../lib/swipe-reply-math";
import { NativeSymbol } from "./native-symbol";

export type AnimatedMessageBubbleVariant = "user" | "bot";

export interface AnimatedMessageBubbleProps {
  variant: AnimatedMessageBubbleVariant;
  /** True only for a message the arrivals helper flagged as newly arrived
   * this pass (MA-1) — read once, at mount, never re-evaluated. */
  isNew: boolean;
  /** 7b's burst stagger, in ms; ignored for `variant="user"` (7a has no
   * stagger) and under reduced motion. */
  enterDelayMs?: number;
  /** 7g: swipe-to-reply. Bot narration bubbles in the main thread only. */
  enableSwipeReply?: boolean;
  onLongPress: () => void;
  onSwipeReply?: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
  children: ReactNode;
}

/**
 * The row-level gesture + entrance wrapper for a plain text bubble (7a, 7b,
 * 7d, 7g). Replaces the RN `Pressable onLongPress` the row used to wrap the
 * bubble in: both the long press and the swipe are `react-native-gesture-handler`
 * gestures composed with `Gesture.Race`, per the design-motion spec's
 * transverse rules — a card (ask, decision, app-connect…) is untouched and
 * keeps its plain `Pressable` wrapper in `thread.tsx`.
 */
export function AnimatedMessageBubble({
  variant,
  isNew,
  enterDelayMs = 0,
  enableSwipeReply = false,
  onLongPress,
  onSwipeReply,
  accessibilityActions,
  onAccessibilityAction,
  children,
}: AnimatedMessageBubbleProps) {
  const reducedMotion = useChatReducedMotion();
  const entering = isNew ? arrivalEntrance(variant, enterDelayMs, reducedMotion) : undefined;

  const pressScale = useSharedValue(1);
  const swipeX = useSharedValue(0);
  const iconScale = useSharedValue(0);
  const previousRawDx = useSharedValue(0);

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }, { translateX: swipeX.value }],
  }));

  const iconStyle = useAnimatedStyle(() => ({
    opacity: swipeX.value > 0 ? 1 : 0,
    transform: [{ scale: iconScale.value }],
  }));

  function fireLongPress() {
    onLongPress();
  }
  function fireHaptic() {
    commitHaptic();
  }
  function fireSwipeReply() {
    onSwipeReply?.();
  }

  const longPress = Gesture.LongPress()
    .minDuration(350)
    .onBegin(() => {
      if (reducedMotion) return;
      // A thumb that brushes a bubble on its way to scroll lifts or moves
      // within this delay, so only a real hold presses the bubble down.
      pressScale.value = withDelay(
        CHAT_MOTION.pressDownDelayMs,
        withTiming(CHAT_MOTION.pressDownScale, { duration: CHAT_MOTION.pressDownMs }),
      );
    })
    .onStart(() => {
      // The actions sheet gives its own selection tap as it opens.
      if (!reducedMotion) {
        pressScale.value = withSequence(
          withTiming(CHAT_MOTION.pressReboundScale, { duration: CHAT_MOTION.pressReboundMs }),
          withTiming(1, { duration: CHAT_MOTION.pressReboundMs }),
        );
      }
      runOnJS(fireLongPress)();
    })
    .onFinalize(() => {
      pressScale.value = withTiming(1, { duration: CHAT_MOTION.pressDownMs });
    });

  const panGesture = Gesture.Pan()
    .enabled(enableSwipeReply)
    .activeOffsetX(12)
    .failOffsetY([-12, 12])
    .onUpdate((event) => {
      const nextRawDx = event.translationX;
      const offset = resistedSwipeOffset(nextRawDx);
      const wasCrossed = hasCrossedSwipeReplyThreshold(resistedSwipeOffset(previousRawDx.value));
      const isCrossed = hasCrossedSwipeReplyThreshold(offset);
      if (!wasCrossed && isCrossed) {
        iconScale.value = withSequence(
          withTiming(CHAT_MOTION.swipeIconPopScale, { duration: 120 }),
          withTiming(1, { duration: 120 }),
        );
        runOnJS(fireHaptic)();
      }
      previousRawDx.value = nextRawDx;
      swipeX.value = offset;
    })
    .onEnd(() => {
      if (hasCrossedSwipeReplyThreshold(swipeX.value)) runOnJS(fireSwipeReply)();
      swipeX.value = reducedMotion
        ? withTiming(0, { duration: CHAT_MOTION.reducedFadeMs })
        : withSpring(0, CHAT_MOTION.swipeReturnSpring);
      iconScale.value = withTiming(0, { duration: 120 });
      previousRawDx.value = 0;
    });

  // Race, not Exclusive: Exclusive holds the long press until the swipe has
  // failed, which a still finger only does on release, so the menu opened
  // after lifting. Racing, the hold wins at its duration and a sideways drag
  // wins as soon as it moves.
  const gesture = enableSwipeReply ? Gesture.Race(panGesture, longPress) : longPress;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        entering={entering}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
      >
        {enableSwipeReply ? (
          <Animated.View pointerEvents="none" style={[styles.replyIcon, iconStyle]}>
            <NativeSymbol ios="arrowshape.turn.up.left" android="arrow-undo" size={18} />
          </Animated.View>
        ) : null}
        <Animated.View style={pressStyle}>{children}</Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  replyIcon: {
    position: "absolute",
    left: -(SWIPE_REPLY_THRESHOLD_PX - 8),
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
});

/**
 * 7b for a message that is not a narration bubble (a card, a question, a
 * routine run): the same fade and rise, with no gesture of its own so the
 * card's buttons keep their taps. Transforms and opacity only, so the
 * inverted list keeps its anchor.
 */
export function MessageArrival({
  isNew,
  enterDelayMs = 0,
  children,
}: {
  isNew: boolean;
  enterDelayMs?: number;
  children: ReactNode;
}) {
  const reducedMotion = useChatReducedMotion();
  const entering = isNew ? arrivalEntrance("bot", enterDelayMs, reducedMotion) : undefined;
  return <Animated.View entering={entering}>{children}</Animated.View>;
}

/** 7a (a sent bubble pops up) and 7b (a bot's message fades and rises); a plain fade under reduced motion. */
function arrivalEntrance(
  variant: AnimatedMessageBubbleVariant,
  delayMs: number,
  reducedMotion: boolean,
) {
  if (reducedMotion) {
    return entrance({
      from: { opacity: 0 },
      timing: { duration: CHAT_MOTION.reducedFadeMs },
      delayMs,
    });
  }
  return variant === "bot"
    ? entrance({
        from: { opacity: 0, translateY: CHAT_MOTION.botEnterTranslateY },
        timing: { duration: CHAT_MOTION.botEnterMs, easing: CHAT_MOTION.botEnterEasing },
        delayMs,
      })
    : entrance({
        from: {
          opacity: 0,
          translateY: CHAT_MOTION.userEnterTranslateY,
          scale: CHAT_MOTION.userEnterScaleFrom,
        },
        timing: { duration: CHAT_MOTION.botEnterMs },
        spring: CHAT_MOTION.userEnterSpring,
      });
}
