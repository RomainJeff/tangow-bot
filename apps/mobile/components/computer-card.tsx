import type { MessageBlock } from "@rakazo/contracts";
import { radii, sizes } from "@rakazo/ui-tokens";
import { StyleSheet, Text, View, type ViewProps } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { CapsuleButton } from "./AskActions";
import { NativeSymbol } from "./native-symbol";
import { Surface } from "./surface";

/**
 * The computer's state, and what it is doing, on the bot's paper. `onOpen` is set only on the
 * live Needs you card. Mirrors `ComputerCard` in `apps/web/src/pages/shell/block-views.tsx`.
 */
export function ComputerCard({
  block,
  onOpen,
  accessibilityActions,
  onAccessibilityAction,
}: {
  block: Extract<MessageBlock, { kind: "computer" }>;
  onOpen?: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const needsYou = block.state === "Needs you";
  return (
    <Surface style={styles.card}>
      <View style={styles.tile}>
        <NativeSymbol ios="desktopcomputer" android="desktop-outline" size={18} />
      </View>
      <View style={styles.body}>
        <Text
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
          style={styles.title}
        >
          {t("Computer")}
        </Text>
        <Text style={styles.text} numberOfLines={3}>
          {block.text}
        </Text>
      </View>
      {onOpen && needsYou ? (
        // The capsule stretches to fill a column; in this row it sits centred instead.
        <View style={styles.action}>
          <CapsuleButton
            kind="primary"
            height={sizes.capsule}
            label={t("Open")}
            accessibilityLabel={t("Open computer")}
            onPress={onOpen}
          />
        </View>
      ) : (
        <View style={styles.state}>
          {needsYou ? <View style={styles.dot} /> : null}
          <Text style={needsYou ? styles.stateLive : styles.stateQuiet}>{block.state}</Text>
        </View>
      )}
    </Surface>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      width: "100%",
      maxWidth: sizes.linkCard,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    tile: {
      width: 36,
      height: 36,
      borderRadius: radii.row,
      backgroundColor: tokens.well,
      alignItems: "center",
      justifyContent: "center",
    },
    body: { flex: 1, minWidth: 0 },
    title: { color: tokens.foreground, ...nativeTextStyle("rowName", { weight: 600 }) },
    text: { color: tokens.mutedForeground, ...nativeTextStyle("meta") },
    action: { alignSelf: "center" },
    state: { flexDirection: "row", alignItems: "center", gap: 6 },
    dot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: tokens.foreground },
    stateLive: { color: tokens.foreground, ...nativeTextStyle("blockHeader") },
    stateQuiet: { color: tokens.mutedForeground, ...nativeTextStyle("blockHeader") },
  });
}
