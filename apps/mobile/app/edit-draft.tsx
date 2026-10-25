import type { AskDraftEdits } from "@rakazo/contracts";
import { ASK_DRAFT_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import type { RecipientRole } from "@rakazo/core";
import { draftAddresses, RECIPIENT_ROLES } from "@rakazo/core";
import { radii } from "@rakazo/ui-tokens";
import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppLogo } from "../components/draft-card";
import { MoreRecipientsRow, RecipientRow, SubjectRow } from "../components/draft-lines";
import { mobileTokens } from "../lib/appearance";
import type { DraftEditTarget } from "../lib/draft-edit";
import {
  closeDraftEdit,
  draftEdit,
  draftEditTarget,
  keepDraftEdit,
  subscribeDraftEdit,
} from "../lib/draft-edit";
import type { TypedLines } from "../lib/draft-sheet";
import { addressesOf, finishLines, foldedRoles, withRole } from "../lib/draft-sheet";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

// Presented as a formSheet from a waiting mail draft card. What is typed goes back to the card as
// it changes; the card sends it. Its content comes from the in-memory registry, never from route
// params: a deep link to this route has nothing to show and the sheet closes itself.
export default function EditDraft() {
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const target = useSyncExternalStore(subscribeDraftEdit, draftEditTarget);
  const shown = useRef<DraftEditTarget | null>(target);
  if (target) shown.current = target;
  const card = shown.current;
  const [opening] = useState<AskDraftEdits>(() => (card ? (draftEdit(card.messageId) ?? {}) : {}));
  const [edit, setEdit] = useState(opening);
  const [typed, setTyped] = useState<TypedLines>({});
  const [opened, setOpened] = useState<ReadonlySet<RecipientRole>>(new Set());
  const closing = useRef(false);
  const mounted = useRef(true);
  const messageId = useRef(card?.messageId);

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

  if (!card) return null;
  const { draft } = card;
  // Recipients and subject change only on a draft that records where they sit.
  const fields = draft.fields;
  const text = edit.text ?? draft.body;
  const recipients = edit.recipients ?? draft.recipients;
  const subject = edit.subject ?? draft.subject ?? "";
  const folded = fields ? foldedRoles(fields, recipients, typed, opened) : [];
  const roleLabel = { to: t("To"), cc: t("Cc"), bcc: t("Bcc") };

  function keep(next: AskDraftEdits) {
    if (!card) return;
    const merged = { ...edit, ...next };
    setEdit(merged);
    keepDraftEdit(card.messageId, merged);
  }

  function done() {
    if (!fields) return close();
    const finished = finishLines(fields, recipients, typed);
    if (finished.recipients.length !== recipients.length) keep({ recipients: finished.recipients });
    setTyped(finished.typed);
    if (!finished.held) close();
  }

  function cancel() {
    const changed =
      JSON.stringify(edit) !== JSON.stringify(opening) || Object.values(typed).some(Boolean);
    if (!changed) return close();
    Alert.alert(t("Discard changes?"), undefined, [
      { text: t("Keep editing"), style: "cancel" },
      {
        text: t("Discard"),
        style: "destructive",
        onPress: () => {
          if (card) keepDraftEdit(card.messageId, opening);
          close();
        },
      },
    ]);
  }

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
            <Pressable accessibilityRole="button" hitSlop={8} onPress={done}>
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
              onPress: done,
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
        {fields ? (
          <View>
            {RECIPIENT_ROLES.map((role) => {
              const room = fields[role];
              if (room === undefined || folded.includes(role)) return null;
              return (
                <RecipientRow
                  key={role}
                  label={roleLabel[role]}
                  addresses={addressesOf(recipients, role)}
                  typed={typed[role] ?? ""}
                  room={room}
                  autoFocus={opened.has(role) && role === [...opened][0]}
                  onChange={(next) => keep({ recipients: withRole(recipients, role, next) })}
                  onTyped={(next) => setTyped((current) => ({ ...current, [role]: next }))}
                />
              );
            })}
            {folded.length ? (
              <MoreRecipientsRow
                label={folded.map((role) => roleLabel[role]).join("/")}
                onPress={() => setOpened(new Set([...opened, ...folded]))}
              />
            ) : null}
            {fields.subject ? (
              <SubjectRow
                label={t("Subject")}
                subject={subject}
                onChange={(next) => keep({ subject: next })}
              />
            ) : null}
          </View>
        ) : (
          <View style={styles.to}>
            <AppLogo app={draft.app} />
            <Text style={styles.toText}>
              <Text style={styles.toLabel}>{t("To")}</Text> {draftAddresses(draft, "to")}
            </Text>
          </View>
        )}
        <TextInput
          accessibilityLabel={t("Edit message")}
          value={text}
          onChangeText={(next) => keep({ text: next })}
          maxLength={ASK_DRAFT_TEXT_MAX_LENGTH}
          multiline
          autoFocus={!fields}
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
