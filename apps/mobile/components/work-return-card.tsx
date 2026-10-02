import type { WorkReturn } from "@rakazo/core";
import { workReturnState } from "@rakazo/core";
import { sizes } from "@rakazo/ui-tokens";
import { StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { workStateColor, workStateGlyph, workStateLabel } from "../lib/work-cards";
import { NativeSymbol } from "./native-symbol";
import { Surface } from "./surface";

/**
 * The specialist's work_return card: who produced the result and how its run ended, so a
 * failed specialist never reads as a success. The returned text follows as an ordinary
 * message. Mirrors the web `WorkReturnCard`.
 */
export function WorkReturnCard({
  workReturn,
  specialistName,
}: {
  workReturn: WorkReturn;
  specialistName: string;
}) {
  useI18n();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const state = workReturnState(workReturn.outcome);
  const label = state ? workStateLabel(state) : null;
  return (
    <Surface
      accessible
      accessibilityLabel={label ? `${specialistName}, ${label}` : specialistName}
      style={styles.card}
    >
      <View style={styles.row}>
        {state ? (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <NativeSymbol
              {...workStateGlyph(state)}
              size={sizes.receipt}
              color={workStateColor(state, tokens)}
            />
          </View>
        ) : null}
        <Text numberOfLines={1} style={styles.name}>
          {specialistName}
        </Text>
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </View>
    </Surface>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    card: { alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: 16, paddingVertical: 14 },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    name: {
      flexShrink: 1,
      color: tokens.foreground,
      ...nativeTextStyle("working", { weight: 600 }),
    },
    label: { color: tokens.mutedForeground, ...nativeTextStyle("working") },
  });
}
