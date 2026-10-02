import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/native";
import type { ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { mergeMessagesById } from "@rakazo/core";
import { sizes } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { visibleMessageBlocks } from "../lib/message-presentation";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";
import { UserBubble } from "./user-bubble";

/** How much of the window the conversation may take; the sheet scrolls beyond it. */
const BODY_HEIGHT_RATIO = 0.75;

function messageText(message: ThreadMessage): string {
  return visibleMessageBlocks(message.blocks)
    .map((block) => ("text" in block ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * A specialist's own thread, read-only, in the native sheet: the conversation the owner can
 * follow but never write to. The server derives the thread from the task.
 */
export function WorkThreadSheet({
  workId,
  name,
  close,
}: {
  workId: string;
  name: string;
  close: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { height } = useWindowDimensions();
  const [page, setPage] = useState<ThreadMessagePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void rpc<ThreadMessagePage>("works/thread", { workId })
      .then((next) => {
        if (!cancelled) setPage(next);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : t("Could not load this chat"));
      });
    return () => {
      cancelled = true;
    };
  }, [workId, t]);

  async function loadOlder() {
    if (!page || page.olderCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await rpc<ThreadMessagePage>("works/thread", {
        workId,
        before: page.olderCursor,
      });
      setPage({
        ...older,
        messages: mergeMessagesById(older.messages, page.messages),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not load this chat"));
    } finally {
      setLoadingOlder(false);
    }
  }

  const messages = (page?.messages ?? []).filter((message) => messageText(message));
  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Close")}
          hitSlop={8}
          onPress={close}
          style={styles.close}
        >
          <NativeSymbol ios="xmark" android="close" size={sizes.row} />
        </Pressable>
        <Text numberOfLines={1} style={styles.title}>
          {name}
        </Text>
      </View>
      {page === null && !error ? (
        <ActivityIndicator style={styles.loading} color={tokens.mutedForeground} />
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {page ? (
        <ScrollView
          style={[styles.body, { maxHeight: height * BODY_HEIGHT_RATIO }]}
          contentContainerStyle={styles.messages}
        >
          {page.olderCursor !== null ? (
            <Pressable
              accessibilityRole="button"
              disabled={loadingOlder}
              onPress={() => void loadOlder()}
              style={styles.earlier}
            >
              <Text style={styles.earlierLabel}>
                {loadingOlder ? t("Loading…") : t("Load earlier messages")}
              </Text>
            </Pressable>
          ) : null}
          {messages.map((message) =>
            message.role === "bot" ? (
              <ChatMarkdown
                key={message.id}
                allowImages={false}
                palette={tokens}
                colorScheme={colorScheme}
              >
                {truncateMarkdownForRender(messageText(message))}
              </ChatMarkdown>
            ) : (
              <UserBubble key={message.id} selectable>
                {messageText(message)}
              </UserBubble>
            ),
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { padding: 16 },
    header: { flexDirection: "row", alignItems: "center", gap: 8, height: sizes.mobileStack },
    close: { padding: 8 },
    title: { flexShrink: 1, color: tokens.popoverForeground, ...nativeTextStyle("rowName") },
    loading: { marginVertical: 24 },
    error: { paddingTop: 8, color: tokens.mutedForeground, ...nativeTextStyle("meta") },
    body: { flexGrow: 0, flexShrink: 0 },
    messages: { gap: 14, paddingTop: 8 },
    earlier: { alignSelf: "center", paddingVertical: 10 },
    earlierLabel: { color: tokens.mutedForeground, ...nativeTextStyle("meta") },
  });
}
