/** How the skill screen reads what it shows, and says when that read failed. */
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { useThemedStyles } from "../../lib/native";
import { nativeTextStyle } from "../../lib/typography";

/** A tab whose read failed: "Could not load · Retry", the other tabs untouched. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const styles = useThemedStyles(createKitStyles);
  const { t } = useI18n();
  return (
    <Pressable accessibilityRole="button" onPress={onRetry} style={styles.quiet}>
      <Text style={styles.quietText}>{t("Could not load · Retry")}</Text>
    </Pressable>
  );
}

type Read<T> = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; value: T };

/** Reads `load` whenever the screen comes back into view; a failed refresh keeps what was shown. */
export function useFocusedRead<T>(load: () => Promise<T>, deps: unknown[]) {
  const [read, setRead] = useState<Read<T>>({ kind: "loading" });
  const reload = useCallback(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) setRead({ kind: "ready", value });
      },
      () => {
        if (!cancelled)
          setRead((current) => (current.kind === "ready" ? current : { kind: "failed" }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, deps);
  useFocusEffect(reload);
  const retry = () => {
    setRead({ kind: "loading" });
    reload();
  };
  return { read, setRead, retry };
}

function createKitStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    quiet: { paddingVertical: 32, alignItems: "center" },
    quietText: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 15 }),
      textAlign: "center",
    },
  });
}
