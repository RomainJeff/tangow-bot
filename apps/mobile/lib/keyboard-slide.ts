import { useLayoutEffect } from "react";
import { useKeyboardContext, useKeyboardHandler } from "react-native-keyboard-controller";
import { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

/**
 * Moves a view that reaches the bottom of the screen with the keyboard through a transform, and
 * makes room for the keyboard in its layout only once the keyboard settles. The library's
 * `translate-with-padding` sets the iOS transform once when the keyboard starts, which jumped the
 * composer ahead of the keyboard; `onMove` keeps it on the keyboard's edge. `overlap` is how far the
 * keyboard may cover the view's bottom padding, so the view keeps one padding open or closed.
 */
export function useKeyboardSlide(enabled: boolean, overlap: number) {
  const { reanimated } = useKeyboardContext();
  const keyboardHeight = useSharedValue(0);
  const reservedHeight = useSharedValue(0);

  useLayoutEffect(() => {
    keyboardHeight.value = Math.max(0, -reanimated.height.value - overlap);
    reservedHeight.value = keyboardHeight.value;
  }, []);

  useKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        if (event.height === 0) reservedHeight.value = 0;
      },
      onMove: (event) => {
        "worklet";
        keyboardHeight.value = Math.max(0, event.height - overlap);
      },
      onInteractive: (event) => {
        "worklet";
        reservedHeight.value = 0;
        keyboardHeight.value = Math.max(0, event.height - overlap);
      },
      onEnd: (event) => {
        "worklet";
        keyboardHeight.value = Math.max(0, event.height - overlap);
        reservedHeight.value = keyboardHeight.value;
      },
    },
    [overlap],
  );

  // Reanimated resends a whole style when it changes: the layout prop gets its own, so it is not
  // sent on every keyboard frame.
  const layout = useAnimatedStyle(() => ({ marginBottom: reservedHeight.value }));
  const motion = useAnimatedStyle(() => ({
    transform: [{ translateY: reservedHeight.value - keyboardHeight.value }],
  }));
  return enabled ? [layout, motion] : undefined;
}
