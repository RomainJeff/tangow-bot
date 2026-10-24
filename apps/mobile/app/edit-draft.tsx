import { ASK_DRAFT_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import { draftAddresses } from "@rakazo/core";
import { radii } from "@rakazo/ui-tokens";
import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppLogo } from "../components/draft-card";
import { mobileTokens } from "../lib/appearance";
import type { DraftEditTarget } from "../lib/draft-edit";
import {
  closeDraftEdit,
  draftEdit,
  draftEditTarget,
  keepDraftEdit,
  subscribeDraftEdit,
} from "../lib/draft-edit";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

// Presented as a formSheet from a waiting mail draft card. The text goes back to the card as it
// is typed; the card sends it. Its content comes from the in-memory registry, never from route
// params: a deep link to this route has nothing to show and the sheet closes itself.
export default function EditDraft() {
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const target = useSyncExternalStore(subscribeDraftEdit, draftEditTarget);
  const shown = useRef<DraftEditTarget | null>(target);
  if (target) shown.current = target;
  const subject = shown.current;
  const [opening] = useState(() =>
    subject ? (draftEdit(subject.messageId) ?? subject.draft.body) : "",
  );
  const [text, setText] = useState(opening);
  const closing = useRef(false);
  const mounted = useRef(true);
  const messageId = useRef(subject?.messageId);

  function close() {
    if (closing.current) return;
    closing.current = true;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Deferred so a development remount does not drop the content it is about to read.
      setTimeout(() => {
        if (!mounted.current && messageId.current) closeDraftEdit(messageId.current);
      }, 0);
    };
  }, []);
  // No content (opened by a link), or the card stopped waiting on the person.
  useEffect(() => {
    if (!target) close();
  });

  function change(next: string) {
    setText(next);
    if (subject) keepDraftEdit(subject.messageId, next);
  }

  function cancel() {
    if (text === opening) return close();
    Alert.alert(t("Discard changes?"), undefined, [
      { text: t("Keep editing"), style: "cancel" },
      {
        text: t("Discard"),
        style: "destructive",
        onPress: () => {
          if (subject) keepDraftEdit(subject.messageId, opening);
          close();
        },
      },
    ]);
  }

  const to = subject ? draftAddresses(subject.draft, "to") : "";

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen
        options={{
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={cancel}>
              <Text style={styles.headerLabel}>{t("Cancel")}</Text>
            </Pressable>
          ),
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: t("Cancel"),
              icon: { type: "sfSymbol", name: "xmark" },
              variant: "plain",
              onPress: cancel,
            },
          ],
          headerRight: () => (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={close}>
              <Text style={[styles.headerLabel, styles.done]}>{t("Done")}</Text>
            </Pressable>
          ),
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: t("Done"),
              icon: { type: "sfSymbol", name: "checkmark" },
              variant: "prominent",
              tintColor: tokens.primary,
              onPress: close,
            },
          ],
        }}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
      >
        {subject ? (
          <View style={styles.to}>
            <AppLogo app={subject.draft.app} />
            <Text style={styles.toText}>
              <Text style={styles.toLabel}>{t("To")}</Text> {to}
            </Text>
          </View>
        ) : null}
        <TextInput
          accessibilityLabel={t("Edit message")}
          value={text}
          onChangeText={change}
          maxLength={ASK_DRAFT_TEXT_MAX_LENGTH}
          multiline
          autoFocus
          scrollEnabled={false}
          placeholderTextColor={tokens.mutedForeground}
          style={styles.field}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 12 },
    to: { flexDirection: "row", alignItems: "center", gap: 8 },
    toText: { flexShrink: 1, color: tokens.foreground, ...nativeTextStyle("question") },
    toLabel: { color: tokens.mutedForeground, fontWeight: "400" },
    field: {
      minHeight: 180,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderRadius: radii.card,
      backgroundColor: tokens.well,
      color: tokens.foreground,
      textAlignVertical: "top",
      ...nativeTextStyle("composer"),
    },
    headerLabel: { color: native.label, ...nativeTextStyle("composer") },
    done: { fontWeight: "600" },
  });
}
