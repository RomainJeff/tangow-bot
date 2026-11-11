import { motion } from "@tangow/ui-tokens";
import { useEffect, useRef } from "react";
import { ScrollView, Text } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** One word of the dictation preview, fading in over `motion.morph` (260 ms)
 * the first time it's mounted — frozen under reduced motion. Later
 * corrections to the same word (still interim) reuse this instance rather
 * than re-fading, since it keeps the same list index. */
function DictationWord({
  text,
  muted,
  trailingSpace,
}: {
  text: string;
  muted: boolean;
  trailingSpace: boolean;
}) {
  const tokens = useMobileTokens();
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(reducedMotion ? 1 : 0);

  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withTiming(1, { duration: motion.morph });
    // Fade in once, on mount only — a word already on screen must not re-fade
    // just because a sibling further along changed.
  }, []);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text style={[style, { color: muted ? tokens.mutedForeground : tokens.foreground }]}>
      {text}
      {trailingSpace ? " " : ""}
    </Animated.Text>
  );
}

/**
 * Read-only stand-in for the field's `TextInput` while dictating: the pre-dictation snapshot renders plainly, dictated words fade in
 * one at a time — final in `foreground`, the still-interim tail in
 * `mutedForeground`. Scrolls internally past the same 5-line height the
 * field itself caps at.
 */
export function DictationPreview({
  prefix,
  finalText,
  interimText,
}: {
  /** The pre-dictation draft plus its separator — rendered as-is, never animated. */
  prefix: string;
  finalText: string;
  interimText: string;
}) {
  const tokens = useMobileTokens();
  const finalWords = splitWords(finalText);
  const interimWords = splitWords(interimText);
  const scrollRef = useRef<ScrollView>(null);
  return (
    <ScrollView
      ref={scrollRef}
      style={{ maxHeight: 110 }}
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
    >
      <Text
        style={{
          color: tokens.foreground,
          writingDirection: "auto",
          ...nativeTextStyle("composer"),
        }}
      >
        {prefix}
        {finalWords.map((word, index) => (
          <DictationWord
            key={`f-${index}`}
            text={word}
            muted={false}
            trailingSpace={index < finalWords.length - 1 || interimWords.length > 0}
          />
        ))}
        {interimWords.map((word, index) => (
          <DictationWord
            key={`i-${index}`}
            text={word}
            muted
            trailingSpace={index < interimWords.length - 1}
          />
        ))}
      </Text>
    </ScrollView>
  );
}
