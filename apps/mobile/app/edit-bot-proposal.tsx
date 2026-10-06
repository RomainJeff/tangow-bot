import { BOT_NAME_MAX_LENGTH, SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { spawnBotEdits, spawnBotReadOnlyDetail } from "@rakazo/core";
import { radii } from "@rakazo/ui-tokens";
import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import type { SpawnBotEditTarget } from "../lib/spawn-bot-edit";
import {
  closeSpawnBotEdit,
  spawnBotEditTarget,
  subscribeSpawnBotEdit,
} from "../lib/spawn-bot-edit";

// Presented as a formSheet from a pending "Create bot" card. Its content comes from the
// in-memory registry, never from route params: a deep link to this route has nothing to show
// and the sheet closes itself.
export default function EditBotProposal() {
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const target = useSyncExternalStore(subscribeSpawnBotEdit, spawnBotEditTarget);
  const shown = useRef<SpawnBotEditTarget | null>(target);
  if (target) shown.current = target;
  const proposal = shown.current;
  const [name, setName] = useState(proposal?.spawnBot.name ?? "");
  const [instructions, setInstructions] = useState(proposal?.spawnBot.instructions ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const closing = useRef(false);
  const mounted = useRef(true);
  const messageId = useRef(proposal?.messageId);

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
        if (!mounted.current && messageId.current) closeSpawnBotEdit(messageId.current);
      }, 0);
    };
  }, []);
  // No content (opened by a link), or the card was answered elsewhere, or a conflict.
  useEffect(() => {
    if (!target) close();
  });

  const ready = name.trim().length > 0;
  const readOnly = proposal ? spawnBotReadOnlyDetail(proposal.spawnBot) : undefined;

  async function save() {
    if (!proposal || !ready || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await proposal.submit(spawnBotEdits(proposal.spawnBot, { name, instructions }));
      if (mounted.current) close();
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : t("Could not create bot"));
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const fieldStyle = {
    marginTop: 8,
    backgroundColor: tokens.muted,
    borderRadius: radii.row,
    padding: 16,
    color: tokens.foreground,
  };

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen
        options={{
          headerBackVisible: false,
          // Android / older iOS: plain text Cancel like Change password.
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Cancel")}
              hitSlop={8}
              onPress={close}
              style={styles.cancel}
            >
              <Text style={styles.cancelLabel}>{t("Cancel")}</Text>
            </Pressable>
          ),
          // iOS formSheet wraps custom headerLeft in a filled bar button; use a
          // native plain item and hide the shared liquid-glass background.
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: t("Cancel"),
              variant: "plain",
              hidesSharedBackground: true,
              onPress: close,
            },
          ],
          // The decision lives in the nav bar, like Save in bot settings: it stays reachable
          // above the keyboard however far the instructions scroll.
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Create bot")}
              disabled={pending || !ready}
              hitSlop={8}
              onPress={() => void save()}
              style={{ paddingVertical: 4, opacity: pending || !ready ? 0.4 : 1 }}
            >
              <Text style={styles.createLabel}>{pending ? t("Sending…") : t("Create bot")}</Text>
            </Pressable>
          ),
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: pending ? t("Sending…") : t("Create bot"),
              variant: "prominent",
              disabled: pending || !ready,
              onPress: () => void save(),
            },
          ],
        }}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? undefined : "height"}
        style={styles.screen}
      >
        {/* Automatic insets start the form below the sheet's header and keep the caret above
            the keyboard on iOS. */}
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.content}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
          <TextInput
            accessibilityLabel={t("Name")}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            onChangeText={setName}
            editable={!pending}
            autoCorrect={false}
            returnKeyType="done"
            placeholderTextColor={tokens.mutedForeground}
            style={fieldStyle}
          />
          <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
            {t("Instructions")}
          </Text>
          <TextInput
            accessibilityLabel={t("Instructions")}
            value={instructions}
            maxLength={SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH}
            onChangeText={setInstructions}
            editable={!pending}
            multiline
            placeholderTextColor={tokens.mutedForeground}
            style={{ ...fieldStyle, minHeight: 180, textAlignVertical: "top" }}
          />
          {readOnly ? (
            <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
              {readOnly}
            </Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 12 },
    cancel: {
      backgroundColor: "transparent",
      paddingEnd: 20,
      paddingVertical: 8,
      justifyContent: "center",
    },
    cancelLabel: { color: native.label, fontSize: 17 },
    error: { color: tokens.destructive, fontSize: 14 },
    createLabel: { color: tokens.primary, fontSize: 16, fontWeight: "600" },
  });
}
