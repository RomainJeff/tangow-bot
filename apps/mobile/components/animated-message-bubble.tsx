import type { ReactNode } from "react";
import { useEffect } from "react";
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
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";
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
  /** Keeps the entrance and drops the hold, for a child that handles its own long press. */
  entranceOnly?: boolean;
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
  entranceOnly = false,
  onSwipeReply,
  accessibilityActions,
  onAccessibilityAction,
  children,
}: AnimatedMessageBubbleProps) {
  const reducedMotion = useChatReducedMotion();

  const opacity = useSharedValue(isNew ? 0 : 1);
  const translateY = useSharedValue(
    isNew && variant === "bot" ? CHAT_MOTION.botEnterTranslateY : 0,
  );
  const enterTranslateY = useSharedValue(
    isNew && variant === "user" ? CHAT_MOTION.userEnterTranslateY : 0,
  );
  const enterScale = useSharedValue(
    isNew && variant === "user" ? CHAT_MOTION.userEnterScaleFrom : 1,
  );
  const pressScale = useSharedValue(1);
  const swipeX = useSharedValue(0);
  const iconScale = useSharedValue(0);
  const previousRawDx = useSharedValue(0);

  // Entrance, once, at mount — `isNew`/`variant` are fixed for this row's
  // lifetime (a new arrival always mounts a fresh component instance, keyed
  // by message id).
  useEffect(() => {
    if (!isNew) return;
    if (reducedMotion) {
      opacity.value = withDelay(
        enterDelayMs,
        withTiming(1, { duration: CHAT_MOTION.reducedFadeMs }),
      );
      return;
    }
    if (variant === "bot") {
      opacity.value = withDelay(
        enterDelayMs,
        withTiming(1, { duration: CHAT_MOTION.botEnterMs, easing: CHAT_MOTION.botEnterEasing }),
      );
      translateY.value = withDelay(
        enterDelayMs,
        withTiming(0, { duration: CHAT_MOTION.botEnterMs, easing: CHAT_MOTION.botEnterEasing }),
      );
    } else {
      opacity.value = withTiming(1, { duration: CHAT_MOTION.botEnterMs });
      enterTranslateY.value = withSpring(0, CHAT_MOTION.userEnterSpring);
      enterScale.value = withSpring(1, CHAT_MOTION.userEnterSpring);
    }
  }, []);

  const entranceStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform:
      variant === "bot"
        ? [{ translateY: reducedMotion ? 0 : translateY.value }]
        : [
            { translateY: reducedMotion ? 0 : enterTranslateY.value },
            { scale: reducedMotion ? 1 : enterScale.value },
          ],
  }));

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
    .enabled(!entranceOnly)
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
        style={entranceStyle}
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
  const opacity = useSharedValue(isNew ? 0 : 1);
  const translateY = useSharedValue(isNew ? CHAT_MOTION.botEnterTranslateY : 0);

  useEffect(() => {
    if (!isNew) return;
    if (reducedMotion) {
      opacity.value = withDelay(
        enterDelayMs,
        withTiming(1, { duration: CHAT_MOTION.reducedFadeMs }),
      );
      translateY.value = 0;
      return;
    }
    const timing = { duration: CHAT_MOTION.botEnterMs, easing: CHAT_MOTION.botEnterEasing };
    opacity.value = withDelay(enterDelayMs, withTiming(1, timing));
    translateY.value = withDelay(enterDelayMs, withTiming(0, timing));
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return <Animated.View style={style}>{children}</Animated.View>;
}
