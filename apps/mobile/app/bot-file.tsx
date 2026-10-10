import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { LoadingRows, QuietLine } from "../components/bot-page/kit";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

type Read =
  | { kind: "loading" }
  | { kind: "failed"; reason: string }
  | { kind: "ready"; content: string };

/** One of the bot's working files, read only. */
export default function BotFileScreen() {
  const { botId = "", path = "" } = useLocalSearchParams<{ botId: string; path: string }>();
  const styles = useThemedStyles(createFileStyles);
  const { t } = useI18n();
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const name = path.split("/").filter(Boolean).at(-1) ?? path;

  useEffect(() => {
    let cancelled = false;
    rpc<{ path: string; content: string }>("computer/readFile", { botId, path })
      .then((file) => {
        if (!cancelled) setRead({ kind: "ready", content: file.content });
      })
      .catch((error: unknown) => {
        // A binary file fails the server's UTF-8 decode; an oversized one says so.
        if (!cancelled) {
          setRead({
            kind: "failed",
            reason: error instanceof Error ? error.message : t("Could not read this file"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [botId, path, t]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: name }} />
      {read.kind === "loading" ? (
        <LoadingRows />
      ) : read.kind === "failed" ? (
        <QuietLine>{read.reason}</QuietLine>
      ) : (
        <Text selectable style={styles.text}>
          {read.content}
        </Text>
      )}
    </ScrollView>
  );
}

function createFileStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { padding: 20 },
    text: { color: tokens.foreground, ...nativeTextStyle("mono", { size: 13, leading: 1.5 }) },
  });
}
