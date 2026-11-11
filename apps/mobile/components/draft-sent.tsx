import type { AskDraft } from "@tangow/contracts";
import { draftSentLine, draftSentTo } from "@tangow/core";
import { StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { AppLogo } from "./app-logo";
import { NativeSymbol } from "./native-symbol";

// The marker a translated line carries where the styled recipient goes.
const RECIPIENT_SLOT = "\u0000";
const DISC = 32;
const DISC_GAP = 12;

/**
 * A sent draft on the bot's paper: the success disc leads, then who it went to and the one line
 * the message keeps, behind its app's mark. Mirrors `apps/web/src/components/DraftSent.tsx`.
 */
export function DraftSent({ draft, time }: { draft: AskDraft; time: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  // One message holds the whole line, so a translation can put the recipient where it belongs.
  const [before = "", after = ""] = t("to {recipient}", { recipient: RECIPIENT_SLOT }).split(
    RECIPIENT_SLOT,
  );
  const toLine = { before, after };
  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <View accessibilityElementsHidden style={styles.disc}>
          <NativeSymbol
            ios="checkmark"
            android="checkmark"
            size={16}
            color={tokens.primaryForeground}
          />
        </View>
        <View style={styles.lines}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{t("Sent")}</Text>
            <Text style={styles.time}>{time}</Text>
          </View>
          <Text numberOfLines={1} style={styles.to}>
            {toLine.before}
            <Text style={styles.recipient}>{draftSentTo(draft)}</Text>
            {toLine.after}
          </Text>
        </View>
      </View>
      <View style={styles.message}>
        <AppLogo app={draft.app} chat={draft.chat === true} />
        <Text numberOfLines={1} style={styles.messageText}>
          {draftSentLine(draft)}
        </Text>
      </View>
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    root: { flex: 1, minWidth: 0, gap: 12 },
    head: { flexDirection: "row", alignItems: "center", gap: DISC_GAP },
    disc: {
      width: DISC,
      height: DISC,
      borderRadius: DISC / 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.success,
    },
    lines: { flex: 1, minWidth: 0 },
    titleRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    title: {
      color: tokens.foreground,
      ...nativeTextStyle("title", { size: 17, leading: 22 / 17 }),
    },
    time: { color: tokens.mutedForeground, ...nativeTextStyle("time") },
    to: { color: tokens.mutedForeground, ...nativeTextStyle("meta") },
    recipient: { color: tokens.foreground },
    // Under the text column, as the title and the recipient above it.
    message: { flexDirection: "row", alignItems: "center", gap: 8, paddingStart: DISC + DISC_GAP },
    messageText: {
      flex: 1,
      color: tokens.foreground,
      ...nativeTextStyle("rowName", { size: 15, leading: 20 / 15 }),
    },
  });
}
