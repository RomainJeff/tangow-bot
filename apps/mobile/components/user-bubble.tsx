import { radii } from "@rakazo/ui-tokens";
import type { Ref } from "react";
import type { TextProps } from "react-native";
import { StyleSheet, Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

export type UserBubbleProps = TextProps & { ref?: Ref<Text> };

/**
 * What the person said, one of the thread's two filled bubbles (the other is
 * the bot's `chatBot` bubble — design contract § Grouping). Mirrors
 * `packages/ui-web/src/user-bubble.tsx`; mobile caps the width at 78% and uses
 * 16/1.45 prose, vs the web 16/24.
 */
export function UserBubble({ style, ...props }: UserBubbleProps) {
  const styles = useThemedStyles(createUserBubbleStyles);
  return <Text style={[styles.bubble, style]} {...props} />;
}

function createUserBubbleStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    bubble: {
      alignSelf: "flex-end",
      maxWidth: "78%",
      borderRadius: radii.bubble,
      backgroundColor: tokens.chatUser,
      color: tokens.chatUserForeground,
      paddingHorizontal: 16,
      paddingVertical: 11,
      ...nativeTextStyle("body", { size: 16, leading: 1.45 }),
    },
  });
}
