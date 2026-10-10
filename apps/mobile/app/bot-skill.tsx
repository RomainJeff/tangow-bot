import type { AgentSkill } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { LoadFailed, useFocusedRead } from "../components/bot-page/kit";
import { NativeSymbol } from "../components/native-symbol";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { nativeTextStyle } from "../lib/typography";

/**
 * One skill's SKILL.md, edited like a memory document with Cancel and Save.
 * The id changes when the name does, so the one a save returns is the one kept.
 */
export default function BotSkillScreen() {
  const { skillId: linked = "" } = useLocalSearchParams<{ skillId: string }>();
  const [skillId, setSkillId] = useState(linked);
  const styles = useThemedStyles(createSkillStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const router = useRouter();
  const { read, write, retry } = useFocusedRead(
    () => rpc<AgentSkill>("agentSkills/get", { skillId }),
    [skillId],
  );
  // A draft exists only while someone edits, so the field never shows or saves a text the
  // server no longer holds once the skill is read again.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const skill = read.kind === "ready" ? read.value : null;
  const content = skill?.content ?? null;
  const editing = draft !== null;
  const dirty = draft !== null && content !== null && draft !== content;
  const parsed = dirty && draft?.trim() ? parseSkillMd(draft) : null;
  const draftError = parsed && "error" in parsed ? parsed.error : null;

  const stopEditing = () => {
    Keyboard.dismiss();
    setDraft(null);
    setFailed(null);
  };
  const cancel = () => {
    if (!dirty) {
      stopEditing();
      return;
    }
    Alert.alert(t("Discard changes?"), undefined, [
      { text: t("Keep editing"), style: "cancel" },
      { text: t("Discard"), style: "destructive", onPress: stopEditing },
    ]);
  };
  const save = async () => {
    if (busy || !dirty || draftError || !draft?.trim()) return;
    setBusy(true);
    setFailed(null);
    const settle = write();
    try {
      const saved = await rpc<AgentSkill>("agentSkills/update", { skillId, content: draft });
      setSkillId(saved.id);
      settle(() => ({ kind: "ready", value: saved }));
      stopEditing();
    } catch (error) {
      setFailed(serverMessage(error) || t("Could not save skill"));
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    presentMessageActionSheet({
      actions: [
        {
          text: t("Delete"),
          destructive: true,
          onPress: () => {
            rpc("agentSkills/remove", { skillId }).then(
              () => router.back(),
              (error: unknown) => Alert.alert(serverMessage(error) || t("Could not delete skill")),
            );
          },
        },
      ],
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });

  const writable = skill !== null && !skill.readOnly;
  return (
    <>
      <Stack.Screen
        options={{
          title: skill?.name ?? "",
          // Every key is set in both modes: options merge, so a key left out keeps the
          // editing value and the screen would stay without a way back.
          headerBackVisible: !editing,
          gestureEnabled: !editing,
          unstable_headerLeftItems: editing
            ? () => [
                {
                  type: "button",
                  label: t("Cancel"),
                  variant: "plain",
                  disabled: busy,
                  onPress: cancel,
                },
              ]
            : undefined,
          unstable_headerRightItems: editing
            ? () => [
                {
                  type: "button",
                  label: busy ? t("Saving…") : t("Save"),
                  variant: "done",
                  disabled: busy || !dirty || Boolean(draftError) || !draft?.trim(),
                  onPress: () => void save(),
                },
              ]
            : undefined,
          headerRight: editing
            ? undefined
            : () =>
                writable ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("More")}
                    hitSlop={10}
                    onPress={remove}
                  >
                    <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
                  </Pressable>
                ) : null,
        }}
      />
      {read.kind === "failed" ? (
        <LoadFailed onRetry={retry} />
      ) : skill ? (
        <ScrollView
          style={styles.screen}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          {failed ? <Text style={styles.error}>{failed}</Text> : null}
          <TextInput
            accessibilityLabel={skill.name}
            value={draft ?? content ?? ""}
            onChangeText={setDraft}
            onFocus={() => setDraft((current) => current ?? content ?? "")}
            editable={writable && !busy}
            multiline
            scrollEnabled={false}
            textAlignVertical="top"
            placeholderTextColor={tokens.mutedForeground}
            style={styles.field}
          />
          {draftError ? (
            <Text style={styles.error} accessibilityRole="alert">
              {draftError}
            </Text>
          ) : null}
        </ScrollView>
      ) : null}
    </>
  );
}

function createSkillStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingBottom: 48, gap: 12 },
    error: { color: tokens.destructive, ...nativeTextStyle("meta", { size: 14 }) },
    field: {
      paddingHorizontal: 4,
      paddingTop: 16,
      color: tokens.foreground,
      ...nativeTextStyle("body", { size: 16, leading: 1.5 }),
    },
  });
}
