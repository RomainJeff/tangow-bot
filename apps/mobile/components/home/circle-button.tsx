import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { useThemedStyles } from "../../lib/native";
import { createHomeStyles } from "./styles";

export function CircleButton({
  children,
  onPress,
  accessibilityLabel,
  active = false,
  accent = false,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  active?: boolean;
  accent?: boolean;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.circleButton,
        accent && active ? styles.circleAccent : (active || pressed) && styles.circlePressed,
      ]}
    >
      {children}
    </Pressable>
  );
}
