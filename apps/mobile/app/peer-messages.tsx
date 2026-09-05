import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { peerConversations } from "@rakazo/core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

/**
 * View-only transcript of a bot-to-bot exchange, opened from a
 * Messaged / Message from chip in the human thread. Web counterpart:
 * apps/web/src/pages/PeerMessagesOverlay.tsx.
 */
export default function PeerMessages() {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const { botId, botName, botColor, peerBotId, peerBotName, peerColor } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    botColor?: string;
    peerBotId?: string;
    peerBotName?: string;
    peerColor?: string;
  }>();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId || !peerBotId) {
      setError(t("This chat link is incomplete"));
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      let before: number | undefined;
      let collected: ThreadMessage[] = [];
      do {
        const page = await rpc<ThreadMessagePage>("threads/messages", {
          botId,
          ...(before === undefined ? {} : { before }),
          includePeerRuns: true,
        });
        if (cancelled) return;
        collected = [...page.messages, ...collected];
        before = page.olderCursor ?? undefined;
      } while (before !== undefined);
      if (cancelled) return;
      setMessages(collected);
      setLoading(false);
    })().catch((loadError) => {
      if (cancelled) return;
      setError(loadError instanceof Error ? loadError.message : t("Could not load this chat"));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [botId, peerBotId]);

  const conversation = useMemo(
    () => peerConversations(messages).find((entry) => entry.peerBotId === peerBotId) ?? null,
    [messages, peerBotId],
  );
  const peer = conversation?.peerBotName ?? peerBotName ?? t("Bot");
  const own = botName ?? t("Bot");

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, gap: 10 }}
    >
      <Stack.Screen options={{ title: `${own} · ${peer}` }} />
      {loading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
      {!loading && !error && !conversation?.messages.length ? (
        <Text
          style={{
            color: tokens.mutedForeground,
            fontSize: 13.5,
            textAlign: "center",
            padding: 24,
          }}
        >
          {t("No messages with {peer} yet.", { peer })}
        </Text>
      ) : null}
      {conversation?.messages.map((peerMessage, index) => {
        const sent = peerMessage.direction === "sent";
        return (
          <View
            key={`${peerMessage.messageId}-${index}`}
            style={{ flexDirection: "row", justifyContent: sent ? "flex-end" : "flex-start" }}
          >
            <View
              style={{
                maxWidth: "85%",
                borderRadius: 20,
                padding: 12,
                gap: 4,
                backgroundColor: sent ? tokens.accent : tokens.muted,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <BotAvatar
                  color={(sent ? botColor : peerColor) ?? tokens.mutedForeground}
                  identity={sent ? botId : peerBotId}
                  size={14}
                />
                <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                  {sent ? own : peer}
                </Text>
              </View>
              <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
            </View>
          </View>
        );
      })}
      {conversation?.messages.length ? (
        <Text
          style={{
            color: tokens.mutedForeground,
            fontSize: 13,
            textAlign: "center",
            paddingTop: 8,
          }}
        >
          {t("This chat is view-only")}
        </Text>
      ) : null}
    </ScrollView>
  );
}
