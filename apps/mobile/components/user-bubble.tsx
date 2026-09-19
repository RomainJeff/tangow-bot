import { radii } from "@rakazo/ui-tokens";
import type { TextProps } from "react-native";
import { StyleSheet, Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

export type UserBubbleProps = TextProps;

/**
 * What the person said, the only filled bubble of the thread. Mirrors
 * `packages/ui-web/src/user-bubble.tsx`; mobile caps the width at 84% and uses
 * 16/1.45 prose per design contract §3.7, vs the web 78% and 16.5/1.58.
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
      maxWidth: "84%",
      borderRadius: radii.bubble,
      backgroundColor: tokens.chatUser,
      color: tokens.chatUserForeground,
      paddingHorizontal: 17,
      paddingVertical: 11,
      ...nativeTextStyle("body", { size: 16, leading: 1.45 }),
    },
  });
}
