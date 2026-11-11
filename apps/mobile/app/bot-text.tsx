import { BOT_DESCRIPTION_MAX_LENGTH, BOT_INSTRUCTIONS_MAX_LENGTH } from "@tangow/contracts";
import { decideTextCommit } from "@tangow/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SaveMeta } from "../components/bot-page/kit";
import { mobileTokens } from "../lib/appearance";
import { type BotPageContext, useBotPageContext, useBotSetting } from "../lib/bot-page";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

type TextField = "instructions" | "description";

/** Instructions or Description, edited full screen; Done saves, Cancel asks before dropping changes. */
export default function BotTextScreen() {
  const { botId = "", field } = useLocalSearchParams<{ botId: string; field?: string }>();
  const page = useBotPageContext(botId);
  const kind: TextField = field === "description" ? "description" : "instructions";
  return page ? <TextEditor key={kind} page={page} kind={kind} /> : null;
}

function TextEditor({ page, kind }: { page: BotPageContext; kind: TextField }) {
  const styles = useThemedStyles(createTextStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // The keyboard covers the bottom inset the safe area already pads.
  const keyboardInset = useKeyboardState((state) =>
    state.isVisible ? Math.max(0, state.height - insets.bottom) : 0,
  );
  const save = useBotSetting(page, kind);
  const instructions = kind === "instructions";
  const maxLength = instructions ? BOT_INSTRUCTIONS_MAX_LENGTH : BOT_DESCRIPTION_MAX_LENGTH;
  // A draft from earlier in this session comes back, unless the server text moved since it began.
  const [text, setText] = useState(() =>
    save.draft && !save.conflict ? save.draft.value : save.value,
  );
  const [restorable, setRestorable] = useState(save.conflict);
  // Focusing puts the caret at the end and scrolls there; existing text opens at its start instead.
  const [focusOnOpen] = useState(() => text.trim() === "");
  const saving = save.state.kind === "saving";
  const changed = text.trim() !== save.value.trim();

  const edit = (next: string) => {
    setText(next);
    save.setDraft(next.trim() === save.value.trim() ? null : next);
    if (save.state.kind === "failed") save.dismiss();
  };

  const commit = async () => {
    const decision = decideTextCommit(save.value, text, { confirmClear: true });
    if (decision === "confirm") {
      const cleared = await new Promise<boolean>((resolve) =>
        Alert.alert(instructions ? t("Clear instructions?") : t("Clear description?"), undefined, [
          { text: t("Cancel"), style: "cancel", onPress: () => resolve(false) },
          { text: t("Clear"), style: "destructive", onPress: () => resolve(true) },
        ]),
      );
      if (!cleared) return;
    }
    if (decision !== "skip") {
      await save.save(text.trim());
      // A failure keeps the editor open with Retry.
      if (save.current().kind === "failed") return;
    }
    save.setDraft(null);
    router.back();
  };

  const done = () => void commit();

  const cancel = () => {
    if (!changed) {
      save.setDraft(null);
      router.back();
      return;
    }
    Alert.alert(t("Discard changes?"), undefined, [
      { text: t("Keep editing"), style: "cancel" },
      {
        text: t("Discard"),
        style: "destructive",
        onPress: () => {
          save.setDraft(null);
          if (save.state.kind === "failed") save.dismiss();
          router.back();
        },
      },
    ]);
  };

  const count = new Intl.NumberFormat(dateLocaleForUi());
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen
        options={{
          title: instructions ? t("Instructions") : t("Description"),
          headerBackVisible: false,
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: t("Cancel"),
              variant: "plain",
              disabled: saving,
              onPress: cancel,
            },
          ],
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: saving ? t("Saving…") : t("Done"),
              variant: "done",
              disabled: saving || page.readOnly,
              onPress: done,
            },
          ],
        }}
      />
      <View style={[styles.screen, { paddingBottom: keyboardInset }]}>
        <TextInput
          accessibilityLabel={instructions ? t("Instructions") : t("Description")}
          value={text}
          onChangeText={edit}
          editable={!saving && !page.readOnly}
          multiline
          autoFocus={focusOnOpen}
          maxLength={maxLength}
          placeholder={instructions ? t("How this bot should behave") : t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          textAlignVertical="top"
          scrollEnabled
          style={styles.field}
        />
        <View style={styles.footer}>
          <View style={styles.footerStart}>
            {restorable && save.draft ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => {
                  if (save.draft) setText(save.draft.value);
                  setRestorable(false);
                }}
              >
                <Text style={styles.restore}>{t("Restore unsaved text")}</Text>
              </Pressable>
            ) : (
              <SaveMeta state={save.state} onRetry={done} />
            )}
          </View>
          <Text style={styles.counter}>
            {count.format(text.length)} / {count.format(maxLength)}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

function createTextStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    field: {
      flex: 1,
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 16,
      color: tokens.foreground,
      ...nativeTextStyle("body", { size: 17, leading: 1.5 }),
    },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 44,
      paddingHorizontal: 20,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: tokens.border,
    },
    footerStart: { flex: 1 },
    restore: { color: tokens.foreground, ...nativeTextStyle("meta", { size: 14, weight: 500 }) },
    counter: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("mono", { size: 12 }),
      fontVariant: ["tabular-nums"],
    },
  });
}
