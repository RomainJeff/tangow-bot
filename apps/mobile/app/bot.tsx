import type { Routine } from "@rakazo/contracts";
import { routineFailing } from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ActivityTab } from "../components/bot-page/activity-tab";
import { BotHero, BotTabs } from "../components/bot-page/hero";
import { LoadFailed, useFocusedRead } from "../components/bot-page/kit";
import { KnowledgeTab } from "../components/bot-page/knowledge-tab";
import { RoutinesTab } from "../components/bot-page/routines-tab";
import { SettingsTab } from "../components/bot-page/settings-tab";
import { NativeSymbol } from "../components/native-symbol";
import { rpc } from "../lib/api";
import { runDestination } from "../lib/bot-activity";
import { archiveBot, confirmClearConversation, confirmDeleteBot } from "../lib/bot-lifecycle";
import { readBotPage, readViewer, useBotPageContext } from "../lib/bot-page";
import { botRunEpoch, subscribeBotRunEnds } from "../lib/bot-page-state";
import type { BotTab } from "../lib/bot-tab";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

/**
 * The bot's page, pushed from its thread: who it is at the top, then Activity, Routines, Knowledge
 * and Settings. Every field saves itself. Opened as its settings (`tab`), it lands on Settings.
 */
export default function BotPageScreen() {
  const { botId = "", tab } = useLocalSearchParams<{ botId: string; tab?: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const page = useBotPageContext(botId);
  const [readFailed, setReadFailed] = useState(false);
  const [view, setView] = useState<BotTab>(tab === "settings" ? "settings" : "activity");
  const scroll = useRef<ScrollView>(null);
  /** Open work's add field is the page's last row: bring it above the keyboard it opens. */
  const revealEnd = useCallback(() => {
    if (Keyboard.isVisible()) {
      scroll.current?.scrollToEnd();
      return;
    }
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      shown.remove();
      scroll.current?.scrollToEnd();
    });
    setTimeout(() => shown.remove(), 1000);
  }, []);
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
  const routines = useFocusedRead(() => rpc<Routine[]>("routines/list", { botId }), [botId, epoch]);
  const routineFailed = routines.read.kind === "ready" && routines.read.value.some(routineFailing);

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
        ref={scroll}
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
              <BotTabs value={view} onChange={setView} routineFailed={routineFailed} />
              {view === "activity" ? (
                <ActivityTab
                  botId={page.bot.id}
                  epoch={epoch}
                  // An archived bot's chat cannot be opened, nor its routines or instructions.
                  onOpenRun={
                    page.readOnly ? undefined : (row) => router.dismissTo(runDestination(row))
                  }
                  onOpenRoutine={
                    page.readOnly
                      ? undefined
                      : (routineId) =>
                          router.push({
                            pathname: "/routine",
                            params: { botId: page.bot.id, botName: page.bot.name, routineId },
                          })
                  }
                  onWriteInstructions={
                    page.readOnly || page.bot.instructions
                      ? undefined
                      : () =>
                          router.push({
                            pathname: "/bot-text",
                            params: { botId: page.bot.id, field: "instructions" },
                          })
                  }
                />
              ) : view === "routines" ? (
                <RoutinesTab
                  page={page}
                  epoch={epoch}
                  onOpen={(routine) =>
                    router.push({
                      pathname: "/bot-routine",
                      params: { botId, routineId: routine.id },
                    })
                  }
                  onCreate={() => router.push({ pathname: "/bot-routine-new", params: { botId } })}
                />
              ) : view === "knowledge" ? (
                <KnowledgeTab page={page} epoch={epoch} onAddFocus={revealEnd} />
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
