import { radii } from "@tangow/ui-tokens";
import { StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

/**
 * What a routine card creates, as plain text: its name, when it runs, what it does and whether it
 * notifies. Mirrors the web card's preview (`apps/web/src/components/AskCard.tsx`).
 */
export function RoutineCardPreview({
  routine,
}: {
  routine: { name: string; schedule: string; prompt: string; notify: boolean };
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  return (
    <View style={styles.box}>
      <View style={styles.nameRow}>
        <NativeSymbol ios="repeat" android="repeat" size={13} color={tokens.foreground} />
        <Text style={styles.name}>{routine.name}</Text>
      </View>
      <Text style={styles.schedule}>{routine.schedule}</Text>
      <Text style={styles.prompt}>{routine.prompt}</Text>
      {routine.notify ? <Text style={styles.notify}>{t("Notifies you each run")}</Text> : null}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    box: {
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      backgroundColor: tokens.surface,
    },
    nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    name: { flexShrink: 1, color: tokens.foreground, ...nativeTextStyle("label") },
    schedule: { color: tokens.mutedForeground, ...nativeTextStyle("meta") },
    prompt: { marginTop: 4, color: tokens.foreground, ...nativeTextStyle("meta") },
    notify: { marginTop: 4, color: tokens.mutedForeground, ...nativeTextStyle("meta") },
  });
}
