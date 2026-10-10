import { useEffect } from "react";
import { AccessibilityInfo, Platform, StyleSheet, Text } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { useThemedStyles } from "../../lib/native";
import { nativeTextStyle } from "../../lib/typography";

/**
 * Why something was refused, under the control that refused it. A live region only speaks on
 * Android, so VoiceOver is told each new error out loud.
 */
export function SpokenError({ children }: { children: string | null }) {
  const styles = useThemedStyles(createSpokenErrorStyles);
  useEffect(() => {
    if (children && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(children);
  }, [children]);
  if (!children) return null;
  return (
    <Text style={styles.error} accessibilityLiveRegion="polite">
      {children}
    </Text>
  );
}

function createSpokenErrorStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    error: {
      paddingHorizontal: 16,
      color: tokens.destructive,
      ...nativeTextStyle("meta", { size: 14 }),
    },
  });
}
