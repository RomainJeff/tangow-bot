import type { MemoryDocument } from "@tangow/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LoadFailed } from "../components/bot-page/kit";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useBotPageContext } from "../lib/bot-page";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { nativeTextStyle } from "../lib/typography";

type Read = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; doc: MemoryDocument };

/**
 * One memory document with explicit Save and Cancel: a save on leaving after an
 * accidental clear would wipe the bot's memory with no history. An archived bot's
 * document only reads, with Close alone.
 */
export default function BotMemoryScreen() {
  const { botId = "", documentId = "" } = useLocalSearchParams<{
    botId: string;
    documentId: string;
  }>();
  const styles = useThemedStyles(createMemoryStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  // Read only until the bot is known, so an archived bot never opens editable.
  const readOnly = useBotPageContext(botId)?.readOnly !== false;
  const insets = useSafeAreaInsets();
  // The keyboard covers the bottom inset the safe area already pads.
  const keyboardInset = useKeyboardState((state) =>
    state.isVisible ? Math.max(0, state.height - insets.bottom) : 0,
  );
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    // The owner's memory of the bot, or its team memory.
    rpc<MemoryDocument[]>("memory/list", { botId })
      .then((docs) => {
        if (cancelled) return;
        const doc = docs.find((item) => item.id === documentId);
        // A document that is gone (removed by the bot) leaves the list showing.
        if (!doc) {
          router.back();
          return;
        }
        setRead({ kind: "ready", doc });
        setDraft(doc.content);
      })
      .catch(() => {
        if (!cancelled) setRead({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, documentId, attempt]);

  const doc = read.kind === "ready" ? read.doc : null;
  const dirty = doc !== null && draft !== doc.content;
  const save = async () => {
    if (!doc || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await rpc<MemoryDocument>("memory/update", { documentId: doc.id, content: draft });
      // Only this sheet may close: a back after it is gone would pop the bot page.
      if (mounted.current) router.back();
    } catch (error) {
      if (!mounted.current) return;
      setFailed(serverMessage(error) || t("Could not save"));
      setBusy(false);
    }
  };
  const cancel = () => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert(t("Discard changes?"), undefined, [
      { text: t("Keep editing"), style: "cancel" },
      { text: t("Discard"), style: "destructive", onPress: () => router.back() },
    ]);
  };

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen
        options={{
          title: doc?.path ?? t("Memory"),
          headerBackVisible: false,
          // Unsaved edits or a save in flight close only through Cancel or Save.
          gestureEnabled: !busy && !dirty,
          unstable_headerLeftItems: () => [
            readOnly
              ? {
                  type: "button",
                  label: t("Close"),
                  variant: "plain",
                  onPress: () => router.back(),
                }
              : {
                  type: "button",
                  label: t("Cancel"),
                  variant: "plain",
                  disabled: busy,
                  onPress: cancel,
                },
          ],
          unstable_headerRightItems: () =>
            readOnly
              ? []
              : [
                  {
                    type: "button",
                    label: busy ? t("Saving…") : t("Save"),
                    variant: "done",
                    disabled: busy || !dirty,
                    onPress: () => void save(),
                  },
                ],
        }}
      />
      {read.kind === "failed" ? (
        <LoadFailed
          onRetry={() => {
            setRead({ kind: "loading" });
            setAttempt((value) => value + 1);
          }}
        />
      ) : doc ? (
        <View style={[styles.screen, { paddingBottom: keyboardInset }]}>
          {failed ? <Text style={styles.error}>{failed}</Text> : null}
          <TextInput
            accessibilityLabel={doc.path}
            value={draft}
            onChangeText={setDraft}
            editable={!readOnly && !busy}
            multiline
            textAlignVertical="top"
            placeholderTextColor={tokens.mutedForeground}
            style={styles.field}
          />
        </View>
      ) : (
        <View />
      )}
    </SafeAreaView>
  );
}

function createMemoryStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    error: {
      paddingHorizontal: 20,
      paddingTop: 12,
      color: tokens.destructive,
      ...nativeTextStyle("meta", { size: 14 }),
    },
    field: {
      flex: 1,
      paddingHorizontal: 20,
      paddingVertical: 16,
      color: tokens.foreground,
      ...nativeTextStyle("body", { size: 16, leading: 1.5 }),
    },
  });
}
