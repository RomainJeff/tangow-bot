import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { BotHero, BotTabs } from "../components/bot-page/hero";
import { LoadFailed } from "../components/bot-page/kit";
import { KnowledgeTab } from "../components/bot-page/knowledge-tab";
import { SettingsTab } from "../components/bot-page/settings-tab";
import { NativeSymbol } from "../components/native-symbol";
import { rpc } from "../lib/api";
import { archiveBot, confirmClearConversation, confirmDeleteBot } from "../lib/bot-lifecycle";
import { readBotPage, readViewer, useBotPageContext } from "../lib/bot-page";
import { botRunEpoch, subscribeBotRunEnds } from "../lib/bot-page-state";
import type { BotTab } from "../lib/bot-tab";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

/** The bot's page, pushed from its thread: who it is at the top, then Knowledge and Settings. Every field saves itself. */
export default function BotPageScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const page = useBotPageContext(botId);
  const [readFailed, setReadFailed] = useState(false);
  const [view, setView] = useState<BotTab>("settings");
  const epoch = useSyncExternalStore(
    subscribeBotRunEnds,
    () => botRunEpoch(botId),
    () => botRunEpoch(botId),
  );

  // Freshness: the bot may change its own settings mid-run. A new `epoch` (a run ended) makes a
  // new callback, which the focused page runs again and a covered page runs when it comes back.
  const refresh = useCallback(() => {
    if (!botId) return;
    void Promise.all([readBotPage(botId), readViewer()]).then(
      () => setReadFailed(false),
      () => setReadFailed(true),
    );
  }, [botId, epoch]);
  useFocusEffect(refresh);

  const leave = () => {
    router.dismissAll();
    router.replace("/");
  };
  const showActions = () => {
    if (!page) return;
    presentMessageActionSheet({
      actions: [
        {
          text: t("Clear conversation"),
          destructive: true,
          onPress: () =>
            confirmClearConversation(() => {
              void rpc("threads/clear", { botId }).catch((error: unknown) =>
                Alert.alert(
                  t("Could not clear conversation"),
                  error instanceof Error ? error.message : t("Try again."),
                ),
              );
            }),
        },
        { text: t("Archive"), onPress: () => archiveBot(botId, leave) },
        {
          text: t("Delete…"),
          destructive: true,
          onPress: () => confirmDeleteBot({ id: botId, name: page.bot.name }, leave),
        },
      ],
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () =>
            page && !page.readOnly ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Actions for {name}", { name: page.bot.name })}
                hitSlop={10}
                onPress={showActions}
              >
                <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
              </Pressable>
            ) : null,
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        {page ? (
          <>
            <BotHero
              page={page}
              onAppearance={() =>
                router.push({ pathname: "/bot-appearance", params: { botId: page.bot.id } })
              }
            />
            <View style={styles.body}>
              <BotTabs value={view} onChange={setView} />
              {view === "knowledge" ? (
                <KnowledgeTab page={page} epoch={epoch} />
              ) : (
                <SettingsTab page={page} />
              )}
            </View>
          </>
        ) : readFailed ? (
          <LoadFailed onRetry={refresh} />
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 20, gap: 28 },
});
