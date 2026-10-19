import { Pressable, StyleSheet, Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";

/** A selectable filter or option pill. */
export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createChipStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.label, on && styles.labelOn]}>{label}</Text>
    </Pressable>
  );
}

function createChipStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    chip: {
      minHeight: 32,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
    chipOn: { backgroundColor: tokens.primary },
    label: { color: native.secondaryLabel, fontSize: 13 },
    labelOn: { color: tokens.primaryForeground },
  });
}
